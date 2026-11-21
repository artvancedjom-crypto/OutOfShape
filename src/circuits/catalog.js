// Component catalog: the built-in part definitions plus user-defined entries.
//
// Two kinds of user entries, both stored in the app's data folder (IndexedDB store
// "catalog") and exchangeable as JSON:
//   variant     an existing model with its own name and parameter defaults
//               (e.g. a specific LED from a datasheet, a transistor with its hFE)
//   subcircuit  a small circuit saved as one part with a box symbol and outer pins
//
// Circuits that use custom parts carry a copy of the definitions (doc.defs), so an
// exported circuit still opens on a machine that does not have the catalog entry.
import { db } from '../core/db.js';
import { defineSchema, migrate, schemaVersion } from '../core/schema.js';
import { PARTS, registerPart, CATEGORY_ORDER } from './parts.js';
import { Circuit, diodeParams } from './mna.js';
import { nid } from './model.js';

defineSchema('catalogEntry', 1, []);
const VT = 0.025852;
const BUILTIN = new Set(Object.keys(PARTS));

export const isBuiltin = (type) => BUILTIN.has(type);
export const isUserType = (type) => !!(PARTS[type] && PARTS[type].entry);

/** One-line description of the simulation model behind each built-in part. */
export const MODEL_INFO = {
  GND: 'Reference node (0 V)',
  R: 'Linear resistor, I = U / R',
  C: 'Linear capacitor, I = C·dU/dt (backward Euler)',
  L: 'Linear inductor, U = L·dI/dt (backward Euler)',
  POT: 'Two resistors that share the total resistance',
  V: 'Ideal voltage source (DC, sine or square)',
  I: 'Ideal current source',
  D: 'Shockley diode, I = Is·(e^(U/(n·Vt)) − 1)',
  LED: 'Shockley diode with colour-specific Is and n; brightness from current',
  NPN: 'Ebers–Moll transport model',
  PNP: 'Ebers–Moll transport model (mirrored)',
  NMOS: 'Square-law MOSFET (cut-off, linear, saturation)',
  PMOS: 'Square-law MOSFET (mirrored)',
  SW: 'Ideal switch (1 mΩ closed, 1 GΩ open)',
  PB: 'Momentary switch, closed while pressed',
  PBNC: 'Momentary switch, open while pressed',
  SPDT: 'Two ideal switches with a common pole',
  RELAY: 'Coil resistance with pull-in / drop-out hysteresis; drives linked contacts',
  CONTACT_NO: 'Contact of a relay, closed while the relay is energised',
  CONTACT_NC: 'Contact of a relay, open while the relay is energised',
  LAMP: 'Resistor with brightness from power; optional cold-filament resistance',
  FUSE: 'Small resistance that opens when I²t exceeds the rating',
  MOTOR: 'Armature resistance + back-EMF, rotor inertia and friction',
  AMMETER: 'Ideal ammeter (0 V drop)',
  VOLTMETER: 'Voltmeter with 10 MΩ input resistance',
};

// ---------------------------------------------------------------------------------
// Definitions from entries
// ---------------------------------------------------------------------------------
function variantDef(entry) {
  const base = PARTS[entry.base];
  if (!base || base.entry) throw new Error(`Unknown base model "${entry.base}"`);
  return {
    ...base,
    name: entry.name,
    category: entry.category || base.category,
    params: base.params.map((p) => (entry.params && entry.params[p.key] !== undefined ? { ...p, def: entry.params[p.key] } : p)),
    entry,
  };
}

/** Pin layout of a subcircuit box: left pins top-down at x = -(w/2+1), right pins at x = w/2+1. */
export function subcircuitLayout(entry) {
  const left = entry.pins.filter((p) => p.side !== 'right');
  const right = entry.pins.filter((p) => p.side === 'right');
  const rows = Math.max(left.length, right.length, 1);
  const w = Math.max(4, 2 * Math.ceil((entry.width || 4) / 2));
  const top = -(rows - 1);
  const place = (list, x) => list.map((p, k) => ({ name: p.name, x, y: top + 2 * k }));
  // keep the order of entry.pins: the netlist maps pins by index
  const pos = new Map([...place(left, -(w / 2 + 1)), ...place(right, w / 2 + 1)].map((p) => [p.name, p]));
  return { w, rows, top, pins: entry.pins.map((p) => pos.get(p.name)) };
}

