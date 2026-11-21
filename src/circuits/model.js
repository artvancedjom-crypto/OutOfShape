// Circuit document: the saved, editable description of a schematic.
//
//   { schema, kind:'circuit', id, name, templateId, parts[], wires[], labels[], probes[], settings }
//   part  { id, type, name, x, y, rot 0..3, mirror, params{} }      (grid units)
//   wire  { id, pts: [[x,y], ...] }                                 (polyline, any angles)
//   label { id, x, y, text }                                        (net label; equal names connect)
//   probe { id, kind:'V'|'A'|'R', at:[x,y] | part, ref:[x,y]|null, scope:bool }
import { defineSchema, migrate, schemaVersion } from '../core/schema.js';
import { PARTS, defaultParams, pinPositions } from './parts.js';

defineSchema('circuit', 1, []);

let seq = 0;
export const nid = (p = 'x') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newCircuit(name = 'Untitled circuit') {
  return {
    schema: schemaVersion('circuit'), kind: 'circuit', id: nid('c_'), name, templateId: null,
    parts: [], wires: [], labels: [], probes: [], settings: {}, created: Date.now(), updated: Date.now(),
  };
}

export function loadCircuit(obj) {
  const d = migrate('circuit', JSON.parse(JSON.stringify(obj)));
  d.parts = (d.parts || []).filter((p) => PARTS[p.type]);
  for (const p of d.parts) p.params = { ...defaultParams(p.type), ...(p.params || {}) };
  d.wires = (d.wires || []).filter((w) => w.pts && w.pts.length >= 2);
  d.labels = d.labels || [];
  d.probes = d.probes || [];
  d.settings = d.settings || {};
  return d;
}

/** Next free designator for a type: R1, R2, … */
export function nextName(doc, type) {
  const prefix = PARTS[type].prefix;
  if (PARTS[type].noName) return '';
  const used = new Set(doc.parts.map((p) => p.name));
  for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i;
}

export function makePart(doc, type, x, y, extra = {}) {
  return { id: nid('p'), type, name: nextName(doc, type), x, y, rot: 0, mirror: false, params: defaultParams(type), ...extra };
}

export const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

/** Distance from point to segment and the closest point on it. */
export function nearestOnSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { x, y, t, d: Math.hypot(px - x, py - y) };
}

/** Orthogonal path between two points. mode 'hv' = horizontal first, 'vh' = vertical first. */
export function routeOrtho(a, b, mode = 'hv') {
  if (Math.abs(a[0] - b[0]) < 1e-9 || Math.abs(a[1] - b[1]) < 1e-9) return [a.slice(), b.slice()];
  return mode === 'hv' ? [a.slice(), [b[0], a[1]], b.slice()] : [a.slice(), [a[0], b[1]], b.slice()];
}

/** Remove duplicate and collinear interior points. */
export function simplifyPath(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && samePt(out[out.length - 1], p)) continue;
    out.push([p[0], p[1]]);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-9 && dot > 0) out.splice(i, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builder used for templates and tests: place parts, then wire pins by name.
//   const b = builder('Divider');
//   b.part('V', 'V1', 4, 9, { rot: 1, params: { V: 12 } });
//   b.wire('V1.+', 'R1.1', 'vh');            // orthogonal, vertical first
//   b.wire('R1.2', [18, 3]);                  // to a free point
// ---------------------------------------------------------------------------
export function builder(name, templateId = null) {
  const doc = newCircuit(name);
  doc.templateId = templateId;
  if (templateId) doc.id = 'tpl_' + templateId;
  const pt = (ref) => {
    if (Array.isArray(ref)) return ref;
    const [pn, pin] = ref.split('.');
    const part = doc.parts.find((p) => p.name === pn || p.id === pn);
    if (!part) throw new Error(`builder: unknown part ${pn}`);
    const idx = PARTS[part.type].pins.findIndex((x) => x.name === pin);
    if (idx < 0) throw new Error(`builder: ${pn} has no pin ${pin}`);
    return pinPositions(part)[idx];
  };
  const api = {
    doc,
    part(type, pname, x, y, extra = {}) {
      const p = makePart(doc, type, x, y, { ...extra, params: { ...defaultParams(type), ...(extra.params || {}) } });
      p.id = pname || p.id;
      p.name = PARTS[type].noName ? '' : pname;
      doc.parts.push(p);
      return api;
    },
    gnd(x, y, id) {
      return api.part('GND', id || `GND${doc.parts.filter((p) => p.type === 'GND').length + 1}`, x, y);
    },
    /** wire(a, b, mode) or wire(a, via1, via2, ..., b) with explicit corner points */
    wire(...args) {
      let mode = null;
      if (typeof args[args.length - 1] === 'string' && /^(hv|vh)$/.test(args[args.length - 1])) mode = args.pop();
      const pts = args.map(pt);
      const path = mode ? routeOrtho(pts[0], pts[1], mode) : pts;
      doc.wires.push({ id: `w${doc.wires.length + 1}`, pts: simplifyPath(path) });
      return api;
    },
    label(ref, text) {
      const [x, y] = pt(ref);
      doc.labels.push({ id: `l${doc.labels.length + 1}`, x, y, text });
      return api;
    },
    probe(kind, at, opts = {}) {
      const pr = { id: `m${doc.probes.length + 1}`, kind, scope: !!opts.scope, name: opts.name || '' };
      if (kind === 'A') pr.part = at;
      else { pr.at = pt(at); pr.ref = opts.ref ? pt(opts.ref) : null; }
      doc.probes.push(pr);
      return api;
    },
  };
  return api;
}
