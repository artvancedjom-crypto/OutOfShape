// The look of every kit element, built from chunky brick primitives, and the
// per-frame update of its moving parts. Origin of each group: centre of the
// footprint at the element's base; local +x is "forward".
import * as THREE from 'three';
import { brick, lamp as lampMesh, label, plastic, COLORS, PLATE } from '../three/bricks.js';
import { KIT, ITEM_COLORS, sizeOf, heightOf, RAW } from './elements.js';

const C = { ...COLORS, green: 0x1fbf3a, red: 0xe02020, yellow: 0xffd500, blue: 0x2266ff, white: 0xf4f4f4, orange: 0xff9900 };
const col = (name, fallback = 0xa0a5a9) => C[name] ?? fallback;
const metal = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.65, roughness: 0.3 });
const glass = new THREE.MeshStandardMaterial({ color: 0xcfefff, transparent: true, opacity: 0.25, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false });
const water = new THREE.MeshStandardMaterial({ color: COLORS.water, transparent: true, opacity: 0.8, roughness: 0.1 });

function box(w, h, d, color, x = 0, y = 0, z = 0, mat = null) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat || plastic(color));
  m.position.set(x, y + h / 2, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function cyl(r, h, color, x = 0, y = 0, z = 0, axis = 'y', mat = null, seg = 18) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat || plastic(color));
  if (axis === 'x') m.rotation.z = Math.PI / 2;
  if (axis === 'z') m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
const at = (o, x, y, z) => { o.position.set(x, y, z); return o; };
/** studded brick whose base is at height y (studs → plates conversion inside) */
const B = (w, d, hStuds, color, x = 0, y = 0, z = 0, studs = true) => at(brick(w, d, Math.max(1, Math.round(hStuds / PLATE)), color, { studs }), x, y, z);

const post = (h, color = COLORS.dark) => B(1, 1, h, color, 0, 0, 0, false);
function led(color, x, y, z, r = 0.22) {
  const l = lampMesh(color, { r, h: 0.2 });
  l.position.set(x, y, z);
  return l;
}