function subcircuitDef(entry) {
  const lay = subcircuitLayout(entry);
  const hw = (lay.w / 2) * 20;
  const y1 = (lay.top - 1) * 20;
  const hgt = (lay.rows * 2) * 20;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return {
    name: entry.name,
    category: entry.category || 'Passive',
    prefix: entry.prefix || 'X',
    pins: lay.pins,
    params: [],
    bbox: [-(lay.w / 2 + 1), lay.top - 1, lay.w / 2 + 1, lay.top - 1 + lay.rows * 2],
    subcircuit: entry,
    entry,
    symbol: () => {
      let s = `<rect x="${-hw}" y="${y1}" width="${2 * hw}" height="${hgt}" rx="6" class="bg" style="fill:${entry.color || ''}"/>`;
      for (const p of lay.pins) {
        const left = p.x < 0;
        s += `<line x1="${p.x * 20}" y1="${p.y * 20}" x2="${left ? -hw : hw}" y2="${p.y * 20}"/>`;
        s += `<text x="${left ? -hw + 6 : hw - 6}" y="${p.y * 20 + 4}" class="sym-t" style="text-anchor:${left ? 'start' : 'end'}">${esc(p.name)}</text>`;
      }
      s += `<text x="0" y="${y1 + 14}" class="sym-t" style="font-weight:700">${esc(entry.abbr || entry.name).slice(0, 14)}</text>`;
      return s;
    },
    model: () => [], // expanded by the netlist builder
  };
}

export function entryToDef(entry) {
  return entry.kind === 'subcircuit' ? subcircuitDef(entry) : variantDef(entry);
}

// Other parts of the app (the PLC kit) keep their own entries in the same catalog
// store and JSON files; they plug in here with a validator and a register function.
const EXTRA_KINDS = {};
export function registerEntryKind(kind, handler) { EXTRA_KINDS[kind] = handler; }
const kindOrder = () => ['variant', 'subcircuit', ...Object.keys(EXTRA_KINDS)];
export const isCircuitEntry = (e) => e.kind === 'variant' || e.kind === 'subcircuit';

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Not a catalog entry.');
  if (!kindOrder().includes(entry.kind)) throw new Error(`Unknown entry kind "${entry.kind}".`);
  if (!entry.name || !String(entry.name).trim()) throw new Error('The entry has no name.');
  if (EXTRA_KINDS[entry.kind]) { EXTRA_KINDS[entry.kind].validate(entry); return entry; }
  if (entry.kind === 'variant') {
    if (!BUILTIN.has(entry.base)) throw new Error(`"${entry.name}" is based on the unknown model "${entry.base}".`);
    const base = PARTS[entry.base];
    for (const [k, v] of Object.entries(entry.params || {})) {
      const prm = base.params.find((p) => p.key === k);
      if (!prm) throw new Error(`"${entry.name}": the model ${entry.base} has no parameter "${k}".`);
      if (!prm.type && (typeof v !== 'number' || Number.isNaN(v))) throw new Error(`"${entry.name}": ${k} must be a number.`);
      if (prm.min !== undefined && v < prm.min) throw new Error(`"${entry.name}": ${k} is below the minimum.`);
    }
  } else {
    if (!Array.isArray(entry.pins) || !entry.pins.length) throw new Error(`"${entry.name}" has no outer pins.`);
    if (!entry.circuit || !Array.isArray(entry.circuit.parts)) throw new Error(`"${entry.name}" contains no circuit.`);
    if (new Set(entry.pins.map((p) => p.name)).size !== entry.pins.length) throw new Error(`"${entry.name}": pin names must be unique.`);
  }
  return entry;
}

/** Make a type available to the editor and solver. */
export function registerEntry(entry) {
  const e = migrate('catalogEntry', entry);
  validateEntry(e);
  if (EXTRA_KINDS[e.kind]) EXTRA_KINDS[e.kind].register(e);
  else registerPart(e.id, entryToDef(e));
  return e;
}

// ---------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------
let loaded = null;
/** Load all user entries into the registry (once per session). */
export function ensureCatalog() {
  if (!loaded) {
    loaded = db.all('catalog').then((rows) => {
      // variants first, then subcircuits (which may contain variants)
      for (const kind of kindOrder()) {
        for (const row of rows.filter((r) => r.kind === kind)) {
          try { registerEntry(row); } catch (e) { console.warn('Catalog entry skipped:', e.message); }
        }
      }
    }).catch((e) => { console.warn('Catalog could not be loaded:', e); });
  }
  return loaded;
}

export function newEntryId() {
  return nid('u_');
}

export async function saveEntry(entry) {
  const e = { schema: schemaVersion('catalogEntry'), created: Date.now(), ...entry, updated: Date.now() };
  if (!e.id) e.id = newEntryId();
  registerEntry(e);
  await db.put('catalog', JSON.parse(JSON.stringify(e)));
  return e;
}

export async function deleteEntry(id) {
  await db.del('catalog', id);
  // keep the definition registered for this session: open circuits may still use it
  if (PARTS[id]) PARTS[id] = { ...PARTS[id], removed: true };
}

