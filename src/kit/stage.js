// The 3D stage of the construction kit: shows the plant, and lets you build it.
//   build mode   pick from the palette and click to place · click to select, drag to move ·
//                R rotate · Del delete · elements snap to the stud grid and stack on bricks
//   operate mode click buttons and switches (also in first-person view)
// The document is only changed through commit(), so every action can be undone.
import * as THREE from 'three';
import { World } from '../three/world.js';
import { label, brick, COLORS } from '../three/bricks.js';
import { KIT, sizeOf, heightOf } from './elements.js';
import { footprint } from './sim.js';
import { placement, snapToGrid, makeElement, allocateIO, nextKitName, sid, ioList } from './model.js';
import { buildElementMesh, updateElementMesh, meshSignature, buildItemMesh, updateItemMesh } from './meshes.js';
import { instantiateGroup } from './catalog.js';

const OK = 0x2bd96b;
const BAD = 0xff3b30;
const LIMIT = 30;

export class Stage {
  constructor(host, { doc, getSim, theme, onChange, onSelect, onStatus }) {
    this.host = host;
    this.doc = doc;
    this.getSim = getSim;
    this.cb = { onChange, onSelect, onStatus };
    this.world = new World(host, { theme });
    this.scene = this.world.scene;
    this.built = new Map(); // element id → {group, h, sig, kind}
    this.itemMeshes = new Map();
    this.sel = new Set();
    this.mode = 'build';
    this.tool = null; // {type} | {group} while placing
    this.ghost = null;
    this.ghostRot = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.showNames = true;
    this.showWiring = false;
    this.ray = new THREE.Raycaster();
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.overlay = new THREE.Group();
    this.scene.add(this.overlay);
    this.wiring = new THREE.Group();
    this.scene.add(this.wiring);
    this._rack();
    this._saved = this._snapshot();
    this._savedProgram = JSON.stringify(doc.program);
    this.sync();
    this._bind();
    this.world.onUpdate((dt) => this._frame(dt));
    this.world.onModeChange = (m) => { if (m === 'fps') this.setMode('operate'); else this.frame(); if (this.cb.onStatus) this.cb.onStatus(); };
    this.frame();
    this.world.start();
  }

  /** Height of an element in studs (for tools and tests). */
  height(el) { return heightOf(el); }

  /** Point the overview camera at the plant (or at the middle of an empty plate). */
  frame() {
    let x0 = -6; let x1 = 6; let z0 = -5; let z1 = 5;
    if (this.doc.elements.length) {
      x0 = z0 = Infinity; x1 = z1 = -Infinity;
      for (const el of this.doc.elements) { const r = footprint(el); x0 = Math.min(x0, r.x1); x1 = Math.max(x1, r.x2); z0 = Math.min(z0, r.z1); z1 = Math.max(z1, r.z2); }
    }
    const cx = (x0 + x1) / 2; const cz = (z0 + z1) / 2;
    const d = Math.max(14, Math.max(x1 - x0, (z1 - z0) * 1.3) * 0.85 + 8);
    this.world.orbit.target.set(cx, 1.5, cz);
    this.world.camera.position.set(cx + d * 0.45, d * 0.62, cz + d * 0.72);
    this.world.orbit.update();
  }

  // ---------------------------------------------------------------- document ↔ meshes
  /** Bring the meshes in line with the document (after any change). */
  sync() {
    const ids = new Set(this.doc.elements.map((e) => e.id));
    for (const [id, b] of this.built) if (!ids.has(id)) { this.root.remove(b.group); this.built.delete(id); }
    for (const el of this.doc.elements) {
      if (!KIT[el.type]) continue;
      const sig = meshSignature(el);
      let b = this.built.get(el.id);
      if (!b || b.sig !== sig) {
        if (b) this.root.remove(b.group);
        b = buildElementMesh(el);
        b.sig = sig;
        b.group.traverse((o) => { o.userData.elId = el.id; });
        this.root.add(b.group);
        this.built.set(el.id, b);
      }
      b.group.position.set(el.x, el.y || 0, el.z);
      b.group.rotation.y = (-(el.rot || 0) * Math.PI) / 2;
      this._decorate(el, b);
    }
    this._selectionBoxes();
    this._wiring();
  }