/** @returns {{group: THREE.Group, h: any}} h = handles for the per-frame update */
const BUILD = {
  conveyor(el) {
    const g = new THREE.Group();
    const L = el.params.length;
    g.add(box(L, 0.25, 1.8, 0x22262b, 0, 0.75));
    for (const z of [-0.95, 0.95]) g.add(box(L, 0.5, 0.1, C.yellow, 0, 0.62, z));
    for (let x = -L / 2 + 0.5; x <= L / 2; x += Math.max(2, L / 4)) for (const z of [-0.7, 0.7]) g.add(box(0.4, 0.75, 0.4, COLORS.gray, x, 0, z));
    const cleats = [];
    for (let x = 0; x < L; x += 1) { const c = box(0.12, 0.05, 1.7, 0x4a4f57, 0, 1.0); g.add(c); cleats.push(c); }
    return { group: g, h: { cleats, L } };
  },
  road(el) {
    const g = new THREE.Group();
    const L = el.params.length;
    g.add(box(L, 0.1, 4, COLORS.road));
    for (let x = -L / 2 + 1; x < L / 2; x += 3) g.add(box(1.4, 0.03, 0.2, 0xffffff, x, 0.1));
    const arrow = at(new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 3), plastic(0xffffff)), L / 2 - 0.8, 0.13, 1.4);
    arrow.rotation.set(Math.PI / 2, 0, -Math.PI / 2);
    arrow.scale.y = 1; arrow.scale.z = 0.1;
    g.add(arrow);
    return { group: g, h: {} };
  },
  crossing() { const g = new THREE.Group(); g.add(box(4, 0.1, 4, COLORS.road)); return { group: g, h: {} }; },
  spawner(el) {
    const g = new THREE.Group();
    g.add(B(2, 2, 2.4, C.blue));
    g.add(box(1.6, 0.5, 1.6, 0x16233a, 0, 2.4));
    g.add(box(0.6, 1.2, 1.4, 0x16233a, 0.75, 0.9));
    const kind = { box: '▣', bottle: '🍾', car: '🚗' }[el.params.kind] || '▣';
    const l = label(`${kind} source`, { size: 0.5 }); l.position.set(0, 3.9, 0); g.add(l);
    return { group: g, h: {} };
  },
  sink() {
    const g = new THREE.Group();
    g.add(box(3, 0.15, 3, COLORS.dark));
    for (const [x, z, w, d] of [[0, -1.4, 3, 0.2], [0, 1.4, 3, 0.2], [-1.4, 0, 0.2, 3], [1.4, 0, 0.2, 3]]) g.add(box(w, 1.2, d, C.green, x, 0, z));
    return { group: g, h: {} };
  },
  tank() {
    const g = new THREE.Group();
    g.add(box(4, 0.3, 4, COLORS.gray));
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 5.5, 32, 1, true), glass);
    wall.position.y = 0.3 + 2.75; g.add(wall);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.12, 8, 32), plastic(COLORS.azure));
    rim.rotation.x = Math.PI / 2; rim.position.y = 5.8; g.add(rim);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 1, 32), water.clone());
    w.position.y = 0.3; g.add(w);
    const l = label('0 %', { size: 0.55, bg: 'rgba(10,60,120,0.9)' }); l.position.set(0, 6.8, 0); g.add(l);
    return { group: g, h: { water: w, label: l } };
  },
  reservoir() { const g = new THREE.Group(); g.add(box(4, 0.8, 4, COLORS.tan)); g.add(box(3.4, 0.2, 3.4, COLORS.water, 0, 0.8, 0, water)); return { group: g, h: {} }; },
  drain() {
    const g = new THREE.Group(); g.add(box(2, 0.5, 2, COLORS.tan)); g.add(cyl(0.7, 0.35, 0x20252b, 0, 0.6));
    const jet = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.6, 10, 1, true), water); jet.position.y = 1.4; g.add(jet);
    return { group: g, h: { jet } };
  },
  pipe(el) { const g = new THREE.Group(); g.add(cyl(0.32, el.params.length, 0, 0, 0.5, 0, 'x', metal)); for (const x of [-el.params.length / 2 + 0.1, el.params.length / 2 - 0.1]) g.add(cyl(0.42, 0.2, 0, x, 0.5, 0, 'x', metal)); return { group: g, h: {} }; },
  elbow() {
    const g = new THREE.Group();
    g.add(cyl(0.32, 0.5, 0, 0.25, 0.5, 0, 'x', metal)); g.add(cyl(0.32, 0.5, 0, 0, 0.5, 0.25, 'z', metal));
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.36, 14, 10), metal); s.position.y = 0.5; g.add(s);
    return { group: g, h: {} };
  },
  motor() {
    const g = new THREE.Group();
    g.add(B(3, 2, 1.6, COLORS.dark, -0.2, 0, 0));
    for (let i = 0; i < 4; i++) g.add(box(0.25, 1.7, 2.2, COLORS.gray, -1.2 + i * 0.7, 0, 0));
    g.add(cyl(0.2, 1, 0, 1.4, 1, 0, 'x', metal));
    const fan = new THREE.Group();
    for (let i = 0; i < 3; i++) { const b = box(0.15, 1.2, 0.5, C.yellow, 0, 0, 0); b.geometry.translate(0, 0.6, 0); b.position.y = 0; b.rotation.x = (i * Math.PI * 2) / 3; fan.add(b); }
    fan.position.set(1.75, 1, 0); g.add(fan);
    const l = label('0 rpm', { size: 0.5 }); l.position.set(0, 3.2, 0); g.add(l);
    return { group: g, h: { fan, label: l } };
  },
  pump() {
    const g = new THREE.Group();
    g.add(box(2, 1, 1, C.blue)); g.add(cyl(0.32, 2.2, 0, 0, 0.5, 0, 'x', metal));
    const imp = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.3, 6), plastic(C.yellow)); imp.position.y = 1.25; g.add(imp);
    return { group: g, h: { imp } };
  },
  valve() {
    const g = new THREE.Group();
    g.add(cyl(0.32, 2, 0, 0, 0.5, 0, 'x', metal));
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), new THREE.MeshStandardMaterial({ color: C.red, roughness: 0.3 })); body.position.y = 0.5; g.add(body);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.09, 6, 16), plastic(C.yellow)); wheel.rotation.x = Math.PI / 2; wheel.position.y = 1.35; g.add(wheel);
    g.add(cyl(0.07, 0.6, COLORS.dark, 0, 1.1));
    return { group: g, h: { body, wheel } };
  },
  cylinder1: (el) => cylinderMesh(el, C.blue),
  cylinder2: (el) => cylinderMesh(el, 0x7a3fc4),
  gate() {
    const g = new THREE.Group();
    g.add(post(1.6, C.yellow));
    const arm = new THREE.Group();
    arm.position.set(0.4, 1.4, 0);
    g.add(arm);
    return { group: g, h: { arm, built: 0 } };
  },
  lamp(el) { const g = new THREE.Group(); g.add(post(1.2)); const l = lampMesh(col(el.params.color), { r: 0.42, h: 0.6 }); l.position.y = 1.2; g.add(l); return { group: g, h: { lamp: l } }; },
  horn() {
    const g = new THREE.Group(); g.add(post(1.2));
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 16, 1, true), plastic(C.red, { side: THREE.DoubleSide })); cone.rotation.z = Math.PI / 2; cone.position.set(0.2, 1.6, 0); g.add(cone);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.05, 6, 20), new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true })); ring.rotation.y = Math.PI / 2; ring.position.set(0.9, 1.6, 0); g.add(ring);
    return { group: g, h: { ring } };
  },
  trafficlight() {
    const g = new THREE.Group();
    g.add(post(4.2)); g.add(box(0.8, 2.4, 0.9, 0x15191e, 0, 4.2));
    const mk = (color, y) => { const l = lampMesh(color, { r: 0.3, h: 0.25 }); l.rotation.z = Math.PI / 2; l.position.set(-0.5, y, 0); g.add(l); return l; };
    return { group: g, h: { r: mk(0xff2020, 6.1), y: mk(0xffb000, 5.4), g: mk(0x20ff60, 4.7) } };
  },
  elevator(el) {
    const g = new THREE.Group();
    const p = el.params;
    const H = p.floors * p.floorHeight + 1;
    for (const [x, z] of [[-1.75, -1.75], [-1.75, 1.75], [1.75, -1.75], [1.75, 1.75]]) g.add(box(0.5, H, 0.5, COLORS.gray, x, 0, z));
    g.add(box(4, 0.4, 4, C.red, 0, H));
    for (let f = 1; f < p.floors; f++) g.add(box(0.5, 0.25, 3.4, C.yellow, 2.1, f * p.floorHeight - 0.25, 0));
    const car = new THREE.Group();
    car.add(box(3, 0.3, 3, COLORS.dark)); car.add(box(3, 0.3, 3, COLORS.dark, 0, 3.6));
    car.add(box(0.2, 3.3, 3, COLORS.azure, -1.4, 0.3, 0));
    for (const z of [-1.4, 1.4]) car.add(box(3, 3.3, 0.2, COLORS.azure, 0, 0.3, z));
    const doors = [box(0.2, 3.2, 1.4, C.yellow, 1.45, 0.3, -0.7), box(0.2, 3.2, 1.4, C.yellow, 1.45, 0.3, 0.7)];
    car.add(...doors);
    const ind = label('1', { size: 0.9, bg: 'rgba(0,0,0,0.85)', color: '#ff7a1a' }); ind.position.set(1.8, 4.6, 0); car.add(ind);
    g.add(car);
    return { group: g, h: { car, doors, ind } };
  },
  mixer() {
    const g = new THREE.Group(); g.add(post(6.2, C.blue)); g.add(box(1.6, 0.4, 0.5, C.blue, 0, 6.2)); g.add(box(0.8, 0.8, 0.8, COLORS.dark, 0, 6.6));
    const rotor = new THREE.Group(); rotor.add(box(1.4, 0.15, 0.3, C.yellow, 0, 0, 0)); rotor.add(box(0.3, 0.15, 1.4, C.yellow, 0, 0, 0)); rotor.position.y = 7.5; g.add(rotor);
    return { group: g, h: { rotor } };
  },
  heater() { const g = new THREE.Group(); g.add(B(1, 1, 1.2, 0x8a1c10)); const l = lampMesh(0xff5a1a, { r: 0.35, h: 0.5 }); l.position.y = 1.2; g.add(l); return { group: g, h: { lamp: l } }; },
  filler() {
    const g = new THREE.Group(); g.add(B(2, 2, 5.2, C.blue, 0, 0, 0)); g.add(box(2.6, 0.5, 1, C.blue, 1.2, 4.6));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.4, 1.2, 14), plastic(COLORS.azure, { transparent: true, opacity: 0.7 })), 2, 5.7, 0));
    g.add(cyl(0.16, 0.9, COLORS.gray, 2, 4.2));
    const stream = cyl(0.09, 1, 0xffa61e, 2, 3, 0, 'y', new THREE.MeshStandardMaterial({ color: 0xffa61e, transparent: true, opacity: 0.85 })); g.add(stream);
    return { group: g, h: { stream } };
  },
  capper() {
    const g = new THREE.Group(); g.add(B(2, 2, 5.2, C.red, 0, 0, 0)); g.add(box(2.6, 0.5, 1, C.red, 1.2, 4.6));
    const head = new THREE.Group(); head.add(cyl(0.12, 1.4, 0, 0, 0.7, 0, 'y', metal)); head.add(box(0.9, 0.35, 0.9, C.yellow, 0, -0.35, 0)); head.position.set(2, 3.9, 0); g.add(head);
    return { group: g, h: { head } };
  },
  lightbarrier(el) {
    const g = new THREE.Group();
    const R = el.params.range;
    const high = el.params.height.startsWith('high');
    g.add(post(high ? 3 : 2)); g.add(at(post(high ? 3 : 2), R + 1, 0, 0));
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.6 });
    const beam = cyl(0.06, R + 1, 0, (R + 1) / 2, high ? 2.75 : 1.75, 0, 'x', mat, 6);
    g.add(beam);
    const l = led(0xffd500, 0, (high ? 3 : 2) + 0.1, 0); g.add(l);
    return { group: g, h: { beam: mat, lamp: l } };
  },
  inductive: () => proxMesh(0x2266ff),
  capacitive: () => proxMesh(0xff9900),
  coloursensor(el) { const m = proxMesh(ITEM_COLORS[el.params.color] ?? 0xffffff); m.group.children[1].scale.setScalar(1.3); return m; },
  limitswitch() {
    const g = new THREE.Group(); g.add(box(0.8, 0.8, 0.8, C.yellow)); g.add(cyl(0.2, 0.3, COLORS.dark, 0.5, 0.6, 0, 'z'));
    const l = led(0x33ff66, 0, 0.9, 0); g.add(l);
    return { group: g, h: { lamp: l } };
  },
  levelswitch: () => gaugeMesh(0xff9900, false),
  leveltx: () => gaugeMesh(C.yellow, true),
  pressure: () => gaugeMesh(0xb0b6bd, true),
  temperature: () => gaugeMesh(0xd04a3a, true),
  encoder() {
    const g = new THREE.Group(); g.add(box(0.7, 0.6, 0.7, COLORS.dark));
    const wheel = cyl(0.35, 0.2, C.orange, 0, 0.75, 0.45, 'z'); g.add(wheel);
    return { group: g, h: { wheel } };
  },
  scale() {
    const g = new THREE.Group(); g.add(box(2, 0.35, 2, COLORS.gray)); g.add(box(1.7, 0.2, 1.7, 0xdfe5ea, 0, 0.35));
    const l = label('0 g', { size: 0.5, bg: 'rgba(20,80,40,0.9)' }); l.position.set(0, 1.7, 1.2); g.add(l);
    return { group: g, h: { label: l } };
  },
  button(el) {
    const g = new THREE.Group(); g.add(box(0.9, 0.8, 0.9, COLORS.black));
    const cap = cyl(0.32, 0.3, col(el.params.color, C.green), 0, 0.95); g.add(cap);
    return { group: g, h: { cap, y0: 0.95 } };
  },
  switch() {
    const g = new THREE.Group(); g.add(box(0.9, 0.8, 0.9, COLORS.black));
    const lever = new THREE.Group(); lever.add(box(0.18, 0.7, 0.18, 0xdddddd, 0, 0, 0)); lever.position.y = 0.8; g.add(lever);
    const l = led(0x33aaff, 0.3, 0.85, 0.3, 0.1); g.add(l);
    return { group: g, h: { lever, lamp: l } };
  },
  estop() {
    const g = new THREE.Group(); g.add(B(2, 2, 0.8, C.yellow, 0, 0, 0, false));
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.75, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), plastic(C.red)); cap.position.y = 0.85; g.add(cap);
    return { group: g, h: { cap, y0: 0.85 } };
  },
  selector() {
    const g = new THREE.Group(); g.add(box(0.9, 0.8, 0.9, COLORS.black));
    const knob = new THREE.Group(); knob.add(cyl(0.3, 0.3, 0xdddddd, 0, 0.15)); knob.add(box(0.5, 0.12, 0.12, C.red, 0.15, 0.3, 0)); knob.position.y = 0.8; g.add(knob);
    return { group: g, h: { knob } };
  },
  potentiometer() {
    const g = new THREE.Group(); g.add(box(0.9, 0.8, 0.9, COLORS.black));
    const knob = new THREE.Group(); knob.add(cyl(0.34, 0.35, C.blue, 0, 0.17)); knob.add(box(0.4, 0.1, 0.1, 0xffffff, 0.15, 0.35, 0)); knob.position.y = 0.8; g.add(knob);
    return { group: g, h: { knob } };
  },
  setpoint() {
    const g = new THREE.Group(); g.add(box(2, 1.6, 0.9, COLORS.dark));
    const l = label('0', { size: 0.6, bg: 'rgba(8,40,24,0.95)', color: '#7dffb0' }); l.position.set(0, 2.3, 0); g.add(l);
    return { group: g, h: { label: l } };
  },
  brick(el) { const g = new THREE.Group(); g.add(at(brick(el.params.w, el.params.d, el.params.h, col(el.params.color)), 0, 0, 0)); return { group: g, h: {} }; },
};