export const listEntries = () => db.all('catalog');

/** Catalog entries (and, for subcircuits, their inner custom parts) used by a circuit. */
export function defsUsedBy(doc) {
  const out = {};
  const visit = (parts) => {
    for (const p of parts) {
      const def = PARTS[p.type];
      if (!def || !def.entry || out[p.type]) continue;
      out[p.type] = def.entry;
      if (def.subcircuit) visit(def.subcircuit.circuit.parts);
    }
  };
  visit(doc.parts || []);
  return out;
}

/** Register definitions that travel inside a circuit file but are missing here. */
export function registerDocDefs(doc) {
  const defs = (doc && doc.defs) || {};
  const rows = Object.values(defs);
  for (const kind of ['variant', 'subcircuit']) {
    for (const e of rows.filter((r) => r.kind === kind)) {
      if (!PARTS[e.id]) { try { registerEntry(e); } catch (err) { console.warn(err.message); } }
    }
  }
}

// ---- JSON exchange ------------------------------------------------------------------
export const CATALOG_FILE = 'outofshape-catalog';

export function exportEntries(entries) {
  // subcircuits bring the custom parts they are built from
  const all = new Map();
  const add = (e) => {
    if (all.has(e.id)) return;
    all.set(e.id, e);
    if (EXTRA_KINDS[e.kind] && EXTRA_KINDS[e.kind].requires) for (const d of EXTRA_KINDS[e.kind].requires(e)) add(d);
    if (e.kind === 'subcircuit') for (const d of Object.values(defsUsedBy(e.circuit))) add(d);
  };
  entries.forEach(add);
  return JSON.stringify({ file: CATALOG_FILE, format: 1, exported: new Date().toISOString(), entries: [...all.values()] }, null, 2);
}

/** @returns {Promise<{added:number, updated:number, names:string[]}>} */
export async function importEntries(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  const list = data && data.file === CATALOG_FILE ? data.entries : Array.isArray(data) ? data : data && data.kind ? [data] : null;
  if (!list) throw new Error('This file does not contain catalog entries.');
  list.forEach((e) => validateEntry(migrate('catalogEntry', e)));
  const existing = new Set((await listEntries()).map((e) => e.id));
  let added = 0;
  let updated = 0;
  for (const kind of kindOrder()) {
    for (const e of list.filter((x) => x.kind === kind)) {
      if (existing.has(e.id)) updated++; else added++;
      await saveEntry(e);
    }
  }
  return { added, updated, names: list.map((e) => e.name) };
}

// ---- favourites ------------------------------------------------------------------------
let favs = null;
export async function favourites() {
  if (!favs) favs = new Set((await db.get('kv', 'catalog-favourites').catch(() => null)) || []);
  return favs;
}
export async function toggleFavourite(type) {
  const f = await favourites();
  if (f.has(type)) f.delete(type); else f.add(type);
  await db.put('kv', [...f], 'catalog-favourites');
  return f.has(type);
}

export function catalogList() {
  return Object.entries(PARTS).filter(([, d]) => !d.removed).map(([type, def]) => ({ type, def, user: !!def.entry, base: def.entry && def.entry.base }));
}
export { CATEGORY_ORDER };

// ---------------------------------------------------------------------------------
// Helpers for the variant form
// ---------------------------------------------------------------------------------
/** Saturation current so that the diode carries `If` at `Vf` for emission coefficient n. */
export function fitDiodeIs(Vf, If, n) {
  return If / (Math.exp(Vf / (n * VT)) - 1);
}

/**
 * Characteristic curve(s) of a model for the preview.
 * @returns {{title:string, x:string, y:string, series:Array<{label:string, pts:number[][]}>, marks?:Array<{x?:number,y?:number,label:string}>}|null}
 */
