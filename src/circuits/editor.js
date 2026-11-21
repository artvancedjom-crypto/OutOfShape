// Interactive schematic editor (SVG): place / move / rotate / mirror / delete parts,
// draw and reshape wires, net labels, probes, box selection, clipboard, zoom & pan,
// undo / redo. Simulation results are only read here (hover values, glowing parts,
// error highlights); the solver lives in sim.js / mna.js.
import { PARTS, U, pinPositions, partBBox, toWorld } from './parts.js';
import { makePart, nid, nearestOnSegment, routeOrtho, simplifyPath, samePt, nextName } from './model.js';
import { formatSI } from './units.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const PROBE_COLORS = ['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5', '#00bbf9', '#f15bb5', '#8ac926', '#ffca3a'];
export const probeColor = (doc, p) => PROBE_COLORS[Math.max(0, doc.probes.indexOf(p)) % PROBE_COLORS.length];

/** Blue (lowest) → grey → red (highest voltage). */
export function potentialColor(v, lo, hi) {
  if (hi - lo < 1e-9) return '#8a94a6';
  const t = (v - lo) / (hi - lo);
  const mix = (a, b, k) => Math.round(a + (b - a) * k);
  const [c1, c2, k] = t < 0.5 ? [[43, 108, 255], [138, 148, 166], t * 2] : [[138, 148, 166], [255, 59, 48], (t - 0.5) * 2];
  return `rgb(${mix(c1[0], c2[0], k)},${mix(c1[1], c2[1], k)},${mix(c1[2], c2[2], k)})`;
}

let clipboard = null; // shared between editor instances in this window

export class CircuitEditor {
  constructor(host, { doc, sim, onChange, onSelect, onStatus, onEditPart, onLive }) {
    this.host = host;
    this.sim = sim;
    this.cb = { onChange, onSelect, onStatus, onEditPart, onLive };
    this.sel = new Set();
    this.tool = 'select';
    this.autoRoute = false;
    this.zoom = 1;
    this.pan = [40, 40];
    this.mode = null; // active drag / drawing state
    this.mouse = [0, 0];
    this.visualKeys = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.overlay = { potential: false, power: false };

    host.classList.add('ce-host');
    this.svg = svgEl('svg', { class: 'ce-svg', tabindex: 0 }, host);
    this.world = svgEl('g', {}, this.svg);
    this.layers = {};
    for (const name of ['heat', 'halo', 'wires', 'junctions', 'parts', 'labels', 'probes', 'overlay']) this.layers[name] = svgEl('g', { class: 'ce-' + name }, this.world);
    this.tip = document.createElement('div');
    this.tip.className = 'ce-tip';
    host.append(this.tip);

    this._bind();
    this.ready = false; // callbacks stay quiet until the owner holds the instance
    this.setDoc(doc, { resetHistory: true, fit: true });
    this.ready = true;
  }

  // ---------------------------------------------------------------- document
  setDoc(doc, { resetHistory = false, fit = false } = {}) {
    this.doc = doc;
    this.sel.clear();
    this.mode = null;
    if (resetHistory) { this.undoStack = []; this.redoStack = []; this._saved = this._snapshot(); }
    this.sim.rebuild(doc);
    this.renderAll();
    if (fit) requestAnimationFrame(() => this.fit());
    this._selChanged();
  }

  _snapshot() {
    const { parts, wires, labels, probes, name } = this.doc;
    return JSON.stringify({ parts, wires, labels, probes, name });
  }

  _restore(json) {
    Object.assign(this.doc, JSON.parse(json));
    this.sel.clear();
    this.mode = null;
    this.sim.rebuild(this.doc);
    this.renderAll();
    this._selChanged();
    if (this.cb.onChange) this.cb.onChange(this.doc, 'history');
  }