function cylinderMesh(el, color) {
  const g = new THREE.Group();
  g.add(B(2, 2, 1.6, color, 0, 0, 0));
  const rod = cyl(0.18, 1, 0, 1, 1, 0, 'x', metal); g.add(rod);
  const head = box(0.4, 1.3, 1.7, C.orange, 1.2, 0.3, 0); g.add(head);
  return { group: g, h: { rod, head } };
}
function proxMesh(color) {
  const g = new THREE.Group(); g.add(post(1.2)); g.add(cyl(0.28, 0.5, color, 0.45, 0.9, 0, 'x'));
  const l = led(0x33ff66, 0, 1.3, 0); g.add(l);
  return { group: g, h: { lamp: l } };
}
function gaugeMesh(color, analog) {
  const g = new THREE.Group(); g.add(post(1.6)); g.add(cyl(0.45, 0.3, color, 0, 2, 0.2, 'z'));
  const h = {};
  if (analog) { h.label = label('0', { size: 0.45, bg: 'rgba(10,60,120,0.9)' }); h.label.position.set(0, 3.1, 0); g.add(h.label); }
  else { h.lamp = led(0x33ff66, 0, 2.6, 0); g.add(h.lamp); }
  return { group: g, h };
}

const setText = (lab, text) => { if (lab && lab.userData.text !== text) { lab.userData.text = text; lab.userData.setText(text); } };

