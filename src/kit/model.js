// Scene document for the PLC construction kit, with plug-and-play I/O:
// every placed sensor/actuator gets the next free address and a symbolic tag.
//
//   scene   { schema, kind:'scene', id, name, templateId, elements[], program{lang,source,name}, notes }
//   element { id, type, name, x, z, y, rot, params{}, io{ key: {tag, addr} }, fault }
import { defineSchema, migrate, schemaVersion } from '../core/schema.js';
import { KIT, defaultKitParams, sizeOf, heightOf } from './elements.js';
import { footprint } from './sim.js';

defineSchema('scene', 1, []);

let seq = 0;
export const sid = (p = 'e') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newScene(name = 'Untitled plant') {
  return { schema: schemaVersion('scene'), kind: 'scene', id: sid('s_'), name, templateId: null, elements: [], program: { name: 'Main', lang: 'ST', source: '(* Your program. Tags appear here as soon as you place sensors and actuators. *)\n' }, created: Date.now(), updated: Date.now() };
}

export function loadScene(obj) {
  const d = migrate('scene', JSON.parse(JSON.stringify(obj)));
  d.elements = (d.elements || []).filter((e) => KIT[e.type]);
  for (const e of d.elements) { e.params = { ...defaultKitParams(e.type), ...(e.params || {}) }; e.io = e.io || {}; e.y = e.y || 0; e.rot = e.rot || 0; }
  d.program = d.program || { name: 'Main', lang: 'ST', source: '' };
  allocateIO(d);
  return d;
}

// ---- addresses ---------------------------------------------------------------------
const CLASS = (p) => (p.type === 'BOOL' ? (p.dir === 'in' ? 'I' : 'Q') : p.dir === 'in' ? 'IW' : 'QW');
const ADDR_RE = { I: /^%I(\d+)\.([0-7])$/, Q: /^%Q(\d+)\.([0-7])$/, IW: /^%IW(\d+)$/, QW: /^%QW(\d+)$/ };

export function addressClass(addr) {
  for (const [k, re] of Object.entries(ADDR_RE)) if (re.test(addr)) return k;
  return null;
}

/** Sort key so addresses list in natural order. */
export function addressOrder(addr) {
  const m = /^%([IQ])(W?)(\d+)(?:\.(\d))?$/.exec(addr || '');
  if (!m) return 1e9;
  return (m[1] === 'I' ? 0 : 1e6) + (m[2] ? 5e5 : 0) + (+m[3]) * 8 + (+(m[4] || 0));
}

function nextFree(cls, used) {
  if (cls === 'I' || cls === 'Q') {
    for (let n = 0; ; n++) { const a = `%${cls}${Math.floor(n / 8)}.${n % 8}`; if (!used.has(a)) return a; }
  }
  for (let n = 64; ; n += 2) { const a = `%${cls}${n}`; if (!used.has(a)) return a; } // analog words start at 64, like on real racks
}

export const TAG_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['IF', 'THEN', 'ELSE', 'ELSIF', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'VAR', 'END_VAR', 'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE', 'PROGRAM', 'END_PROGRAM', 'EXIT', 'RETURN', 'TON', 'TOF', 'TP', 'CTU', 'CTD', 'CTUD', 'R_TRIG', 'F_TRIG', 'SR', 'RS', 'BOOL', 'INT', 'REAL', 'TIME']);

export function tagProblem(doc, tag, exceptEl = null, exceptKey = null) {
  if (!TAG_RE.test(tag)) return 'Use letters, digits and _ and start with a letter (for example Motor1_Run).';
  if (RESERVED.has(tag.toUpperCase())) return `"${tag}" is a keyword of the programming language.`;
  for (const el of doc.elements) for (const [k, p] of Object.entries(el.io || {})) {
    if (el === exceptEl && k === exceptKey) continue;
    if (p.tag.toUpperCase() === tag.toUpperCase()) return `"${tag}" is already used by ${el.name}.`;
  }
  return null;
}

export function addressProblem(doc, addr, point, exceptEl, exceptKey) {
  const cls = addressClass(addr);
  const need = CLASS(point);
  if (!cls) return 'Not an address. Examples: %I0.3, %Q1.0, %IW64, %QW66.';
  if (cls !== need) return `This signal needs a %${need} address (${point.type === 'BOOL' ? 'bit' : 'word'} ${point.dir === 'in' ? 'input' : 'output'}).`;
  for (const el of doc.elements) for (const [k, p] of Object.entries(el.io || {})) {
    if (el === exceptEl && k === exceptKey) continue;
    if (p.addr === addr) return `${addr} is already used by ${p.tag}.`;
  }
  return null;
}

/**
 * Give every I/O point of every element a tag and an address; drop assignments
 * of points that no longer exist (e.g. after a parameter change). Existing
 * assignments are never changed.
 */