  /** Record an undo step (if anything changed), re-simulate and notify. */
  commit(reason = 'edit') {
    const now = this._snapshot();
    if (now !== this._saved) {
      this.undoStack.push(this._saved);
      if (this.undoStack.length > 300) this.undoStack.shift();
      this.redoStack = [];
      this._saved = now;
      this.sim.rebuild(this.doc);
      if (this.cb.onChange) this.cb.onChange(this.doc, reason);
    }
    this.renderAll();
    this._selChanged();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._saved);
    this._saved = this.undoStack.pop();
    this._restore(this._saved);
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._saved);
    this._saved = this.redoStack.pop();
    this._restore(this._saved);
  }

  // ---------------------------------------------------------------- lookup helpers
  item(id) {
    const d = this.doc;
    let o = d.parts.find((x) => x.id === id);
    if (o) return { kind: 'part', o };
    o = d.wires.find((x) => x.id === id);
    if (o) return { kind: 'wire', o };
    o = d.labels.find((x) => x.id === id);
    if (o) return { kind: 'label', o };
    o = d.probes.find((x) => x.id === id);
    if (o) return { kind: 'probe', o };
    return null;
  }

  selected(kind) {
    return [...this.sel].map((id) => this.item(id)).filter((x) => x && (!kind || x.kind === kind)).map((x) => x.o);
  }

  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) this.sel.add(id);
    this.renderAll();
    this._selChanged();
  }

  _selChanged() {
    if (this.ready && this.cb.onSelect) this.cb.onSelect(this);
  }

  status(text) {
    if (this.cb.onStatus) this.cb.onStatus(text || '');
  }

  // ---------------------------------------------------------------- coordinates
  toWorldPt(e) {
    const r = this.svg.getBoundingClientRect();
    return [(e.clientX - r.left - this.pan[0]) / (U * this.zoom), (e.clientY - r.top - this.pan[1]) / (U * this.zoom)];
  }

  snap(v, free) {
    return free ? Math.round(v * 20) / 20 : Math.round(v);
  }

  _applyView() {
    this.world.setAttribute('transform', `translate(${this.pan[0]},${this.pan[1]}) scale(${this.zoom})`);
    const g = U * this.zoom;
    this.host.style.backgroundSize = `${g}px ${g}px`;
    this.host.style.backgroundPosition = `${this.pan[0] - g / 2}px ${this.pan[1] - g / 2}px`;
    if (this.ready && this.cb.onLive) this.cb.onLive('view');
  }

  zoomAt(factor, cx, cy) {
    const z = Math.max(0.2, Math.min(5, this.zoom * factor));
    const r = this.svg.getBoundingClientRect();
    cx = cx ?? r.width / 2;
    cy = cy ?? r.height / 2;
    this.pan = [cx - ((cx - this.pan[0]) * z) / this.zoom, cy - ((cy - this.pan[1]) * z) / this.zoom];
    this.zoom = z;
    this._applyView();
  }

  bounds() {
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    const add = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
    for (const p of this.doc.parts) { const b = partBBox(p); add(b.x1, b.y1); add(b.x2, b.y2); }
    for (const w of this.doc.wires) for (const pt of w.pts) add(pt[0], pt[1]);
    for (const l of this.doc.labels) add(l.x, l.y);
    return x1 === Infinity ? { x1: 0, y1: 0, x2: 24, y2: 14 } : { x1, y1, x2, y2 };
  }

  fit() {
    const r = this.svg.getBoundingClientRect();
    if (!r.width) return;
    const b = this.bounds();
    const w = (b.x2 - b.x1 + 6) * U;
    const h = (b.y2 - b.y1 + 6) * U;
    this.zoom = Math.max(0.2, Math.min(2.2, Math.min(r.width / w, r.height / h)));
    this.pan = [(r.width - (b.x1 + b.x2) * U * this.zoom) / 2, (r.height - (b.y1 + b.y2) * U * this.zoom) / 2];
    this._applyView();
  }

  // ---------------------------------------------------------------- hit testing
  hit(x, y) {
    const d = this.doc;
    const tol = 0.4 / Math.max(0.6, this.zoom);
    for (const p of d.probes) {
      if (p.kind === 'A') continue;
      if (Math.hypot(p.at[0] - x, p.at[1] - y) < tol || (p.ref && Math.hypot(p.ref[0] - x, p.ref[1] - y) < tol)) return { kind: 'probe', o: p };
    }
    // corner handles of selected wires
    for (const w of this.selected('wire')) {
      for (let i = 0; i < w.pts.length; i++) if (Math.hypot(w.pts[i][0] - x, w.pts[i][1] - y) < tol) return { kind: 'vertex', o: w, index: i };
    }
    for (const part of d.parts) {
      const pins = pinPositions(part);
      for (let i = 0; i < pins.length; i++) if (Math.hypot(pins[i][0] - x, pins[i][1] - y) < tol * 0.8) return { kind: 'pin', o: part, index: i, pt: pins[i] };
    }
    for (let i = d.parts.length - 1; i >= 0; i--) {
      const b = partBBox(d.parts[i]);
      if (x >= b.x1 - 0.15 && x <= b.x2 + 0.15 && y >= b.y1 - 0.15 && y <= b.y2 + 0.15) return { kind: 'part', o: d.parts[i] };
    }
    for (const l of d.labels) {
      const w = 0.5 + String(l.text).length * 0.42;
      if (x >= l.x - 0.2 && x <= l.x + w && y >= l.y - 1.3 && y <= l.y + 0.2) return { kind: 'label', o: l };
    }
    const ws = this.wireAt(x, y, tol);
    return ws ? { kind: 'wire', o: ws.wire, seg: ws.seg, pt: [ws.x, ws.y] } : null;
  }

  wireAt(x, y, tol = 0.35, except = null) {
    let best = null;
    for (const w of this.doc.wires) {
      if (w === except) continue;
      for (let i = 1; i < w.pts.length; i++) {
        const n = nearestOnSegment(x, y, w.pts[i - 1], w.pts[i]);
        if (n.d < tol && (!best || n.d < best.d)) best = { ...n, wire: w, seg: i - 1 };
      }
    }
    return best;
  }

  /** Where a wire end / probe / label would attach near (x,y): pin, wire, or grid. */
  target(x, y, free, except = null) {
    for (const part of this.doc.parts) {
      for (const pt of pinPositions(part)) if (Math.hypot(pt[0] - x, pt[1] - y) < 0.55) return { pt: [pt[0], pt[1]], on: 'pin' };
    }
    const sx = this.snap(x, free);
    const sy = this.snap(y, free);
    const w = this.wireAt(x, y, 0.45, except);
    if (w) {
      const n = nearestOnSegment(sx, sy, w.wire.pts[w.seg], w.wire.pts[w.seg + 1]);
      return { pt: [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100], on: 'wire' };
    }
    return { pt: [sx, sy], on: null };
  }

  // ---------------------------------------------------------------- rendering
  renderAll() {
    const d = this.doc;
    const L = this.layers;
    const sim = this.sim;
    const diag = sim.diagnostics || [];
    const errParts = new Map();
    const errNodes = new Map();
    for (const g of diag) {
      for (const id of g.parts || []) if (errParts.get(id) !== 'error') errParts.set(id, g.level);
      for (const n of g.nodes || []) if (errNodes.get(n) !== 'error') errNodes.set(n, g.level);
    }
    // wires
    let s = '';
    for (const w of d.wires) {
      const node = sim.net ? sim.net.nodeAt(w.pts[0][0], w.pts[0][1]) : null;
      const cls = ['ce-wire', this.sel.has(w.id) ? 'sel' : '', node != null && errNodes.has(node) ? errNodes.get(node) : ''].join(' ');
      const pts = w.pts.map((p) => `${p[0] * U},${p[1] * U}`).join(' ');
      s += `<polyline class="${cls}" data-id="${w.id}" points="${pts}"/>`;
      if (this.sel.has(w.id)) for (const p of w.pts) s += `<rect class="ce-handle" x="${p[0] * U - 4}" y="${p[1] * U - 4}" width="8" height="8"/>`;
    }
    L.wires.innerHTML = s;
    this.wireEls = [...L.wires.querySelectorAll('polyline')].map((el) => ({ el, w: d.wires.find((x) => x.id === el.dataset.id), col: '' }));
    L.heat.innerHTML = '';
    this.heatEls = new Map();
    s = '';
    for (const j of sim.net ? sim.net.junctions : []) s += `<circle class="ce-junction" cx="${j[0] * U}" cy="${j[1] * U}" r="4"/>`;
    L.junctions.innerHTML = s;
    // parts
    L.parts.innerHTML = '';
    L.halo.innerHTML = '';
    this.partEls = new Map();
    this.visualKeys.clear();
    for (const part of d.parts) {
      const def = PARTS[part.type];
      const lvl = errParts.get(part.id);
      if (lvl) {
        const b = partBBox(part);
        svgEl('rect', { class: 'ce-halo ' + lvl, x: (b.x1 - 0.4) * U, y: (b.y1 - 0.4) * U, width: (b.x2 - b.x1 + 0.8) * U, height: (b.y2 - b.y1 + 0.8) * U, rx: 8 }, L.halo);
      }
      const g = svgEl('g', { class: `ce-part ${this.sel.has(part.id) ? 'sel' : ''} ${sim.net && sim.net.excluded.has(part.id) ? 'off' : ''}`, 'data-id': part.id }, L.parts);
      const body = svgEl('g', { transform: `translate(${part.x * U},${part.y * U}) rotate(${(part.rot || 0) * 90}) scale(${part.mirror ? -1 : 1},1)` }, g);
      this.partEls.set(part.id, { g, body, part });
      this._drawSymbol(part, body, sim.partResult(part));
      // pins
      for (const [px, py] of pinPositions(part)) svgEl('circle', { class: 'ce-pin' + (sim.net && sim.net.isOpenPin(px, py) ? ' open' : ''), cx: px * U, cy: py * U, r: 3 }, g);
      // name + value (never rotated)
      const b = partBBox(part);
      const vertical = (part.rot || 0) % 2 === 1 || !!def.labelRight;
      const val = def.value ? def.value(part.params) : null;
      const texts = [part.name, val ? formatSI(val[0], val[1]) : ''].filter(Boolean);
      if (texts.length) {
        const tx = vertical ? (b.x2 + 0.5) * U : ((b.x1 + b.x2) / 2) * U;
        const ty = vertical ? ((b.y1 + b.y2) / 2) * U - (texts.length - 1) * 7 : (b.y1 - 0.3) * U - (texts.length - 1) * 14;
        texts.forEach((txt, i) => {
          const el = svgEl('text', { class: i === 0 && part.name ? 'ce-name' : 'ce-val', x: tx, y: ty + i * 14, style: `text-anchor:${vertical ? 'start' : 'middle'}` }, g);
          el.textContent = txt;
        });
      }
    }
    // labels
    s = '';
    for (const l of d.labels) {
      const w = 14 + String(l.text).length * 7.5;
      s += `<g class="ce-label ${this.sel.has(l.id) ? 'sel' : ''}" data-id="${l.id}" transform="translate(${l.x * U},${l.y * U})">`
        + `<circle r="3"/><path d="M0,0 L8,-9 L${w + 8},-9 L${w + 8},-25 L8,-25 L8,-9"/><text x="14" y="-13">${esc(l.text)}</text></g>`;
    }
    L.labels.innerHTML = s;
    this._renderProbes();
    this._renderOverlay();
    this.refreshLive(true);
  }

  _drawSymbol(part, body, live) {
    const def = PARTS[part.type];
    body.innerHTML = def.symbol(part.params, live || null)
      + (live && live.burned ? '<path d="M-9,-9 L9,9 M-9,9 L9,-9" class="burn-x"/><circle cx="0" cy="0" r="15" class="burn-mark"/>' : '');
    // keep symbol texts upright and readable
    const rot = (part.rot || 0) * 90;
    for (const t of body.querySelectorAll('text')) {
      const x = +t.getAttribute('x');
      const y = +t.getAttribute('y');
      t.setAttribute('transform', `translate(${x},${y}) scale(${part.mirror ? -1 : 1},1) rotate(${-rot}) translate(${-x},${-y})`);
    }
  }

  _renderProbes() {
    const d = this.doc;
    let s = '';
    this.probeEls = [];
    for (const p of d.probes) {
      const col = probeColor(d, p);
      const sel = this.sel.has(p.id) ? 'sel' : '';
      let x; let y;
      if (p.kind === 'A') {
        const part = d.parts.find((q) => q.id === p.part);
        if (!part) continue;
        const b = partBBox(part);
        const upright = (part.rot || 0) % 2 === 1 || !!PARTS[part.type].labelRight;
        x = upright ? (b.x1 - 0.4) * U - 68 : ((b.x1 + b.x2) / 2) * U - 34;
        y = upright ? ((b.y1 + b.y2) / 2) * U - 8 : (b.y2 + 0.4) * U;
        s += `<g class="ce-probe ${sel}" data-id="${p.id}" transform="translate(${x},${y})"><rect width="68" height="17" rx="8.5" fill="${col}"/><text x="34" y="12.5" data-probe="${p.id}"></text></g>`;
        continue;
      }
      x = p.at[0] * U;
      y = p.at[1] * U;
      if (p.ref) s += `<line class="ce-probe-link" x1="${x}" y1="${y}" x2="${p.ref[0] * U}" y2="${p.ref[1] * U}" stroke="${col}"/><circle cx="${p.ref[0] * U}" cy="${p.ref[1] * U}" r="4.5" fill="none" stroke="${col}" stroke-width="2"/>`;
      s += `<g class="ce-probe ${sel}" data-id="${p.id}" transform="translate(${x},${y})"><circle r="4.5" fill="${col}"/><path d="M0,0 L10,-12" stroke="${col}" stroke-width="2"/>`
        + `<rect x="8" y="-29" width="74" height="17" rx="8.5" fill="${col}"/><text x="45" y="-16.5" data-probe="${p.id}"></text></g>`;
    }
    this.layers.probes.innerHTML = s;
    for (const t of this.layers.probes.querySelectorAll('text[data-probe]')) this.probeEls.push({ t, p: d.probes.find((q) => q.id === t.dataset.probe) });
  }

  _renderOverlay() {
    const m = this.mode;
    let s = '';
    if (m && m.type === 'box') {
      const x = Math.min(m.a[0], m.b[0]) * U;
      const y = Math.min(m.a[1], m.b[1]) * U;
      s += `<rect class="ce-box" x="${x}" y="${y}" width="${Math.abs(m.b[0] - m.a[0]) * U}" height="${Math.abs(m.b[1] - m.a[1]) * U}"/>`;
    }
    if (m && m.type === 'wire') {
      const pts = [...m.pts, ...this._wireLeg(m.pts[m.pts.length - 1], m.cursor.pt).slice(1)];
      s += `<polyline class="ce-wire preview" points="${pts.map((p) => `${p[0] * U},${p[1] * U}`).join(' ')}"/>`;
    }
    if (m && m.type === 'probe2') s += `<line class="ce-probe-link" x1="${m.at[0] * U}" y1="${m.at[1] * U}" x2="${m.cursor.pt[0] * U}" y2="${m.cursor.pt[1] * U}" stroke="#888"/>`;
    const cur = (m && m.cursor) || this.cursorTarget;
    if (cur && ['wire', 'label', 'probeV', 'probeR'].includes(this.tool)) {
      s += `<circle class="ce-snap ${cur.on || ''}" cx="${cur.pt[0] * U}" cy="${cur.pt[1] * U}" r="${cur.on ? 7 : 4}"/>`;
    }
    if (this.tool === 'place' && this.ghost) {
      const g = this.ghost;
      s += `<g class="ce-part ghost" transform="translate(${g.x * U},${g.y * U}) rotate(${(g.rot || 0) * 90}) scale(${g.mirror ? -1 : 1},1)">${PARTS[g.type].symbol(g.params, null)}</g>`;
    }
    this.layers.overlay.innerHTML = s;
  }

  /** Per-frame update: redraw only symbols whose visual state changed, refresh probe texts. */
  refreshLive(force = false) {
    const sim = this.sim;
    const res = sim.result && sim.result.ok ? sim.result : null;
    // overload flash, burned look and optional heat tint
    for (const { g, part } of this.partEls.values()) {
      const r = res ? sim.partResult(part) : null;
      const over = !!(r && (r.overload > 1 || r.blown));
      if (g._over !== over) { g._over = over; g.classList.toggle('overload', over); }
      const burned = !!(r && r.burned);
      if (g._burned !== burned) { g._burned = burned; g.classList.toggle('burned', burned); }
      let heat = 0;
      if (this.overlay.power && r && r.p > 1e-4) heat = Math.min(8, Math.round(Math.max(0, (Math.log10(r.p) + 3.2) / 4.2) * 8)); // 1 mW … 10 W
      let he = this.heatEls.get(part.id);
      if (heat && !he) { he = svgEl('circle', { class: 'ce-heat', cx: part.x * U, cy: part.y * U }, this.layers.heat); he._h = 0; this.heatEls.set(part.id, he); }
      if (he && he._h !== heat) { he._h = heat; he.setAttribute('r', 14 + heat * 5); he.setAttribute('opacity', heat ? 0.18 + heat * 0.07 : 0); he.setAttribute('fill', heat > 5 ? '#ff2d1a' : heat > 3 ? '#ff7a1a' : '#ffb21a'); }
    }
    // wire colour by potential
    if (this.overlay.potential && res) {
      let lo = 0; let hi = 0;
      for (const k in res.nodeV) { const v = res.nodeV[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      this.potentialRange = [lo, hi];
      for (const we of this.wireEls || []) {
        const node = sim.net.nodeAt(we.w.pts[0][0], we.w.pts[0][1]);
        const v = node == null ? null : res.nodeV[node];
        const col = v == null || v === undefined ? '' : potentialColor(v, lo, hi);
        if (we.col !== col) { we.col = col; we.el.style.stroke = col; }
      }
    } else if (this.wireEls) {
      for (const we of this.wireEls) if (we.col) { we.col = ''; we.el.style.stroke = ''; }
    }
    for (const { body, part } of this.partEls.values()) {
      const def = PARTS[part.type];
      if (!def.visual && !this.sim.burned.has(part.id) && this.visualKeys.get(part.id) !== 'burned') continue;
      const r = sim.partResult(part);
      const key = r ? (r.burned ? 'burned' : def.visual ? def.visual(r) : '') : '-';
      if (force || this.visualKeys.get(part.id) !== key) {
        this.visualKeys.set(part.id, key);
        this._drawSymbol(part, body, r);
      }
    }
    for (const { t, p } of this.probeEls || []) {
      const v = sim.probeValue(p);
      t.textContent = v == null ? '—' : formatSI(v, { V: 'V', A: 'A', R: 'Ω' }[p.kind]);
    }
    if (this.hoverHit) this._showTip();
  }

  // ---------------------------------------------------------------- tools
  setTool(tool, arg) {
    this.tool = tool;
    this.mode = null;
    this.ghost = null;
    this.cursorTarget = null;
    if (tool === 'place') {
      this.ghost = { type: arg, x: Math.round(this.mouse[0]), y: Math.round(this.mouse[1]), rot: 0, mirror: false, params: Object.fromEntries(PARTS[arg].params.map((p) => [p.key, p.def])) };
      this.status(`Click to place ${PARTS[arg].name}. R rotates, X mirrors, Esc stops.`);
    } else if (tool === 'wire') this.status('Wire: click a pin or wire to start, click to set corners, end on a pin or wire. Double-click or Enter ends in free space. Backspace removes the last corner.');
    else if (tool === 'label') this.status('Net label: click a wire or pin. Wire ends with the same label are connected.');
    else if (tool === 'probeV') this.status('Voltmeter: click the point to measure.');
    else if (tool === 'probeA') this.status('Ammeter: click the part whose current you want.');
    else if (tool === 'probeR') this.status('Ohmmeter: click the first of two points.');
    else this.status('');
    this.svg.dataset.tool = tool;
    this._renderOverlay();
    this._selChanged();
  }

  _wireLeg(from, to) {
    if (!this.autoRoute) return [from, to];
    return routeOrtho(from, to, Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? 'hv' : 'vh');
  }

  _finishWire(endOnTarget) {
    const m = this.mode;
    this.mode = null;
    if (!m || m.type !== 'wire') return;
    const pts = simplifyPath(m.pts);
    if (pts.length >= 2) {
      const w = { id: nid('w'), pts };
      this.doc.wires.push(w);
      this.commit('wire');
      this.status(endOnTarget ? 'Wire connected.' : 'Wire ended in free space (not connected at that end).');
    } else this._renderOverlay();
  }

  // ---------------------------------------------------------------- moving things
  /** Wire ends, labels and probe points that sit on pins of the given parts and must follow them. */
  _followers(parts, movingWires) {
    const out = [];
    const mw = new Set(movingWires);
    for (const part of parts) {
      pinPositions(part).forEach((pt, pin) => {
        for (const w of this.doc.wires) {
          if (mw.has(w)) continue;
          if (samePt(w.pts[0], pt)) out.push({ kind: 'wire', w, start: true, part, pin, orig: w.pts.map((p) => p.slice()) });
          if (samePt(w.pts[w.pts.length - 1], pt)) out.push({ kind: 'wire', w, start: false, part, pin, orig: w.pts.map((p) => p.slice()) });
        }
        for (const l of this.doc.labels) if (!this.sel.has(l.id) && samePt([l.x, l.y], pt)) out.push({ kind: 'label', l, part, pin });
        for (const pr of this.doc.probes) {
          if (pr.kind === 'A') continue;
          if (samePt(pr.at, pt)) out.push({ kind: 'probe', pr, key: 'at', part, pin });
          if (pr.ref && samePt(pr.ref, pt)) out.push({ kind: 'probe', pr, key: 'ref', part, pin });
        }
      });
    }
    // a wire attached at both ends is handled once per end, starting from its original shape
    return out;
  }

  _applyFollowers(followers) {
    const done = new Map();
    for (const f of followers) {
      const to = pinPositions(f.part)[f.pin];
      if (f.kind === 'label') { f.l.x = to[0]; f.l.y = to[1]; continue; }
      if (f.kind === 'probe') { f.pr[f.key] = [to[0], to[1]]; continue; }
      const base = done.get(f.w) || f.orig.map((p) => p.slice());
      const n = base.length;
      const i = f.start ? 0 : n - 1;
      const j = f.start ? 1 : n - 2;
      const dx = to[0] - base[i][0];
      const dy = to[1] - base[i][1];
      let pts = base;
      if (n === 2) {
        const fixed = base[j];
        const horiz = Math.abs(base[i][1] - fixed[1]) < 1e-9;
        const leg = routeOrtho(fixed, to, horiz ? 'hv' : 'vh');
        pts = f.start ? leg.slice().reverse() : leg;
      } else {
        if (Math.abs(base[i][1] - base[j][1]) < 1e-9) base[j][1] += dy;
        else if (Math.abs(base[i][0] - base[j][0]) < 1e-9) base[j][0] += dx;
        base[i] = [to[0], to[1]];
      }
      done.set(f.w, pts);
      f.w.pts = pts.map((p) => p.slice());
    }
  }

  _beginMove(start, e) {
    const parts = this.selected('part');
    const wires = this.selected('wire');
    const labels = this.selected('label');
    const probes = this.selected('probe').filter((p) => p.kind !== 'A');
    this.mode = {
      type: 'move', start, moved: false,
      parts: parts.map((p) => ({ p, x: p.x, y: p.y })),
      wires: wires.map((w) => ({ w, pts: w.pts.map((q) => q.slice()) })),
      labels: labels.map((l) => ({ l, x: l.x, y: l.y })),
      probes: probes.map((p) => ({ p, at: p.at.slice(), ref: p.ref ? p.ref.slice() : null })),
      followers: this._followers(parts, wires),
      press: e,
    };
  }

  _doMove(pt, free) {
    const m = this.mode;
    let dx = pt[0] - m.start[0];
    let dy = pt[1] - m.start[1];
    if (!m.moved && Math.hypot(dx, dy) * U * this.zoom < 4) return;
    m.moved = true;
    // snap the delta so that the first part (or wire) ends up on the grid
    const ref = m.parts[0] ? [m.parts[0].x, m.parts[0].y] : m.wires[0] ? m.wires[0].pts[0] : m.labels[0] ? [m.labels[0].x, m.labels[0].y] : m.probes[0] ? m.probes[0].at : [0, 0];
    dx = this.snap(ref[0] + dx, free) - ref[0];
    dy = this.snap(ref[1] + dy, free) - ref[1];
    for (const o of m.parts) { o.p.x = o.x + dx; o.p.y = o.y + dy; }
    for (const o of m.wires) o.w.pts = o.pts.map((q) => [q[0] + dx, q[1] + dy]);
    for (const o of m.labels) { o.l.x = o.x + dx; o.l.y = o.y + dy; }
    for (const o of m.probes) { o.p.at = [o.at[0] + dx, o.at[1] + dy]; if (o.ref) o.p.ref = [o.ref[0] + dx, o.ref[1] + dy]; }
    this._applyFollowers(m.followers);
    this.renderAll();
  }

  _transformSel(fn) {
    const parts = this.selected('part');
    const wires = this.selected('wire');
    const labels = this.selected('label');
    if (!parts.length && !wires.length && !labels.length) return;
    const followers = this._followers(parts, wires);
    if (parts.length === 1 && !wires.length && !labels.length) fn(parts[0], [parts[0].x, parts[0].y], null);
    else {
      let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
      const add = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
      parts.forEach((p) => add(p.x, p.y));
      wires.forEach((w) => w.pts.forEach((q) => add(q[0], q[1])));
      labels.forEach((l) => add(l.x, l.y));
      const c = [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
      for (const p of parts) fn(p, c, null);
      for (const w of wires) w.pts = w.pts.map((q) => fn(null, c, q));
      for (const l of labels) [l.x, l.y] = fn(null, c, [l.x, l.y]);
    }
    this._applyFollowers(followers);
    for (const w of this.doc.wires) w.pts = simplifyPath(w.pts);
    this.commit('transform');
  }

  rotateSel() {
    if (this.tool === 'place' && this.ghost) { this.ghost.rot = (this.ghost.rot + 1) % 4; this._renderOverlay(); return; }
    this._transformSel((part, c, pt) => {
      const rot = (q) => [c[0] - (q[1] - c[1]), c[1] + (q[0] - c[0])];
      if (!part) return rot(pt);
      [part.x, part.y] = rot([part.x, part.y]);
      part.rot = ((part.rot || 0) + 1) % 4;
      return null;
    });
  }

  mirrorSel() {
    if (this.tool === 'place' && this.ghost) { this.ghost.mirror = !this.ghost.mirror; this._renderOverlay(); return; }
    this._transformSel((part, c, pt) => {
      const mir = (q) => [2 * c[0] - q[0], q[1]];
      if (!part) return mir(pt);
      [part.x, part.y] = mir([part.x, part.y]);
      part.rot = (4 - (part.rot || 0)) % 4;
      part.mirror = !part.mirror;
      return null;
    });
  }

  deleteSel() {
    if (!this.sel.size) return;
    const d = this.doc;
    const gone = new Set(this.sel);
    d.parts = d.parts.filter((p) => !gone.has(p.id));
    d.wires = d.wires.filter((w) => !gone.has(w.id));
    d.labels = d.labels.filter((l) => !gone.has(l.id));
    d.probes = d.probes.filter((p) => !gone.has(p.id) && !(p.kind === 'A' && gone.has(p.part)));
    this.sel.clear();
    this.commit('delete');
  }

  selectAll() {
    const d = this.doc;
    this.select([...d.parts, ...d.wires, ...d.labels].map((o) => o.id));
  }

  copy() {
    const parts = this.selected('part');
    const wires = this.selected('wire');
    const labels = this.selected('label');
    if (!parts.length && !wires.length && !labels.length) return false;
    clipboard = JSON.stringify({ parts, wires, labels });
    return true;
  }

  paste(at) {
    if (!clipboard) return;
    const data = JSON.parse(clipboard);
    let x1 = Infinity; let y1 = Infinity;
    data.parts.forEach((p) => { x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); });
    data.wires.forEach((w) => w.pts.forEach((q) => { x1 = Math.min(x1, q[0]); y1 = Math.min(y1, q[1]); }));
    data.labels.forEach((l) => { x1 = Math.min(x1, l.x); y1 = Math.min(y1, l.y); });
    const dx = at ? Math.round(at[0] - x1) : 2;
    const dy = at ? Math.round(at[1] - y1) : 2;
    const ids = [];
    const renamed = new Map();
    for (const p of data.parts) {
      const old = p.name;
      p.id = nid('p');
      p.x += dx; p.y += dy;
      this.doc.parts.push(p);
      p.name = '';
      p.name = nextName(this.doc, p.type);
      if (old) renamed.set(old, p.name);
      ids.push(p.id);
    }
    // pasted contacts follow their pasted relay
    for (const p of data.parts) if (PARTS[p.type].relayContact && renamed.has(p.params.relay)) p.params.relay = renamed.get(p.params.relay);
    for (const w of data.wires) { w.id = nid('w'); w.pts = w.pts.map((q) => [q[0] + dx, q[1] + dy]); this.doc.wires.push(w); ids.push(w.id); }
    for (const l of data.labels) { l.id = nid('l'); l.x += dx; l.y += dy; this.doc.labels.push(l); ids.push(l.id); }
    this.sel = new Set(ids);
    this.commit('paste');
  }

  duplicate() {
    const keep = clipboard;
    if (this.copy()) this.paste(null);
    clipboard = keep;
  }

  // ---------------------------------------------------------------- pointer + keyboard
  _bind() {
    const svg = this.svg;
    this._listeners = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); this._listeners.push([t, ev, fn, opt]); };

    on(svg, 'pointerdown', (e) => this._down(e));
    on(svg, 'pointermove', (e) => this._move(e));
    on(window, 'pointerup', (e) => this._up(e));
    on(svg, 'dblclick', (e) => this._dbl(e));
    on(svg, 'contextmenu', (e) => e.preventDefault());
    on(svg, 'pointerleave', () => { this.hoverHit = null; this.tip.style.display = 'none'; });
    on(svg, 'wheel', (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.shiftKey) this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
      else { this.pan[0] -= e.deltaY; this._applyView(); }
    }, { passive: false });
    on(window, 'keydown', (e) => this._key(e));
    on(window, 'keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
    this._ro = new ResizeObserver(() => this._applyView());
    this._ro.observe(this.host);
  }

  _down(e) {
    this.svg.focus({ preventScroll: true });
    const pt = this.toWorldPt(e);
    const free = e.altKey;
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      if (e.button === 2 && this.mode && this.mode.type === 'wire') { this._finishWire(false); return; }
      this.mode = { type: 'pan', sx: e.clientX, sy: e.clientY, pan: this.pan.slice(), back: this.mode };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const tool = this.tool;
    if (tool === 'place') {
      const part = makePart(this.doc, this.ghost.type, this.snap(pt[0], free), this.snap(pt[1], free), { rot: this.ghost.rot, mirror: this.ghost.mirror });
      this.doc.parts.push(part);
      this.sel = new Set([part.id]);
      this.commit('place');
      return;
    }
    if (tool === 'wire') { this._wireClick(pt, free); return; }
    if (tool === 'label') {
      const tg = this.target(pt[0], pt[1], free);
      if (!tg.on) { this.status('Click directly on a wire or a pin to attach a label.'); return; }
      const text = window.prompt('Net name (wire ends with the same name are connected; "GND" = ground):', 'VCC');
      if (text && text.trim()) { this.doc.labels.push({ id: nid('l'), x: tg.pt[0], y: tg.pt[1], text: text.trim() }); this.commit('label'); }
      return;
    }
    if (tool === 'probeA') {
      const h = this.hit(pt[0], pt[1]);
      const part = h && (h.kind === 'part' || h.kind === 'pin') ? h.o : null;
      if (!part || part.type === 'GND') { this.status('Click on a part (not a wire) to measure the current through it.'); return; }
      this.doc.probes.push({ id: nid('m'), kind: 'A', part: part.id, scope: false, name: '' });
      this.commit('probe');
      this.setTool('select');
      return;
    }
    if (tool === 'probeV' || tool === 'probeR') {
      const tg = this.target(pt[0], pt[1], free);
      if (!tg.on) { this.status('Click on a wire or a pin.'); return; }
      if (this.mode && this.mode.type === 'probe2') {
        this.doc.probes.push({ id: nid('m'), kind: this.mode.kind, at: this.mode.at, ref: tg.pt, scope: false, name: '' });
        this.mode = null;
        this.commit('probe');
        this.setTool('select');
      } else {
        this.mode = { type: 'probe2', kind: tool === 'probeV' ? 'V' : 'R', at: tg.pt, cursor: tg };
        this.status(tool === 'probeV' ? 'Click a second point for a difference measurement, or press Enter to measure against ground.' : 'Click the second point.');
      }
      return;
    }
    // ---- select tool
    const h = this.hit(pt[0], pt[1]);
    this.svg.setPointerCapture(e.pointerId);
    if (!h) {
      if (!e.shiftKey) this.sel.clear();
      this.mode = { type: 'box', a: pt, b: pt, add: e.shiftKey };
      this.renderAll();
      this._selChanged();
      return;
    }
    if (h.kind === 'pin' && !this.sel.has(h.o.id)) {
      // dragging from a pin starts a wire, a plain click selects the part
      this.mode = { type: 'pinpress', part: h.o, pt: h.pt, start: pt };
      return;
    }
    if (h.kind === 'vertex') {
      this.mode = { type: 'vertex', w: h.o, index: h.index, moved: false };
      return;
    }
    const o = h.o;
    if (e.shiftKey) {
      if (this.sel.has(o.id)) this.sel.delete(o.id); else this.sel.add(o.id);
      this.renderAll();
      this._selChanged();
      return;
    }
    const wasSelected = this.sel.has(o.id);
    if (!wasSelected) { this.sel = new Set([o.id]); this.renderAll(); this._selChanged(); }
    if (h.kind === 'wire' && this.sel.size === 1) {
      this.mode = { type: 'segment', w: o, seg: h.seg, start: pt, orig: o.pts.map((q) => q.slice()), moved: false };
      return;
    }
    this._beginMove(pt, e);
    // interactive parts react immediately; a drag cancels the press again
    const part = h.kind === 'part' || h.kind === 'pin' ? o : null;
    if (part && PARTS[part.type].interactive === 'momentary') {
      part.params.closed = true;
      this.mode.pressed = part;
      this.sim.rebuild(this.doc);
      this.renderAll();
    } else if (part && PARTS[part.type].interactive === 'toggle') this.mode.toggle = part;
  }

  _wireClick(pt, free) {
    const m = this.mode && this.mode.type === 'wire' ? this.mode : null;
    const tg = this.target(pt[0], pt[1], free);
    if (!m) {
      this.mode = { type: 'wire', pts: [tg.pt], cursor: tg, startOn: tg.on };
      this._renderOverlay();
      return;
    }
    const last = m.pts[m.pts.length - 1];
    if (samePt(last, tg.pt)) return;
    m.pts.push(...this._wireLeg(last, tg.pt).slice(1));
    if (tg.on) this._finishWire(true);
    else this._renderOverlay();
  }

  _move(e) {
    const pt = this.toWorldPt(e);
    this.mouse = pt;
    const free = e.altKey;
    const m = this.mode;
    if (m && m.type === 'pan') {
      this.pan = [m.pan[0] + e.clientX - m.sx, m.pan[1] + e.clientY - m.sy];
      this._applyView();
      return;
    }
    if (this.tool === 'place' && this.ghost) {
      this.ghost.x = this.snap(pt[0], free);
      this.ghost.y = this.snap(pt[1], free);
      this._renderOverlay();
      return;
    }
    if (['wire', 'label', 'probeV', 'probeR'].includes(this.tool)) {
      const tg = this.target(pt[0], pt[1], free);
      this.cursorTarget = tg;
      if (m) m.cursor = tg;
      this._renderOverlay();
      return;
    }
    if (!m) { this._hover(pt, e); return; }
    if (m.type === 'box') { m.b = pt; this._renderOverlay(); return; }
    if (m.type === 'pinpress') {
      if (Math.hypot(pt[0] - m.start[0], pt[1] - m.start[1]) * U * this.zoom > 5) {
        this.tool = 'wire';
        this.svg.dataset.tool = 'wire';
        this.oneShotWire = true;
        this.mode = { type: 'wire', pts: [[m.pt[0], m.pt[1]]], cursor: this.target(pt[0], pt[1], free), startOn: 'pin', dragStart: true };
        this._selChanged();
        this._renderOverlay();
      }
      return;
    }
    if (m.type === 'move') {
      if (m.pressed && Math.hypot(pt[0] - m.start[0], pt[1] - m.start[1]) * U * this.zoom >= 4) {
        m.pressed.params.closed = false;
        m.pressed = null;
      }
      this._doMove(pt, free);
      return;
    }
    if (m.type === 'vertex') {
      const end = m.index === 0 || m.index === m.w.pts.length - 1;
      const tg = end ? this.target(pt[0], pt[1], free, m.w) : { pt: [this.snap(pt[0], free), this.snap(pt[1], free)] };
      m.w.pts[m.index] = tg.pt;
      m.moved = true;
      this.renderAll();
      return;
    }
    if (m.type === 'segment') {
      const dx = pt[0] - m.start[0];
      const dy = pt[1] - m.start[1];
      if (!m.moved && Math.hypot(dx, dy) * U * this.zoom < 4) return;
      if (!m.moved) {
        // keep both wire ends where they are: add a corner if an end segment is dragged
        m.moved = true;
        const o = m.orig;
        if (m.seg === o.length - 2) o.push(o[o.length - 1].slice());
        if (m.seg === 0) { o.unshift(o[0].slice()); m.seg = 1; }
      }
      const pts = m.orig.map((q) => q.slice());
      const a = pts[m.seg];
      const b = pts[m.seg + 1];
      const horiz = Math.abs(a[1] - b[1]) < 1e-9;
      const vert = Math.abs(a[0] - b[0]) < 1e-9;
      if (horiz) { const y = this.snap(a[1] + dy, free); a[1] = y; b[1] = y; }
      else if (vert) { const x = this.snap(a[0] + dx, free); a[0] = x; b[0] = x; }
      else { const sx = this.snap(a[0] + dx, free) - a[0]; const sy = this.snap(a[1] + dy, free) - a[1]; a[0] += sx; a[1] += sy; b[0] += sx; b[1] += sy; }
      m.w.pts = pts;
      this.renderAll();
    }
  }

  _up(e) {
    const m = this.mode;
    if (!m) return;
    if (m.type === 'pan') { this.mode = m.back || null; return; }
    if (m.type === 'wire') {
      // drag-from-pin gesture: releasing on a pin or wire completes it
      if (m.dragStart) {
        m.dragStart = false;
        const pt = this.toWorldPt(e);
        const tg = this.target(pt[0], pt[1], e.altKey);
        if (tg.on && !samePt(tg.pt, m.pts[0])) { m.pts.push(...this._wireLeg(m.pts[m.pts.length - 1], tg.pt).slice(1)); this._finishWire(true); this._afterOneShot(); }
      }
      return;
    }
    if (m.type === 'probe2') return;
    this.mode = null;
    if (m.type === 'pinpress') { this.select([m.part.id]); return; }
    if (m.type === 'box') {
      const x1 = Math.min(m.a[0], m.b[0]); const x2 = Math.max(m.a[0], m.b[0]);
      const y1 = Math.min(m.a[1], m.b[1]); const y2 = Math.max(m.a[1], m.b[1]);
      if (x2 - x1 > 0.2 || y2 - y1 > 0.2) {
        const inside = (x, y) => x >= x1 && x <= x2 && y >= y1 && y <= y2;
        for (const p of this.doc.parts) { const b = partBBox(p); if (inside(b.x1, b.y1) && inside(b.x2, b.y2)) this.sel.add(p.id); }
        for (const w of this.doc.wires) if (w.pts.every((q) => inside(q[0], q[1]))) this.sel.add(w.id);
        for (const l of this.doc.labels) if (inside(l.x, l.y)) this.sel.add(l.id);
      }
      this.renderAll();
      this._selChanged();
      return;
    }
    if (m.type === 'move') {
      if (m.pressed) { m.pressed.params.closed = false; this.sim.rebuild(this.doc); this.renderAll(); return; }
      if (!m.moved) {
        if (m.toggle) { m.toggle.params.closed = !m.toggle.params.closed; this.commit('toggle'); }
        return;
      }
      for (const w of this.doc.wires) w.pts = simplifyPath(w.pts);
      this.doc.wires = this.doc.wires.filter((w) => w.pts.length >= 2);
      this.commit('move');
      return;
    }
    if (m.type === 'vertex' || m.type === 'segment') {
      if (!m.moved) return;
      m.w.pts = simplifyPath(m.w.pts);
      if (m.w.pts.length < 2) this.doc.wires = this.doc.wires.filter((w) => w !== m.w);
      this.commit('reshape');
    }
  }

  _afterOneShot() {
    if (this.oneShotWire) { this.oneShotWire = false; this.setTool('select'); }
  }

  _dbl(e) {
    const pt = this.toWorldPt(e);
    if (this.tool === 'wire') { if (this.mode && this.mode.type === 'wire') { this._finishWire(false); this._afterOneShot(); } return; }
    if (this.tool !== 'select') return;
    const h = this.hit(pt[0], pt[1]);
    if (!h) return;
    if (h.kind === 'vertex') {
      // remove a corner point
      if (h.index > 0 && h.index < h.o.pts.length - 1) { h.o.pts.splice(h.index, 1); this.commit('reshape'); }
    } else if (h.kind === 'wire') {
      // insert a corner point
      const p = [this.snap(h.pt[0], e.altKey), this.snap(h.pt[1], e.altKey)];
      h.o.pts.splice(h.seg + 1, 0, p);
      this.select([h.o.id]);
      this.commit('reshape');
    } else if (h.kind === 'part' || h.kind === 'pin') {
      if (this.cb.onEditPart) this.cb.onEditPart(h.o);
    } else if (h.kind === 'label') {
      const text = window.prompt('Net name:', h.o.text);
      if (text && text.trim()) { h.o.text = text.trim(); this.commit('label'); }
    }
  }

  _key(e) {
    if (!this.host.isConnected) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (document.querySelector('.modal-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') { this.spaceDown = true; e.preventDefault(); return; }
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'c') { this.copy(); return; }
    if (mod && k === 'x') { if (this.copy()) this.deleteSel(); return; }
    if (mod && k === 'v') { e.preventDefault(); this.paste(this.mouse); return; }
    if (mod && k === 'd') { e.preventDefault(); this.duplicate(); return; }
    if (mod && k === 'a') { e.preventDefault(); this.selectAll(); return; }
    if (mod) return;
    const m = this.mode;
    if (e.key === 'Escape') {
      if (m && (m.type === 'wire' || m.type === 'probe2')) { this.mode = null; this._renderOverlay(); this._afterOneShot(); }
      else if (this.tool !== 'select') this.setTool('select');
      else this.select([]);
      return;
    }
    if (e.key === 'Enter') {
      if (m && m.type === 'wire') { this._finishWire(false); this._afterOneShot(); }
      else if (m && m.type === 'probe2') {
        this.doc.probes.push({ id: nid('m'), kind: m.kind, at: m.at, ref: null, scope: false, name: '' });
        this.mode = null;
        this.commit('probe');
        this.setTool('select');
      }
      return;
    }
    if (e.key === 'Backspace' && m && m.type === 'wire') {
      e.preventDefault();
      if (m.pts.length > 1) m.pts.pop(); else this.mode = null;
      this._renderOverlay();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSel(); return; }
    if (k === 'r') this.rotateSel();
    else if (k === 'x' || k === 'm') this.mirrorSel();
    else if (k === 'w') this.setTool('wire');
    else if (k === 'v') this.setTool('select');
    else if (k === 'l') this.setTool('label');
    else if (k === 'f') this.fit();
    else if (k === '+' || k === '=') this.zoomAt(1.2);
    else if (k === '-') this.zoomAt(1 / 1.2);
    else if (e.key.startsWith('Arrow') && this.sel.size) {
      e.preventDefault();
      const step = e.altKey ? 0.05 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      this._beginMove([0, 0], e);
      this.mode.moved = true;
      this._doMove(d, true);
      this.mode = null;
      this.commit('move');
    }
  }

  // ---------------------------------------------------------------- hover read-out
  _hover(pt, e) {
    const h = this.hit(pt[0], pt[1]);
    this.hoverHit = h ? { ...h, cx: e.clientX, cy: e.clientY } : null;
    this.svg.style.cursor = h ? (h.kind === 'pin' ? 'crosshair' : h.kind === 'vertex' ? 'move' : 'pointer') : '';
    this._showTip();
  }

  _showTip() {
    const h = this.hoverHit;
    const tip = this.tip;
    if (!h || this.mode) { tip.style.display = 'none'; return; }
    const sim = this.sim;
    let html = '';
    if (h.kind === 'part') {
      const part = h.o;
      const def = PARTS[part.type];
      const r = sim.partResult(part);
      html = `<b>${esc(part.name || def.name)}</b> <span>${esc(def.name)}</span>`;
      if (r) {
        html += `<div>U = ${formatSI(r.v, 'V')}</div><div>I = ${formatSI(r.i, 'A')}</div><div>P = ${formatSI(r.p, 'W')}</div>`;
        if (r.region) html += `<div>${r.region}${r.ib !== undefined ? ` · I<sub>B</sub> = ${formatSI(r.ib, 'A')} · V<sub>CE</sub> = ${formatSI(r.vce, 'V')}` : ''}${r.vgs !== undefined ? ` · V<sub>GS</sub> = ${formatSI(r.vgs, 'V')}` : ''}</div>`;
        if (r.rpm !== undefined) html += `<div>${Math.round(r.rpm)} rpm</div>`;
        if (r.on !== undefined) html += `<div>${r.on ? 'energised' : 'released'}</div>`;
        if (r.burned) html += '<div class="warn">burned out</div>';
        else if (r.blown) html += '<div class="warn">blown</div>';
        else if (r.overload) html += `<div class="warn">overloaded ×${r.overload.toFixed(1)}</div>`;
      } else if (part.type !== 'GND') html += `<div class="warn">${sim.net && sim.net.excluded.has(part.id) ? 'not simulated (see problems)' : 'no result'}</div>`;
      if (def.interactive) html += '<div class="hint">click to operate</div>';
    } else if (h.kind === 'wire' || h.kind === 'pin' || h.kind === 'vertex') {
      const p = h.kind === 'wire' ? h.pt : h.kind === 'pin' ? h.pt : h.o.pts[h.index];
      const nv = sim.nodeVoltage(p[0], p[1]);
      html = nv ? `<b>Node ${esc(nv.node === '0' ? 'GND' : nv.node)}</b><div>U = ${formatSI(nv.v, 'V')}</div>` : '<b>Node</b><div class="warn">no voltage (not simulated)</div>';
      if (h.kind === 'pin') html += `<div class="hint">pin ${esc(PARTS[h.o.type].pins[h.index].name)} of ${esc(h.o.name || PARTS[h.o.type].name)} · drag to wire</div>`;
    } else if (h.kind === 'label') html = `<b>Net label</b><div>${esc(h.o.text)}</div>`;
    else if (h.kind === 'probe') html = `<b>${esc(sim.probeLabel(h.o))}</b>`;
    if (!html) { tip.style.display = 'none'; return; }
    tip.innerHTML = html;
    const r = this.host.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = Math.min(r.width - 190, h.cx - r.left + 14) + 'px';
    tip.style.top = Math.min(r.height - 110, h.cy - r.top + 14) + 'px';
  }

  destroy() {
    for (const [t, ev, fn, opt] of this._listeners) t.removeEventListener(ev, fn, opt);
    this._ro.disconnect();
    this.host.innerHTML = '';
  }
}