/** Per-frame update of the moving / glowing parts of an element. */
const UPDATE = {
  conveyor(el, st, h) { const off = ((st.dist % 1) + 1) % 1; h.cleats.forEach((c, i) => { c.position.x = -h.L / 2 + ((i + off) % h.L); }); },
  tank(el, st, h) {
    const f = Math.max(0, Math.min(1, st.vol / el.params.capacity));
    h.water.scale.y = Math.max(0.01, f * 5.4); h.water.position.y = 0.3 + (f * 5.4) / 2;
    const hot = Math.max(0, Math.min(1, (st.temp - 20) / 70));
    h.water.material.color.setRGB(0.17 + hot * 0.7, 0.56 - hot * 0.25, 0.88 - hot * 0.6);
    setText(h.label, `${(f * 100).toFixed(0)} %${st.temp > 25 ? ` · ${st.temp.toFixed(0)} °C` : ''}`);
  },
  drain(el, st, h) { h.jet.visible = st.total > (h.last || 0) + 1e-6; h.last = st.total; },
  motor(el, st, h) { h.fan.rotation.x = st.angle; setText(h.label, st.tripped ? 'OVERLOAD' : `${(st.speed * 1450).toFixed(0)} rpm`); },
  pump(el, st, h) { h.imp.rotation.y = st.angle; },
  valve(el, st, h) { h.wheel.rotation.z = st.pos * Math.PI; h.body.material.color.set(st.pos > 0.5 ? C.green : C.red); },
  cylinder1: (el, st, h) => cylUpdate(el, st, h),
  cylinder2: (el, st, h) => cylUpdate(el, st, h),
  gate(el, st, h) {
    if (h.built !== el.params.reach) { h.arm.clear(); const a = box(el.params.reach, 0.25, 0.25, 0xffffff, el.params.reach / 2, 0, 0); h.arm.add(a); for (let x = 0.5; x < el.params.reach; x += 1) h.arm.add(box(0.5, 0.26, 0.26, C.red, x, 0, 0)); h.built = el.params.reach; }
    h.arm.rotation.z = st.pos * (Math.PI / 2) * 0.95;
  },
  lamp(el, st, h) { h.lamp.userData.set(st.on); },
  horn(el, st, h) { h.ring.visible = st.on; if (st.on) { const k = (st.t * 2.5) % 1; h.ring.scale.setScalar(0.6 + k * 1.2); h.ring.material.opacity = 1 - k; } },
  trafficlight(el, st, h) { h.r.userData.set(st.r); h.y.userData.set(st.y); h.g.userData.set(st.g); },
  elevator(el, st, h) {
    h.car.position.y = st.pos;
    h.doors[0].position.z = -0.7 - st.door * 1.3; h.doors[1].position.z = 0.7 + st.door * 1.3;
    setText(h.ind, String(Math.max(1, Math.min(el.params.floors, Math.round(st.pos / el.params.floorHeight) + 1))));
  },
  mixer(el, st, h) { h.rotor.rotation.y = st.angle; },
  heater(el, st, h) { h.lamp.userData.set(st.on); },
  filler(el, st, h) { h.stream.visible = st.on; h.stream.scale.y = 2.6; h.stream.position.y = 2.5; },
  capper(el, st, h) { h.head.position.y = 3.9 - st.pos * 0.95; },
  lightbarrier(el, st, h) { h.beam.color.set(st.on ? 0x33ff66 : 0xff3030); h.lamp.userData.set(st.on); },
  inductive(el, st, h) { h.lamp.userData.set(st.on); },
  capacitive(el, st, h) { h.lamp.userData.set(st.on); },
  coloursensor(el, st, h) { h.lamp.userData.set(st.on); },
  limitswitch(el, st, h) { h.lamp.userData.set(st.on); },
  levelswitch(el, st, h) { h.lamp.userData.set(st.on); },
  leveltx(el, st, h) { setText(h.label, `${st.v.toFixed(0)} %`); },
  pressure(el, st, h) { setText(h.label, `${st.v.toFixed(2)} bar`); },
  temperature(el, st, h) { setText(h.label, `${st.v.toFixed(0)} °C`); },
  encoder(el, st, h) { h.wheel.rotation.z = -st.pulses * 0.3; },
  scale(el, st, h) { setText(h.label, `${st.v.toFixed(0)} g`); },
  button(el, st, h) { h.cap.position.y = h.y0 - (st.pressed ? 0.14 : 0); },
  switch(el, st, h) { h.lever.rotation.z = st.pressed ? -0.5 : 0.5; h.lamp.userData.set(st.pressed); },
  estop(el, st, h) { h.cap.position.y = h.y0 - (st.pressed ? 0.25 : 0); },
  selector(el, st, h) { h.knob.rotation.y = (1 - st.position) * 0.8; },
  potentiometer(el, st, h) { h.knob.rotation.y = 2.2 - (st.value / 100) * 4.4; },
  setpoint(el, st, h) { setText(h.label, `${el.params.value}${el.params.unit ? ' ' + el.params.unit : ''}`); },
};
function cylUpdate(el, st, h) {
  const d = st.pos * el.params.stroke;
  h.head.position.x = 1.2 + d;
  h.rod.scale.y = Math.max(0.05, 0.4 + d); h.rod.position.x = 1 + d / 2;
}

