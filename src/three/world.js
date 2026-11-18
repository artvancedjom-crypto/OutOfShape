// 3D world: renderer, toy-world lighting, baseplate, and two camera modes:
//  - 'overview': orbit / pan / zoom over the whole scene (OrbitControls)
//  - 'fps': walkable first person (WASD + mouse look, pointer lock or drag)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { COLORS, plastic } from './bricks.js';

export class World {
  constructor(container, { size = 64, theme = 'light' } = {}) {
    this.container = container;
    this.size = size;
    this.updaters = [];
    this.interactables = [];
    this.colliders = []; // THREE.Box3 list for FPS collisions
    this.mode = 'overview';
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.clock = new THREE.Clock();
    this.hovered = null;
    this.pressed = null;
    this.onModeChange = null;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.append(r.domElement);
    r.domElement.classList.add('world-canvas');
    r.domElement.tabIndex = 0;

    const scene = (this.scene = new THREE.Scene());
    this.setTheme(theme);

    const cam = (this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600));
    cam.position.set(size * 0.42, size * 0.36, size * 0.5);

    // lighting: soft sky fill + warm sun with shadows
    scene.add(new THREE.HemisphereLight(0xdff1ff, 0x8a7a5a, 1.1));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff3dd, 2.2));
    sun.position.set(size * 0.4, size * 0.9, size * 0.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = size * 0.65;
    Object.assign(sun.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc, near: 1, far: size * 3 });
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    this._baseplate(size);

    const orbit = (this.orbit = new OrbitControls(cam, r.domElement));
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbit.maxPolarAngle = Math.PI * 0.48;
    orbit.minDistance = 6;
    orbit.maxDistance = size * 2;
    orbit.screenSpacePanning = false;
    orbit.target.set(0, 2, 0);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._bind();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this._raf = 0;
    this._loop = this._loop.bind(this);
  }

  setTheme(theme) {
    const sky = theme === 'dark' ? 0x1d2433 : 0xbfe3ff;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, this.size * 1.4, this.size * 3.2);
  }

  _baseplate(size) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(size, 0.4, size), plastic(COLORS.green));
    base.position.y = -0.2;
    base.receiveShadow = true;
    g.add(base);
    // studs via instancing
    const stud = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10);
    const n = size * size;
    const inst = new THREE.InstancedMesh(stud, plastic(0x2a8a4c), n);
    const m = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        m.makeTranslation(i - size / 2 + 0.5, 0.1, j - size / 2 + 0.5);
        inst.setMatrixAt(k++, m);
      }
    }
    inst.receiveShadow = true;
    g.add(inst);
    // a big grass skirt beyond the plate
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(size * 6, size * 6), new THREE.MeshStandardMaterial({ color: 0x5aa469, roughness: 1 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -0.41;
    skirt.receiveShadow = true;
    g.add(skirt);
    this.scene.add(g);
  }

  /** Register a clickable object. handlers: {onDown, onUp, hover:bool, tip} */
  addInteractable(obj, handlers) {
    obj.traverse((o) => { o.userData.__interact = handlers; o.userData.__root = obj; });
    this.interactables.push(obj);
  }

  addCollider(obj, pad = 0.3) {
    const b = new THREE.Box3().setFromObject(obj);
    b.expandByScalar(pad);
    this.colliders.push(b);
    return b;
  }

  onUpdate(fn) {
    this.updaters.push(fn);
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    const cam = this.camera;
    if (mode === 'fps') {
      this.orbit.enabled = false;
      // drop the player at the scene edge, looking at the centre
      const p = this.spawn || new THREE.Vector3(0, 0, this.size * 0.35);
      cam.position.set(p.x, 5, p.z);
      this.yaw = Math.atan2(cam.position.x, cam.position.z);
      this.pitch = -0.12;
      this._applyLook();
    } else {
      this.orbit.enabled = true;
      if (document.pointerLockElement) document.exitPointerLock();
      cam.position.set(this.size * 0.42, this.size * 0.36, this.size * 0.5);
      this.orbit.target.set(0, 2, 0);
      this.orbit.update();
    }
    this.container.classList.toggle('fps', mode === 'fps');
    if (this.onModeChange) this.onModeChange(mode);
  }

  _applyLook() {
    const e = new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(e);
  }

  _bind() {
    const el = this.renderer.domElement;
    this._listeners = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); this._listeners.push([t, ev, fn, opt]); };
    let drag = null;
    on(el, 'pointerdown', (e) => {
      el.focus();
      if (this.mode === 'fps') {
        const locked = document.pointerLockElement === el;
        if (!locked && e.button === 0) {
          // try pointer lock; also allow drag-look fallback
          try { const p = el.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* ignore */ }
          drag = { x: e.clientX, y: e.clientY, moved: false };
        }
        if (locked) this._pick(0, 0, true);
        else this._pickEvent(e, true, drag);
        return;
      }
      this._pickEvent(e, true);
    });
    on(window, 'pointerup', () => {
      drag = null;
      if (this.pressed) {
        const h = this.pressed.userData.__interact;
        if (h && h.onUp) h.onUp();
        this.pressed = null;
      }
    });
    on(el, 'pointermove', (e) => {
      if (this.mode === 'fps') {
        const locked = document.pointerLockElement === el;
        if (locked) {
          // browsers may report a bogus jump right after the lock is acquired
          if (this._skipMoves > 0) { this._skipMoves--; return; }
          if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;
          this.yaw -= e.movementX * 0.0022;
          this.pitch -= e.movementY * 0.0022;
        } else if (drag && !this.pressed) {
          this.yaw -= (e.clientX - drag.x) * 0.005;
          this.pitch -= (e.clientY - drag.y) * 0.005;
          drag.x = e.clientX;
          drag.y = e.clientY;
        }
        this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
        this._applyLook();
        if (locked) this._hoverAt(0, 0);
        else this._hoverEvent(e);
      } else {
        this._hoverEvent(e);
      }
    });
    on(document, 'pointerlockchange', () => { this._skipMoves = 2; drag = null; });
    on(el, 'keydown', (e) => {
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'Space'].includes(e.code) && this.mode === 'fps') e.preventDefault();
    });
    on(el, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  _ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1];
  }

  _hit(x, y) {
    this.pointer.set(x, y);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.interactables, true);
    for (const h of hits) if (h.object.userData.__interact) return h.object.userData.__root;
    return null;
  }

  _hoverEvent(e) {
    const [x, y] = this._ndc(e);
    this._hoverAt(x, y);
  }

  _hoverAt(x, y) {
    const obj = this._hit(x, y);
    if (obj !== this.hovered) {
      if (this.hovered && this.hovered.userData.hover) this.hovered.userData.hover(false);
      this.hovered = obj;
      if (obj && obj.userData.hover) obj.userData.hover(true);
      this.renderer.domElement.style.cursor = obj ? 'pointer' : '';
      if (this.onHover) this.onHover(obj ? obj.userData.__interact.tip : null);
    }
  }

  _pickEvent(e, down) {
    const [x, y] = this._ndc(e);
    return this._pick(x, y, down, e);
  }

  _pick(x, y, down, e) {
    const obj = this._hit(x, y);
    if (!obj) return false;
    const h = obj.userData.__interact;
    if (down && h.onDown) {
      h.onDown();
      this.pressed = obj;
      if (e && this.mode === 'overview') {
        // don't orbit while pressing a control
        this.orbit.enabled = false;
        const re = () => { this.orbit.enabled = this.mode === 'overview'; window.removeEventListener('pointerup', re); };
        window.addEventListener('pointerup', re);
      }
    }
    return true;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _walk(dt) {
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 22 : 11) * dt;
    const f = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const s = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    if (!f && !s) return this._ground(dt);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    let dx = (fx * f + rx * s);
    let dz = (fz * f + rz * s);
    const len = Math.hypot(dx, dz) || 1;
    dx = (dx / len) * speed;
    dz = (dz / len) * speed;
    const p = this.camera.position;
    const lim = this.size / 2 - 1;
    const tryMove = (nx, nz) => {
      const pt = new THREE.Vector3(nx, 2, nz);
      for (const b of this.colliders) if (b.containsPoint(pt)) return false;
      return Math.abs(nx) < lim && Math.abs(nz) < lim;
    };
    if (tryMove(p.x + dx, p.z)) p.x += dx;
    if (tryMove(p.x, p.z + dz)) p.z += dz;
    this._ground(dt);
    this._bob = (this._bob || 0) + speed;
  }

  _ground(dt) {
    // scenarios may provide a floor-height function (e.g. riding the elevator)
    const p = this.camera.position;
    const g = this.groundAt ? this.groundAt(p.x, p.z, p.y - 5) : 0;
    const target = g + 5 + Math.sin((this._bob || 0) * 0.9) * 0.08;
    if (target < p.y - 0.05) this._vy = (this._vy || 0) - 40 * dt; // fall
    else this._vy = 0;
    p.y = Math.max(target, p.y + (this._vy || 0) * dt);
  }

  _loop() {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.mode === 'fps') this._walk(dt);
    else this.orbit.update();
    for (const f of this.updaters) f(dt);
    this.renderer.render(this.scene, this.camera);
  }

  start() {
    this.clock.start();
    this._loop();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    for (const [t, ev, fn, opt] of this._listeners) t.removeEventListener(ev, fn, opt);
    if (document.pointerLockElement) document.exitPointerLock();
    this.orbit.dispose();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      if (o.material && o.material.map) o.material.map.dispose();
    });
    this.renderer.domElement.remove();
  }
}