  _decorate(el, b) {
    // name tag and fault marker
    const want = `${this.showNames && this.mode === 'build' ? el.name : ''}|${el.fault || ''}`;
    if (b.tagSig === want) return;
    b.tagSig = want;
    if (b.tag) { b.group.remove(b.tag); b.tag = null; }
    const text = [this.showNames && this.mode === 'build' ? el.name : '', el.fault ? '⚠ fault' : ''].filter(Boolean).join('  ');
    if (!text) return;
    const t = label(text, { size: 0.42, bg: el.fault ? 'rgba(200,30,30,0.92)' : 'rgba(20,24,32,0.7)' });
    t.position.set(0, heightOf(el) + (['tank', 'elevator', 'motor', 'scale', 'setpoint', 'leveltx', 'pressure', 'temperature'].includes(KIT[el.type].base || el.type) ? 2.1 : 1.0), 0);
    t.userData.elId = el.id;
    b.group.add(t);
    b.tag = t;
  }

  _selectionBoxes() {
    this.overlay.clear();
    for (const id of this.sel) {
      const el = this.doc.elements.find((e) => e.id === id);
      if (!el) continue;
      this.overlay.add(this._frameBox(el, 0x4f8dff));
    }
    if (this.ghost) for (const g of this.ghost.items) this.overlay.add(g.mesh);
  }