/** Mesh for an element. Types defined by the user (variants) use the look of their base type or a custom look. */
export function buildElementMesh(el) {
  const def = KIT[el.type];
  const kind = def.base || el.type;
  let built;
  if (def.look) built = customLook(el, def.look);
  else built = (BUILD[kind] || BUILD.brick)(el);
  built.kind = kind;
  built.group.userData.elId = el.id;
  return built;
}

/** Simple configurable look for user-defined element types: a shape in two colours. */
function customLook(el, look) {
  const [w, d] = sizeOf(el);
  const hgt = Math.max(0.6, look.h || heightOf(el));
  const g = new THREE.Group();
  const main = col(look.color, C.blue);
  const acc = col(look.accent, C.yellow);
  if (look.shape === 'post') { g.add(box(Math.min(w, 0.9), hgt, Math.min(d, 0.9), main)); g.add(cyl(0.35, 0.4, acc, 0, hgt + 0.2)); }
  else if (look.shape === 'cylinder') { g.add(cyl(Math.min(w, d) / 2, hgt, main, 0, hgt / 2)); g.add(cyl(Math.min(w, d) / 2.6, 0.3, acc, 0, hgt + 0.15)); }
  else if (look.shape === 'pad') { g.add(box(w, 0.4, d, main)); g.add(box(w * 0.7, 0.15, d * 0.7, acc, 0, 0.4)); }
  else { g.add(B(w, d, hgt, main)); g.add(box(w * 0.5, 0.3, d * 0.5, acc, 0, Math.round(hgt / PLATE) * PLATE + 0.2)); }
  const l = lampMesh(0x33ff66, { r: 0.2, h: 0.2 }); l.position.set(0, hgt + 0.7, 0); g.add(l);
  return { group: g, h: { lamp: l, custom: true } };
}

