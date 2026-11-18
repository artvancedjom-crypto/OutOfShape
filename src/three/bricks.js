// Toy-brick geometry kit: chunky, studded, glossy-plastic parts.
// Units: 1 stud pitch = 1 unit, plate height = 0.4, brick height = 1.2.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const PLATE = 0.4;
export const BRICK = 1.2;
export const COLORS = {
  red: 0xd01712, blue: 0x0055bf, yellow: 0xf2cd37, green: 0x237841, lime: 0xbbe90b, white: 0xf4f4f4,
  black: 0x1b2a34, gray: 0xa0a5a9, dark: 0x6c6e68, orange: 0xfe8a18, tan: 0xe4cd9e, brown: 0x583927,
  azure: 0x36aebf, pink: 0xfc97ac, purple: 0x81007b, road: 0x3a3f45, water: 0x2b8fe0,
};

const geoCache = new Map();
const matCache = new Map();

export function plastic(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.0, ...opts }));
  }
  return matCache.get(key);
}

function studGeo() {
  if (!geoCache.has('stud')) {
    const g = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 14);
    geoCache.set('stud', g);
  }
  return geoCache.get('stud');
}

/** Rectangular brick geometry w x d studs, h in plate units (3 = one brick). */
export function brickGeometry(w, d, h = 3, studs = true) {
  const key = `b${w}x${d}x${h}${studs ? 's' : ''}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const H = h * PLATE;
  const parts = [];
  const box = new THREE.BoxGeometry(w - 0.04, H - 0.02, d - 0.04);
  box.translate(0, H / 2, 0);
  parts.push(box);
  if (studs) {
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < d; j++) {
        const s = studGeo().clone();
        s.translate(i - (w - 1) / 2, H + 0.1, j - (d - 1) / 2);
        parts.push(s);
      }
    }
  }
  const g = mergeGeometries(parts.map((p) => p.toNonIndexed()));
  g.computeVertexNormals();
  geoCache.set(key, g);
  return g;
}

/** A brick mesh whose origin is at the bottom centre. */
export function brick(w, d, h = 3, color = COLORS.red, { studs = true, material } = {}) {
  const m = new THREE.Mesh(brickGeometry(w, d, h, studs), material || plastic(color));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function tile(w, d, color, h = 1) {
  return brick(w, d, h, color, { studs: false });
}

export function round(r, h, color, segments = 24, studs = true) {
  const g = new THREE.Group();
  const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segments), plastic(color));
  c.position.y = h / 2;
  c.castShadow = c.receiveShadow = true;
  g.add(c);
  if (studs) {
    const s = new THREE.Mesh(studGeo(), plastic(color));
    s.position.y = h + 0.1;
    g.add(s);
  }
  return g;
}

/** Place an object at stud coordinates (x,z) and plate height y. */
export function at(obj, x, y, z) {
  obj.position.set(x, y, z);
  return obj;
}

/** Text label sprite (always faces camera). */
export function label(text, { color = '#ffffff', bg = 'rgba(20,24,32,0.82)', size = 1, font = 'bold 44px Inter, system-ui, sans-serif' } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36;
  canvas.width = w;
  canvas.height = 72;
  ctx.font = font;
  ctx.fillStyle = bg;
  const r = 18;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 72, r);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 18, 38);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sp.scale.set((w / 72) * 0.9 * size, 0.9 * size, 1);
  sp.userData.setText = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, 72, r);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.fillText(t, 18, 38);
    tex.needsUpdate = true;
  };
  return sp;
}

/** Signal lamp: a round 1x1 brick that glows when on. */
export function lamp(color, { r = 0.45, h = 0.6 } = {}) {
  const off = new THREE.Color(color).multiplyScalar(0.25);
  const mat = new THREE.MeshStandardMaterial({ color: off, roughness: 0.2, emissive: color, emissiveIntensity: 0 });
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat);
  m.castShadow = true;
  const g = new THREE.Group();
  g.add(m);
  m.position.y = h / 2;
  g.userData.set = (on) => {
    mat.emissiveIntensity = on ? 2.2 : 0;
    mat.color.copy(on ? new THREE.Color(color) : off);
  };
  g.userData.mesh = m;
  return g;
}

/** Push button (cap on a 2x2 housing) – returns {group, cap, press(on)}. */
export function pushButton(capColor, { housing = COLORS.black, mushroom = false } = {}) {
  const g = new THREE.Group();
  const base = brick(2, 2, 2, housing, { studs: false });
  g.add(base);
  const capGeo = mushroom ? new THREE.SphereGeometry(0.85, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2) : new THREE.CylinderGeometry(0.6, 0.6, 0.35, 24);
  const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ color: capColor, roughness: 0.25, emissive: capColor, emissiveIntensity: 0 }));
  cap.position.y = 2 * PLATE + (mushroom ? 0.05 : 0.18);
  cap.castShadow = true;
  g.add(cap);
  const y0 = cap.position.y;
  g.userData.cap = cap;
  g.userData.press = (on) => { cap.position.y = on ? y0 - 0.14 : y0; };
  g.userData.hover = (on) => { cap.material.emissiveIntensity = on ? 0.35 : 0; };
  return g;
}

/** Brick tree for decoration. */
export function tree(x, z, s = 1) {
  const g = new THREE.Group();
  g.add(at(round(0.5 * s, 2.4 * s, COLORS.brown, 12, false), 0, 0, 0));
  const leaves = [[3, 2.4], [2.4, 3.4], [1.6, 4.3], [0.9, 5.0]];
  for (const [r, y] of leaves) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55 * s, r * s, 1.1 * s, 8), plastic(COLORS.green));
    c.position.y = y * s;
    c.castShadow = true;
    g.add(c);
  }
  g.position.set(x, 0, z);
  return g;
}

/** Simple minifig-like figure for scale. */
export function figure(x, z, shirt = COLORS.red, rot = 0) {
  const g = new THREE.Group();
  const legs = brick(2, 1, 4, COLORS.blue, { studs: false });
  g.add(legs);
  const torso = brick(2, 1, 4, shirt, { studs: false });
  torso.position.y = 1.6;
  g.add(torso);
  const head = round(0.55, 1.0, COLORS.yellow, 18);
  head.position.y = 3.2;
  g.add(head);
  g.position.set(x, 0, z);
  g.rotation.y = rot;
  g.scale.setScalar(0.9);
  return g;
}