  _frameBox(el, color) {
    const r = footprint(el);
    const h = heightOf(el);
    const geo = new THREE.BoxGeometry(r.x2 - r.x1 + 0.15, h + 0.15, r.z2 - r.z1 + 0.15);
    const m = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color }));
    m.position.set(el.x, (el.y || 0) + h / 2, el.z);
    return m;
  }

  _rack() {
    // virtual PLC rack in a corner of the plate: every signal gets a cable to it
    const g = new THREE.Group();
    g.position.set(-27, 0, -27);
    g.add(brick(8, 2, 9, COLORS.gray));
    const cpu = brick(2, 2, 12, COLORS.blue); cpu.position.set(-3, 0, 0); g.add(cpu);
    for (let k = 0; k < 3; k++) { const m = brick(2, 2, 10, [0x2bd96b, 0xff9f1c, 0xb0b6bd][k]); m.position.set(-1 + k * 2, 0, 0); g.add(m); }
    const l = label('PLC rack', { size: 0.6 }); l.position.set(0, 6, 0); g.add(l);
    this.scene.add(g);
    this.rack = g;
  }

  _wiring() {
    this.wiring.clear();
    if (!this.showWiring) return;
    const rows = ioList(this.doc);
    rows.forEach((r, k) => {
      const el = r.el;
      const a = new THREE.Vector3(el.x, (el.y || 0) + 0.3, el.z);
      const slot = r.dir === 'in' ? (r.type === 'BOOL' ? -1 : 3) : 1;
      const b = new THREE.Vector3(-27 + slot + (k % 5) * 0.12, 3.6, -27 + 1);
      const mid1 = new THREE.Vector3(a.x, 0.12, a.z);
      const mid2 = new THREE.Vector3(b.x, 0.12, a.z);
      const mid3 = new THREE.Vector3(b.x, 0.12, b.z);
      const geo = new THREE.BufferGeometry().setFromPoints([a, mid1, mid2, mid3, b]);
      this.wiring.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: r.dir === 'in' ? (r.type === 'BOOL' ? 0x2bd96b : 0xb0b6bd) : 0xff9f1c })));
    });
  }

  // ---------------------------------------------------------------- history
  _snapshot(withProgram = false) {
    return JSON.stringify({ elements: this.doc.elements, program: withProgram ? this.doc.program : undefined });
  }

  /** Record an undo step and tell the owner. `program` = the step also changed the program (tag rename). */
  commit(reason = 'edit', { program = false } = {}) {
    const now = this._snapshot();
    if (now !== this._saved || program) {
      this.undoStack.push({ elements: this._saved, program: program ? this._savedProgram : undefined });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this._saved = now;
    }
    this._savedProgram = JSON.stringify(this.doc.program);
    this.sync();
    if (this.cb.onChange) this.cb.onChange(reason);
    this._selChanged();
  }

  /** Call before an action that may edit the program text (so undo can restore it). */
  rememberProgram() { this._savedProgram = JSON.stringify(this.doc.program); }

  _apply(entry, into) {
    into.push({ elements: this._saved, program: entry.program !== undefined ? JSON.stringify(this.doc.program) : undefined });
    this.doc.elements = JSON.parse(entry.elements).elements;
    if (entry.program !== undefined) this.doc.program = JSON.parse(entry.program);
    this._saved = this._snapshot();
    this.sel.clear();
    this.sync();
    if (this.cb.onChange) this.cb.onChange('history');
    this._selChanged();
  }

  undo() { const e = this.undoStack.pop(); if (e) this._apply(e, this.redoStack); }
  redo() { const e = this.redoStack.pop(); if (e) this._apply(e, this.undoStack); }

  // ---------------------------------------------------------------- selection & tools
  selected() { return this.doc.elements.filter((e) => this.sel.has(e.id)); }

  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this._selectionBoxes();
    this._selChanged();
  }

  _selChanged() { if (this.cb.onSelect) this.cb.onSelect(); }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'operate') { this.cancelTool(); this.sel.clear(); }
    for (const b of this.built.values()) b.tagSig = null;
    this.sync();
    this._selChanged();
  }

  /** Start placing: {type} for one element or {group: entry} for a saved group. */
  setTool(tool) {
    this.cancelTool();
    if (!tool) return;
    if (this.mode !== 'build') this.setMode('build');
    if (this.world.mode === 'fps') this.world.setMode('overview');
    this.tool = tool;
    this.ghostRot = 0;
    this._makeGhost();
    this._selChanged();
  }

  cancelTool() {
    this.tool = null;
    this.ghost = null;
    this._selectionBoxes();
    this._selChanged();
  }

  _makeGhost(at = [0, 0]) {
    const els = this.tool.group ? instantiateGroup(this.doc, this.tool.group, 0, 0, this.ghostRot) : [makeElement(this.doc, this.tool.type, 0, 0, this.ghostRot)];
    const items = els.map((el) => {
      const [w, d] = sizeOf(el);
      const odd = (el.rot || 0) % 2 === 1;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry((odd ? d : w) - 0.05, heightOf(el), (odd ? w : d) - 0.05), new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.45, depthWrite: false }));
      return { el, mesh, dx: el.x, dz: el.z };
    });
    this.ghost = { items, ok: false, at };
    this._moveGhost(at[0], at[1]);
    this._selectionBoxes();
  }

  _moveGhost(x, z) {
    const g = this.ghost;
    g.at = [x, z];
    let ok = true;
    const scratch = { elements: [...this.doc.elements] };
    const cx = Math.round(x); const cz = Math.round(z);
    for (const it of g.items) {
      const el = it.el;
      [el.x, el.z] = g.items.length === 1 ? snapToGrid(el, x, z) : snapToGrid(el, cx + it.dx, cz + it.dz);
      const p = placement(scratch, el, LIMIT);
      el.y = this.tool.group ? Math.max(p.y, 0) : p.y;
      if (!p.ok) ok = false;
      scratch.elements.push(el);
      it.mesh.position.set(el.x, el.y + heightOf(el) / 2, el.z);
    }
    g.ok = ok;
    for (const it of g.items) it.mesh.material.color.set(ok ? OK : BAD);
  }

  _place() {
    const g = this.ghost;
    if (!g || !g.ok) { if (this.cb.onStatus) this.cb.onStatus('That spot is taken or outside the baseplate.'); return; }
    const added = [];
    for (const it of g.items) {
      const el = it.el;
      el.id = sid('e');
      el.name = nextKitName(this.doc, el.type);
      this.doc.elements.push(el);
      added.push(el.id);
    }
    allocateIO(this.doc);
    this.sel = new Set(added);
    this.commit('place');
    this._makeGhost(g.at); // keep placing until Esc
  }

  rotate() {
    if (this.ghost) { this.ghostRot = (this.ghostRot + 1) % 4; this._makeGhost(this.ghost.at); return; }
    const els = this.selected();
    if (!els.length) return;
    const before = els.map((e) => ({ e, x: e.x, z: e.z, rot: e.rot, y: e.y }));
    if (els.length === 1) { els[0].rot = ((els[0].rot || 0) + 1) % 4; [els[0].x, els[0].z] = snapToGrid(els[0], els[0].x, els[0].z); }
    else {
      const cx = Math.round(els.reduce((s, e) => s + e.x, 0) / els.length); const cz = Math.round(els.reduce((s, e) => s + e.z, 0) / els.length);
      for (const e of els) { const dx = e.x - cx; const dz = e.z - cz; e.rot = ((e.rot || 0) + 1) % 4; [e.x, e.z] = snapToGrid(e, cx - dz, cz + dx); }
    }
    if (!this._settle(els)) { for (const b of before) Object.assign(b.e, { x: b.x, z: b.z, rot: b.rot, y: b.y }); if (this.cb.onStatus) this.cb.onStatus('No room to rotate here.'); this.sync(); return; }
    this.commit('rotate');
  }

  /** Check that the given elements can stand where they are (ignoring each other's old places) and set their height. */
  _settle(els) {
    const ids = new Set(els.map((e) => e.id));
    const scratch = { elements: this.doc.elements.filter((e) => !ids.has(e.id)) };
    for (const e of els) {
      const p = placement(scratch, e, LIMIT);
      if (!p.ok) return false;
      e.y = p.y;
      scratch.elements.push(e);
    }
    return true;
  }

  remove() {
    if (!this.sel.size) return;
    // what stood on a removed brick comes down with the next move; keep it simple and explicit:
    this.doc.elements = this.doc.elements.filter((e) => !this.sel.has(e.id));
    for (const e of this.doc.elements) { if (e.y > 0) { const p = placement({ elements: this.doc.elements }, e, LIMIT); if (p.ok) e.y = p.y; } }
    this.sel.clear();
    this.commit('delete');
  }

  duplicate() {
    const els = this.selected();
    if (!els.length) return;
    const copies = [];
    for (const off of [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]]) {
      copies.length = 0;
      const scratch = { elements: [...this.doc.elements] };
      const span = els.reduce((m, e) => { const r = footprint(e); return Math.max(m, r.x2 - r.x1, r.z2 - r.z1); }, 0) + 1;
      let ok = true;
      for (const e of els) {
        const c = { ...JSON.parse(JSON.stringify(e)), id: sid('e'), name: nextKitName(scratch, e.type), io: {}, x: e.x + off[0] * span, z: e.z + off[2] * span };
        const p = placement(scratch, c, LIMIT);
        if (!p.ok) { ok = false; break; }
        c.y = p.y;
        scratch.elements.push(c);
        copies.push(c);
      }
      if (ok) break;
    }
    if (!copies.length) { if (this.cb.onStatus) this.cb.onStatus('No free space next to the selection for a copy.'); return; }
    this.doc.elements.push(...copies);
    allocateIO(this.doc);
    this.sel = new Set(copies.map((c) => c.id));
    this.commit('duplicate');
  }

  // ---------------------------------------------------------------- pointer
  _ndc(e) {
    const r = this.world.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _pickElement(e) {
    const locked = document.pointerLockElement === this.world.renderer.domElement;
    this.ray.setFromCamera(locked ? new THREE.Vector2(0, 0) : this._ndc(e), this.world.camera);
    const hits = this.ray.intersectObjects(this.root.children, true);
    for (const h of hits) {
      const id = h.object.userData.elId;
      if (id) return this.doc.elements.find((x) => x.id === id) || null;
    }
    return null;
  }

  _groundPoint(e, y = 0) {
    this.ray.setFromCamera(this._ndc(e), this.world.camera);
    this.ground.constant = -y;
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.ground, p) ? p : null;
  }

  /** Where the pointer touches the plant: on top of an element if there is one under it, else on the baseplate. */
  _surfacePoint(e) {
    this.ray.setFromCamera(this._ndc(e), this.world.camera);
    const hit = this.ray.intersectObjects(this.root.children, true).find((h) => h.object.userData.elId);
    // only bricks can carry something, so only they catch the pointer
    const el = hit && this.doc.elements.find((x) => x.id === hit.object.userData.elId);
    return el && KIT[el.type].stackable ? hit.point : this._groundPoint(e);
  }

  _bind() {
    const dom = this.world.renderer.domElement;
    this._listeners = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); this._listeners.push([t, ev, fn, opt]); };
    let drag = null;
    let pressed = null;
    let pressedAt = 0;
    on(dom, 'pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.mode === 'operate' || this.world.mode === 'fps') {
        const el = this._pickElement(e);
        if (el && KIT[el.type].operate) { this.getSim().operate(el, 'down'); pressed = el; pressedAt = performance.now(); this.world.orbit.enabled = false; }
        return;
      }
      if (this.ghost) { this._place(); return; }
      const el = this._pickElement(e);
      if (!el) { drag = { empty: true, x: e.clientX, y: e.clientY }; return; }
      if (e.shiftKey) { if (this.sel.has(el.id)) this.sel.delete(el.id); else this.sel.add(el.id); this._selectionBoxes(); this._selChanged(); return; }
      if (!this.sel.has(el.id)) this.select([el.id]);
      const p = this._groundPoint(e);
      if (!p) return;
      this.world.orbit.enabled = false;
      drag = { start: p, moved: false, orig: this.selected().map((x) => ({ e: x, x: x.x, z: x.z, y: x.y })) };
    });
    on(dom, 'pointermove', (e) => {
      if (this.ghost) { const p = this._surfacePoint(e); if (p) this._moveGhost(p.x, p.z); return; }
      if (!drag || drag.empty) { this._hover(e); return; }
      const p = this._groundPoint(e);
      if (!p) return;
      const dx = Math.round(p.x - drag.start.x); const dz = Math.round(p.z - drag.start.z);
      if (!drag.moved && dx === 0 && dz === 0) return;
      drag.moved = true;
      for (const o of drag.orig) { o.e.x = o.x + dx; o.e.z = o.z + dz; }
      drag.ok = this._settle(drag.orig.map((o) => o.e));
      this.sync();
      for (const m of this.overlay.children) if (m.material) m.material.color.set(drag.ok ? 0x4f8dff : BAD);
    });
    on(window, 'pointerup', (e) => {
      if (pressed) {
        // a quick click still holds the button long enough for a few PLC scans
        const el = pressed; const wait = Math.max(0, 180 - (performance.now() - pressedAt));
        pressed = null;
        setTimeout(() => { if (this.doc.elements.includes(el)) this.getSim().operate(el, 'up'); }, wait);
        this.world.orbit.enabled = this.world.mode === 'overview';
      }
      if (!drag) return;
      const d = drag;
      drag = null;
      this.world.orbit.enabled = this.world.mode === 'overview';
      if (d.empty) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4 && this.sel.size) this.select([]); return; }
      if (!d.moved) return;
      if (!d.ok) { for (const o of d.orig) Object.assign(o.e, { x: o.x, z: o.z, y: o.y }); if (this.cb.onStatus) this.cb.onStatus('Cannot move there: the space is taken.'); this.sync(); return; }
      this.commit('move');
    });
    on(dom, 'contextmenu', (e) => { if (this.ghost) { e.preventDefault(); this.cancelTool(); } });
  }

  _hover(e) {
    const el = this._pickElement(e);
    const dom = this.world.renderer.domElement;
    const operable = el && KIT[el.type].operate && (this.mode === 'operate' || this.world.mode === 'fps');
    dom.style.cursor = operable ? 'pointer' : el && this.mode === 'build' ? 'move' : '';
    if (this.hoverEl !== el) { this.hoverEl = el; if (this.cb.onStatus) this.cb.onStatus(); }
  }

  // ---------------------------------------------------------------- per frame
  _frame() {
    const sim = this.getSim();
    if (!sim) return;
    for (const el of this.doc.elements) {
      const b = this.built.get(el.id);
      if (b) updateElementMesh(el, sim.st[el.id], b, sim);
    }
    const seen = new Set();
    for (const it of sim.items) {
      seen.add(it.id);
      let m = this.itemMeshes.get(it.id);
      if (!m) { m = buildItemMesh(it); this.scene.add(m); this.itemMeshes.set(it.id, m); }
      updateItemMesh(it, m);
    }
    for (const [id, m] of this.itemMeshes) if (!seen.has(id)) { this.scene.remove(m); this.itemMeshes.delete(id); }
  }

  snapshot() {
    this._frame();
    this.world.renderer.render(this.scene, this.world.camera);
    const c = this.world.renderer.domElement;
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
  }

  destroy() {
    for (const [t, ev, fn, opt] of this._listeners) t.removeEventListener(ev, fn, opt);
    this.world.dispose();
  }
}