export function allocateIO(doc) {
  const usedAddr = new Set();
  const usedTag = new Set();
  for (const el of doc.elements) {
    const keys = new Set(KIT[el.type].io(el).map((p) => p.key));
    el.io = el.io || {};
    for (const k of Object.keys(el.io)) if (!keys.has(k)) delete el.io[k];
    for (const p of Object.values(el.io)) { if (p.addr) usedAddr.add(p.addr); usedTag.add(p.tag.toUpperCase()); }
  }
  for (const el of doc.elements) {
    for (const p of KIT[el.type].io(el)) {
      const cur = el.io[p.key] || (el.io[p.key] = {});
      if (!cur.tag) {
        let tag = `${el.name}${p.suffix}`;
        for (let n = 2; usedTag.has(tag.toUpperCase()) || RESERVED.has(tag.toUpperCase()); n++) tag = `${el.name}${p.suffix}_${n}`;
        cur.tag = tag;
        usedTag.add(tag.toUpperCase());
      }
      if (!cur.addr || addressClass(cur.addr) !== CLASS(p)) {
        cur.addr = nextFree(CLASS(p), usedAddr);
        usedAddr.add(cur.addr);
      }
    }
  }
  return doc;
}

/** Flat I/O list in address order: what the PLC sees. */
export function ioList(doc) {
  const rows = [];
  for (const el of doc.elements) {
    for (const p of KIT[el.type].io(el)) {
      const a = el.io[p.key];
      if (a) rows.push({ el, key: p.key, name: a.tag, addr: a.addr, type: p.type, dir: p.dir, label: p.label, desc: `${el.name}: ${p.label}` });
    }
  }
  rows.sort((x, y) => addressOrder(x.addr) - addressOrder(y.addr));
  return rows;
}

export const plcIo = (doc) => { const rows = ioList(doc); return { inputs: rows.filter((r) => r.dir === 'in'), outputs: rows.filter((r) => r.dir === 'out') }; };

/** Rename a tag everywhere: mapping and program (ST text or ladder addresses). */
export function renameTag(doc, el, key, tag) {
  const old = el.io[key].tag;
  el.io[key].tag = tag;
  const re = new RegExp(`\\b${old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const prog = doc.program;
  if (prog.lang === 'ST' && typeof prog.source === 'string') prog.source = prog.source.replace(re, tag);
  else if (prog.source && prog.source.rungs) {
    for (const r of prog.source.rungs) {
      for (const br of r.branches) for (const c of br) if (c.var) c.var = c.var.replace(re, tag);
      for (const k of ['var', 'reset']) if (r.out[k]) r.out[k] = String(r.out[k]).replace(re, tag);
    }
  }
}

// ---- placing ------------------------------------------------------------------------
/** Next free element name for a type: Conv1, Conv2, … */
export function nextKitName(doc, type) {
  const base = KIT[type].tag;
  const used = new Set(doc.elements.map((e) => e.name));
  for (let i = 1; ; i++) if (!used.has(base + i)) return base + i;
}

/** Snap so the element's edges lie on the stud grid. */
export function snapToGrid(el, x, z) {
  const r = footprint({ ...el, x: 0, z: 0 });
  const w = r.x2 - r.x1; const d = r.z2 - r.z1;
  return [Math.round(x - w / 2) + w / 2, Math.round(z - d / 2) + d / 2];
}

/**
 * Where can this element stand? Returns {ok, y}: on the plate (y = 0) if the
 * cells are free, on top of bricks if it rests completely on stackable elements.
 */
export function placement(doc, el, limit = 32) {
  const r = footprint(el);
  if (r.x1 < -limit || r.x2 > limit || r.z1 < -limit || r.z2 > limit) return { ok: false, y: 0, why: 'outside the baseplate' };
  const under = doc.elements.filter((o) => o.id !== el.id && footprint(o).x1 < r.x2 - 0.01 && footprint(o).x2 > r.x1 + 0.01 && footprint(o).z1 < r.z2 - 0.01 && footprint(o).z2 > r.z1 + 0.01);
  if (!under.length) return { ok: true, y: 0 };
  if (under.some((o) => !KIT[o.type].stackable)) return { ok: false, y: 0, why: 'the space is taken' };
  // stand on the highest brick below; everything below must be bricks covering the footprint
  const top = Math.max(...under.map((o) => (o.y || 0) + heightOf(o)));
  let area = 0;
  for (const o of under) {
    if (Math.abs((o.y || 0) + heightOf(o) - top) > 0.01) continue;
    const f = footprint(o);
    area += Math.max(0, Math.min(f.x2, r.x2) - Math.max(f.x1, r.x1)) * Math.max(0, Math.min(f.z2, r.z2) - Math.max(f.z1, r.z1));
  }
  const full = (r.x2 - r.x1) * (r.z2 - r.z1);
  if (area < full * 0.5) return { ok: false, y: top, why: 'not enough support underneath' };
  return { ok: true, y: Math.round(top * 100) / 100 };
}

export function makeElement(doc, type, x, z, rot = 0, params = {}) {
  const el = { id: sid('e'), type, name: nextKitName(doc, type), x: 0, z: 0, y: 0, rot, params: { ...defaultKitParams(type), ...params }, io: {}, fault: '' };
  [el.x, el.z] = snapToGrid(el, x, z);
  return el;
}

/** Add an element and give it I/O. Returns the element. */
export function addElement(doc, type, x, z, rot = 0, params = {}, extra = {}) {
  const el = Object.assign(makeElement(doc, type, x, z, rot, params), extra);
  doc.elements.push(el);
  allocateIO(doc);
  return el;
}

export { sizeOf, heightOf };