export function updateElementMesh(el, st, built, sim) {
  if (built.h.custom) { built.h.lamp.userData.set(!!(st.on || st.pressed || st.v > 0 || st.pos > 0.5)); return; }
  const fn = UPDATE[built.kind];
  if (fn && st) fn(el, st, built.h, sim);
}

/** Signature of everything that changes the static shape of an element. */
export const meshSignature = (el) => `${el.type}|${JSON.stringify(el.params)}`;

// ---- workpieces ---------------------------------------------------------------------------
const bottleGlass = new THREE.MeshStandardMaterial({ color: 0x9fe3b0, transparent: true, opacity: 0.38, roughness: 0.05, depthWrite: false });
const liquid = new THREE.MeshStandardMaterial({ color: 0xffa61e, roughness: 0.2 });
const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });

export function buildItemMesh(it) {
  const g = new THREE.Group();
  const color = ITEM_COLORS[it.color] ?? 0xcccccc;
  if (it.kind === 'bottle') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.5, 16), bottleGlass); body.position.y = 0.75; g.add(body);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.45, 0.6, 12), bottleGlass); neck.position.y = 1.8; g.add(neck);
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 1, 14), liquid); fill.visible = false; g.add(fill);
    const cap = cyl(0.25, 0.2, C.red, 0, 2.2); cap.visible = false; g.add(cap);
    g.userData = { fill, cap };
  } else if (it.kind === 'car') {
    g.add(box(3, 0.7, 1.8, color, 0, 0.3)); g.add(box(1.5, 0.7, 1.6, 0xf4f4f4, -0.3, 1.0));
    for (const [x, z] of [[-1, 0.9], [1, 0.9], [-1, -0.9], [1, -0.9]]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12), tyre); w.rotation.x = Math.PI / 2; w.position.set(x, 0.4, z); g.add(w); }
  } else {
    const m = it.material === 'metal' ? new THREE.MeshStandardMaterial({ color, metalness: 0.75, roughness: 0.3 }) : plastic(color);
    g.add(at(brick(Math.max(1, Math.round(it.len)), Math.max(1, Math.round(it.wid)), Math.round(it.h / PLATE), color, { material: m }), 0, 0, 0));
    g.children[0].scale.set(it.len / Math.max(1, Math.round(it.len)), 1, it.wid / Math.max(1, Math.round(it.wid)));
  }
  return g;
}

export function updateItemMesh(it, g) {
  g.position.set(it.x, it.y, it.z);
  g.rotation.y = Math.atan2(-it.hz, it.hx) + (it.crashed ? 0.5 : 0);
  if (it.kind === 'bottle') {
    const { fill, cap } = g.userData;
    fill.visible = it.fill > 1;
    const hgt = (Math.min(100, it.fill) / 100) * 1.45;
    fill.scale.y = Math.max(0.01, hgt); fill.position.y = 0.03 + hgt / 2;
    cap.visible = !!it.capped;
  }
}

export { RAW };