export function characteristic(base, params) {
  const N = 60;
  const sweep = (a, b, f) => Array.from({ length: N + 1 }, (_, k) => { const x = a + ((b - a) * k) / N; return [x, f(x)]; });
  switch (base) {
    case 'D':
    case 'LED': {
      const { Is, n } = diodeParams({ type: base, ...params });
      const imax = (params.Imax || 0.03) * 1.5;
      const vEnd = n * VT * Math.log(imax / Is + 1);
      return {
        title: 'Forward characteristic', x: 'U [V]', y: 'I [A]',
        series: [{ label: 'I(U)', pts: sweep(0, vEnd, (v) => Is * (Math.exp(v / (n * VT)) - 1)) }],
        marks: [params.Irated ? { y: params.Irated, label: 'rated' } : null, params.Imax ? { y: params.Imax, label: 'max' } : null].filter(Boolean),
      };
    }
    case 'NPN':
    case 'PNP': {
      const icmax = params.Icmax || 0.5;
      const series = [];
      for (const f of [0.25, 0.5, 0.75, 1]) {
        const ib = (icmax / (params.beta || 100)) * f * 0.8;
        const c = new Circuit([
          { id: 'IB', type: 'I', nodes: ['0', 'b'], I: ib },
          { id: 'VC', type: 'V', nodes: ['c', '0'], V: 0 },
          { id: 'Q', type: 'NPN', nodes: ['c', 'b', '0'], beta: params.beta, Is: params.Is },
        ]);
        const pts = [];
        for (let k = 0; k <= 30; k++) { const v = (k / 30) * 2; c.set('VC', 'V', v); const r = c.step(); if (r.ok) pts.push([v, r.comp.Q.i]); }
        series.push({ label: `I_B = ${(ib * 1e6).toFixed(0)} µA`, pts });
      }
      return { title: 'Output characteristic', x: '|U_CE| [V]', y: '|I_C| [A]', series };
    }
    case 'NMOS':
    case 'PMOS': {
      const Vt = Math.abs(params.Vt ?? 2);
      const K = params.K || 0.5;
      const lam = params.lambda || 0;
      const id = (vgs, vds) => { const vov = vgs - Vt; if (vov <= 0) return 0; return vds < vov ? K * (vov * vds - 0.5 * vds * vds) * (1 + lam * vds) : 0.5 * K * vov * vov * (1 + lam * vds); };
      return { title: 'Output characteristic', x: '|U_DS| [V]', y: '|I_D| [A]', series: [1, 2, 3, 4].map((o) => ({ label: `U_GS = ${(Vt + o).toFixed(1)} V`, pts: sweep(0, 6, (v) => id(Vt + o, v)) })) };
    }
    case 'R': {
      const R = params.R || 1000;
      const vmax = params.Pmax ? Math.sqrt(params.Pmax * R) * 1.4 : 10;
      return { title: 'I–U line', x: 'U [V]', y: 'I [A]', series: [{ label: 'I = U/R', pts: sweep(0, vmax, (v) => v / R) }], marks: params.Pmax ? [{ x: Math.sqrt(params.Pmax * R), label: 'P max' }] : [] };
    }
    case 'LAMP': {
      const R = params.R || 48;
      const vr = Math.sqrt((params.Prated || 3) * R);
      // steady state of the filament model: R(U) = R·(0.1 + 0.9·sqrt(P/Prated))
      const iHot = (v) => {
        if (!params.thermal) return v / R;
        let i = v / R;
        for (let k = 0; k < 40; k++) i = v / (R * (0.1 + 0.9 * Math.min(1.2, Math.sqrt(Math.max(0, (v * i) / (params.Prated || 3))))));
        return i;
      };
      return { title: 'I–U characteristic', x: 'U [V]', y: 'I [A]', series: [{ label: params.thermal ? 'steady state (warm filament)' : 'I = U/R', pts: sweep(0, vr * 1.3, iHot) }], marks: [{ x: vr, label: 'rated' }] };
    }
    case 'RELAY': {
      const vr = params.Vrated || 12;
      const up = params.Vpull || 0.75 * vr;
      const dn = params.Vdrop || 0.3 * vr;
      return { title: 'Switching hysteresis', x: 'coil U [V]', y: 'state', series: [{ label: 'rising', pts: [[0, 0], [up, 0], [up, 1], [vr * 1.2, 1]] }, { label: 'falling', pts: [[vr * 1.2, 1], [dn, 1], [dn, 0], [0, 0]] }] };
    }
    case 'MOTOR': {
      const Ke = params.Ke || 0.03;
      return { title: 'No-load speed', x: 'U [V]', y: 'speed [rpm]', series: [{ label: 'n = U / Ke', pts: sweep(0, 24, (v) => ((v / Ke) * 60) / (2 * Math.PI)) }] };
    }
    case 'FUSE': {
      const ir = params.Irated || 0.5;
      // time to blow in the I²t model: t = tBlow / ((I/Ir)² − 1)
      return { title: 'Time to blow', x: 'I [A]', y: 't [s]', series: [{ label: 't(I)', pts: sweep(ir * 1.1, ir * 6, (i) => 0.05 / ((i / ir) ** 2 - 1)) }], marks: [{ x: ir, label: 'rated' }] };
    }
    case 'C': {
      const tau = (params.C || 1e-4) * 1000;
      return { title: 'Charging through 1 kΩ from 1 V', x: 't [s]', y: 'U [V]', series: [{ label: 'U(t)', pts: sweep(0, 5 * tau, (t) => 1 - Math.exp(-t / tau)) }], marks: [{ x: tau, label: 'τ' }] };
    }
    default:
      return null;
  }
}
