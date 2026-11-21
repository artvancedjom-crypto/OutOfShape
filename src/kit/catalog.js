// Custom kit elements, stored in the same catalog system as circuit parts
// (IndexedDB store "catalog", same JSON exchange format):
//   kit-variant  a new sensor/actuator type: a behaviour class (an existing element
//                type) with its own name, parameter defaults, tag prefix and look
//   kit-group    several placed elements saved as one building block
//                (for example "sorting station" = conveyor + light barrier + cylinder)
import { db } from '../core/db.js';
import { registerEntryKind, ensureCatalog, saveEntry, listEntries, exportEntries, newEntryId } from '../circuits/catalog.js';
import { KIT, registerKitType, defaultKitParams } from './elements.js';
import { footprint } from './sim.js';
import { sid, allocateIO, nextKitName, snapToGrid } from './model.js';

const BUILTIN = new Set(Object.keys(KIT));
export const isBuiltinKit = (type) => BUILTIN.has(type);
export const GROUPS = new Map();
export const LOOK_SHAPES = ['block', 'post', 'cylinder', 'pad'];
export const LOOK_COLORS = ['blue', 'red', 'yellow', 'green', 'orange', 'white', 'black', 'gray', 'azure', 'purple'];

function variantDef(e) {
  const base = KIT[e.base];
  return {
    ...base,
    name: e.name,
    cat: e.category || base.cat,
    tag: e.tag || base.tag,
    params: base.params.map((p) => (e.params && e.params[p.key] !== undefined ? { ...p, def: e.params[p.key] } : p)),
    base: e.base,
    look: e.look || null,
    entry: e,
  };
}

registerEntryKind('kit-variant', {
  validate(e) {
    if (!BUILTIN.has(e.base)) throw new Error(`"${e.name}" uses the unknown behaviour class "${e.base}".`);
    if (e.tag && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.tag)) throw new Error(`"${e.name}": the tag prefix may only contain letters, digits and _.`);
    const base = KIT[e.base];
    for (const [k, v] of Object.entries(e.params || {})) {
      const prm = base.params.find((p) => p.key === k);
      if (!prm) throw new Error(`"${e.name}": ${base.name} has no parameter "${k}".`);
      if (!prm.type && (typeof v !== 'number' || Number.isNaN(v))) throw new Error(`"${e.name}": ${prm.label} must be a number.`);
      if (!prm.type && ((prm.min !== undefined && v < prm.min) || (prm.max !== undefined && v > prm.max))) throw new Error(`"${e.name}": ${prm.label} must be between ${prm.min} and ${prm.max}.`);
      if (prm.type === 'select' && !prm.options.includes(v)) throw new Error(`"${e.name}": ${prm.label} cannot be "${v}".`);
    }
    if (e.look && !LOOK_SHAPES.includes(e.look.shape)) throw new Error(`"${e.name}": unknown shape.`);
  },
  register(e) { registerKitType(e.id, variantDef(e)); },
});

registerEntryKind('kit-group', {
  validate(e) {
    if (!Array.isArray(e.elements) || !e.elements.length) throw new Error(`"${e.name}" contains no elements.`);
    for (const el of e.elements) {
      if (!BUILTIN.has(el.type) && !(e.defs && e.defs[el.type])) throw new Error(`"${e.name}" uses the unknown element type "${el.type}".`);
    }
  },
  register(e) {
    for (const d of Object.values(e.defs || {})) if (!KIT[d.id]) registerKitType(d.id, variantDef(d));
    GROUPS.set(e.id, e);
  },
  requires: (e) => Object.values(e.defs || {}),
});

export const ensureKitCatalog = ensureCatalog;
export const isKitEntry = (e) => e.kind === 'kit-variant' || e.kind === 'kit-group';
export const listKitEntries = async () => (await listEntries()).filter(isKitEntry);
export const exportKitEntries = exportEntries;

export async function saveKitEntry(entry) {
  return saveEntry({ ...entry, id: entry.id || newEntryId() });
}

export async function deleteKitEntry(entry) {
  await db.del('catalog', entry.id);
  if (entry.kind === 'kit-group') GROUPS.delete(entry.id);
  else if (KIT[entry.id]) KIT[entry.id] = { ...KIT[entry.id], removed: true }; // scenes that are open keep working
}

/** Custom element types used by a scene: they travel inside the scene file. */
export function kitDefsUsedBy(doc) {
  const out = {};
  for (const el of doc.elements || []) { const d = KIT[el.type]; if (d && d.entry) out[el.type] = d.entry; }
  return out;
}

export function registerSceneDefs(doc) {
  for (const e of Object.values((doc && doc.defs) || {})) {
    if (!KIT[e.id]) { try { registerKitType(e.id, variantDef(e)); } catch (err) { console.warn(err.message); } }
  }
}

/** Selected elements → a reusable group (positions relative to the group's centre). */
export function makeGroupEntry(name, elements, description = '') {
  let x1 = Infinity; let z1 = Infinity; let x2 = -Infinity; let z2 = -Infinity;
  for (const el of elements) { const r = footprint(el); x1 = Math.min(x1, r.x1); z1 = Math.min(z1, r.z1); x2 = Math.max(x2, r.x2); z2 = Math.max(z2, r.z2); }
  const cx = Math.round((x1 + x2) / 2); const cz = Math.round((z1 + z2) / 2);
  const defs = {};
  for (const el of elements) { const d = KIT[el.type]; if (d.entry) defs[el.type] = d.entry; }
  return {
    kind: 'kit-group', name, description, defs, size: [x2 - x1, z2 - z1],
    elements: elements.map((el) => ({ type: el.type, base: el.name.replace(/\d+$/, ''), dx: el.x - cx, dz: el.z - cz, y: el.y || 0, rot: el.rot || 0, params: JSON.parse(JSON.stringify(el.params)) })),
  };
}

/** Elements of a group at a position, with fresh names (not yet added to the document). */
export function instantiateGroup(doc, entry, x, z, rot = 0) {
  const made = [];
  const scratch = { elements: [...doc.elements] };
  for (const g of entry.elements) {
    let dx = g.dx; let dz = g.dz;
    for (let k = 0; k < rot % 4; k++) [dx, dz] = [-dz, dx];
    const el = { id: sid('e'), type: g.type, name: nextKitName(scratch, g.type), x: x + dx, z: z + dz, y: g.y || 0, rot: ((g.rot || 0) + rot) % 4, params: { ...defaultKitParams(g.type), ...g.params }, io: {}, fault: '' };
    [el.x, el.z] = snapToGrid(el, el.x, el.z);
    scratch.elements.push(el);
    made.push(el);
  }
  return made;
}

export function addGroup(doc, entry, x, z, rot = 0) {
  const made = instantiateGroup(doc, entry, x, z, rot);
  doc.elements.push(...made);
  allocateIO(doc);
  return made;
}
