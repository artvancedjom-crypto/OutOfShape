// Current in every piece of wire and through every part, for the flow animation.
//
// Wires are ideal, so the solver only knows the current at part pins. Inside a net
// the wire currents follow from Kirchhoff's current law: the wires of a net form a
// graph, every pin injects a known current, and on a tree the current in each edge
// is the sum of the injections behind it. (If the user draws redundant wire loops
// the split is physically undetermined; the extra edges then carry nothing.)
import { PARTS, pinPositions } from './parts.js';
import { nearestOnSegment } from './model.js';

const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

/** Static structure; rebuild when the document changes. */
export function buildFlowGraph(doc) {
  const verts = new Map(); // key → {x, y, adj: [edge], pins: [{part, pin}], unknown: bool}
  const V = (x, y) => {
    const k = key(x, y);
    if (!verts.has(k)) verts.set(k, { k, x, y, adj: [], pins: [], unknown: false });
    return verts.get(k);
  };
  // points that split wire segments: pins and ends of other wires
  const splitters = [];
  for (const part of doc.parts) pinPositions(part).forEach((pt) => splitters.push(pt));
  for (const w of doc.wires) { splitters.push(w.pts[0], w.pts[w.pts.length - 1]); }
  for (const l of doc.labels) splitters.push([l.x, l.y]);

  const edges = [];
  for (const w of doc.wires) {
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1];
      const b = w.pts[i];
      const cuts = [0, 1];
      for (const s of splitters) {
        const n = nearestOnSegment(s[0], s[1], a, b);
        if (n.d < 0.02 && n.t > 1e-6 && n.t < 1 - 1e-6) cuts.push(n.t);
      }
      cuts.sort((p, q) => p - q);
      for (let c = 1; c < cuts.length; c++) {
        if (cuts[c] - cuts[c - 1] < 1e-9) continue;
        const p = [a[0] + (b[0] - a[0]) * cuts[c - 1], a[1] + (b[1] - a[1]) * cuts[c - 1]];
        const q = [a[0] + (b[0] - a[0]) * cuts[c], a[1] + (b[1] - a[1]) * cuts[c]];
        const va = V(p[0], p[1]);
        const vb = V(q[0], q[1]);
        if (va === vb) continue;
        const e = { a: va, b: vb, len: Math.hypot(q[0] - p[0], q[1] - p[1]), wire: w.id, i: 0, phase: 0 };
        va.adj.push(e);
        vb.adj.push(e);
        edges.push(e);
      }
    }
  }
  for (const part of doc.parts) {
    pinPositions(part).forEach((pt, pin) => {
      const v = verts.get(key(pt[0], pt[1]));
      if (!v) return;
      if (part.type === 'GND') v.unknown = true; // current leaves the drawing here
      else v.pins.push({ part, pin });
    });
  }
  for (const l of doc.labels) { const v = verts.get(key(l.x, l.y)); if (v) v.unknown = true; }

  // spanning forest; roots are preferably points where current can leave the drawing
  const order = []; // [{v, parentEdge}] in BFS order
  const seen = new Set();
  const all = [...verts.values()];
  const starts = [...all.filter((v) => v.unknown), ...all];
  for (const root of starts) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue = [root];
    order.push({ v: root, edge: null, parent: null });
    while (queue.length) {
      const v = queue.shift();
      for (const e of v.adj) {
        const o = e.a === v ? e.b : e.a;
        if (seen.has(o)) continue;
        seen.add(o);
        e.tree = true;
        order.push({ v: o, edge: e, parent: v });
        queue.push(o);
      }
    }
  }

  // current paths through parts: pin → pin for two-pin parts, pin → centre otherwise
  const partPaths = [];
  for (const part of doc.parts) {
    if (part.type === 'GND') continue;
    const pins = pinPositions(part);
    if (pins.length === 2) partPaths.push({ part, pin: 0, a: pins[0], b: pins[1], len: Math.hypot(pins[1][0] - pins[0][0], pins[1][1] - pins[0][1]), i: 0, phase: 0 });
    else pins.forEach((pt, pin) => partPaths.push({ part, pin, a: pt, b: [part.x, part.y], len: Math.hypot(part.x - pt[0], part.y - pt[1]), i: 0, phase: 0 }));
  }
  return { edges, order, partPaths, verts, items: [...edges, ...partPaths] };
}

/** Fill in edge.i (a → b) and partPath.i (a → b) from a solver result. */
export function solveFlow(graph, net, res) {
  const { order, edges, partPaths } = graph;
  const ok = res && res.ok;
  for (const e of edges) e.i = 0;
  const sub = new Map();
  if (ok) {
    for (const { v } of order) {
      let inj = 0;
      for (const { part, pin } of v.pins) {
        const pinI = net.pinCurrents(part, res);
        if (pinI) inj -= pinI[pin]; // current the part pushes into the net at this pin
      }
      sub.set(v, inj);
    }
    for (let k = order.length - 1; k >= 0; k--) {
      const { v, edge, parent } = order[k];
      if (!edge) continue;
      const s = sub.get(v);
      edge.i = edge.a === v ? s : -s; // flows from v toward its parent
      sub.set(parent, sub.get(parent) + s);
    }
  }
  for (const pp of partPaths) {
    const pinI = ok ? net.pinCurrents(pp.part, res) : null;
    pp.i = pinI ? pinI[pp.pin] : 0;
  }
  return graph;
}
