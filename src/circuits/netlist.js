// Circuit document → solver netlist, with connectivity analysis and static checks.
//
// Connectivity rules (what you see is what is connected):
//   - all corner points of one wire are connected
//   - a pin or a wire END that lies on another wire (corner or mid-segment) connects → junction dot
//   - wires that merely cross are NOT connected
//   - net labels with the same text connect; a ground symbol (or a label "GND"/"0") makes the net ground
import { PARTS, pinPositions } from './parts.js';
import { nearestOnSegment } from './model.js';

const EPS = 0.02;
const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

class UF {
  constructor() { this.p = new Map(); }
  find(a) {
    if (!this.p.has(a)) this.p.set(a, a);
    let r = a;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(a) !== r) { const n = this.p.get(a); this.p.set(a, r); a = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); return ra !== rb; }
}

/**
 * @returns {{
 *   components: any[], diagnostics: any[], nodeAt:(x:number,y:number)=>string|null,
 *   pinNodes: Map<string,string[]>, junctions: number[][], excluded:Set<string>,
 *   partResult:(part:any,res:any)=>any, pinCurrents:(part:any,res:any)=>number[]|null, hasGround:boolean
 * }}
 */
export function buildNetlist(doc) {
  const uf = new UF();
  const diagnostics = [];
  const segs = []; // {a,b,wire}
  const degree = new Map(); // point key → number of conductor ends meeting there
  const bump = (k, n = 1) => degree.set(k, (degree.get(k) || 0) + n);

  for (const w of doc.wires) {
    for (let i = 0; i < w.pts.length; i++) {
      const k = key(w.pts[i][0], w.pts[i][1]);
      uf.find(k);
      bump(k, i === 0 || i === w.pts.length - 1 ? 1 : 2);
      if (i > 0) {
        uf.union(key(w.pts[i - 1][0], w.pts[i - 1][1]), k);
        segs.push({ a: w.pts[i - 1], b: w.pts[i], wire: w });
      }
    }
  }
  // interior point of a segment (not at its ends)?
  const onSegment = (x, y, exceptWire = null) => {
    for (const s of segs) {
      if (s.wire === exceptWire) continue;
      const n = nearestOnSegment(x, y, s.a, s.b);
      if (n.d < EPS && n.t > 1e-6 && n.t < 1 - 1e-6) return s;
    }
    return null;
  };
  const attach = (x, y, exceptWire) => {
    const k = key(x, y);
    uf.find(k);
    const s = onSegment(x, y, exceptWire);
    if (s) { uf.union(k, key(s.a[0], s.a[1])); bump(k, 2); }
    return k;
  };
  // wire ends landing on other wires
  for (const w of doc.wires) {
    for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) attach(p[0], p[1], w);
  }
  // pins
  const pinKeys = new Map(); // part id → [key]
  const wirePoints = new Set(degree.keys());
  for (const part of doc.parts) {
    const keys = pinPositions(part).map(([x, y]) => { const k = attach(x, y, null); bump(k, 1); return k; });
    pinKeys.set(part.id, keys);
  }
  // labels
  const byText = new Map();
  const groundRoots = [];
  for (const lb of doc.labels) {
    const k = key(lb.x, lb.y);
    const known = uf.p.has(k) || onSegment(lb.x, lb.y);
    if (!known) {
      diagnostics.push({ level: 'warning', code: 'label-loose', message: `Net label "${lb.text}" is not attached to a wire or pin.`, labels: [lb.id], parts: [], nodes: [] });
      continue;
    }
    attach(lb.x, lb.y, null);
    const text = String(lb.text || '').trim();
    if (!text) continue;
    if (/^(gnd|0)$/i.test(text)) groundRoots.push(k);
    else if (byText.has(text)) uf.union(byText.get(text), k);
    else byText.set(text, k);
  }
  for (const part of doc.parts) if (part.type === 'GND') groundRoots.push(pinKeys.get(part.id)[0]);
  for (let i = 1; i < groundRoots.length; i++) uf.union(groundRoots[0], groundRoots[i]);
  const hasGround = groundRoots.length > 0;
  const gRoot = hasGround ? uf.find(groundRoots[0]) : null;

  // node names
  const names = new Map();
  for (const [text, k] of byText) { const r = uf.find(k); if (r !== gRoot && !names.has(r)) names.set(r, text); }
  let n = 0;
  const nodeName = (k) => {
    const r = uf.find(k);
    if (r === gRoot) return '0';
    if (!names.has(r)) names.set(r, `n${++n}`);
    return names.get(r);
  };

  // ---- which parts take part in the simulation? ------------------------------------
  const excluded = new Set();
  const real = doc.parts.filter((pt) => pt.type !== 'GND');
  const pinNodes = new Map();
  for (const part of doc.parts) pinNodes.set(part.id, pinKeys.get(part.id).map(nodeName));

  // pins that touch nothing: the pin's point is alone in its net
  const rootSize = new Map();
  for (const k of uf.p.keys()) { const r = uf.find(k); rootSize.set(r, (rootSize.get(r) || 0) + 1); }
  const pinsAt = new Map();
  for (const part of doc.parts) for (const k of pinKeys.get(part.id)) pinsAt.set(k, (pinsAt.get(k) || 0) + 1);
  const openPins = new Set();
  for (const part of real) {
    const keys = pinKeys.get(part.id);
    const loose = keys.filter((k) => !wirePoints.has(k) && rootSize.get(uf.find(k)) === 1 && pinsAt.get(k) === 1);
    for (const k of loose) openPins.add(k);
    if (loose.length === keys.length) {
      excluded.add(part.id);
      diagnostics.push({ level: 'warning', code: 'unconnected', message: `${part.name || PARTS[part.type].name} is not connected to anything.`, parts: [part.id], nodes: [] });
    } else if (loose.length) {
      const pins = loose.map((k) => PARTS[part.type].pins[keys.indexOf(k)].name).join(', ');
      diagnostics.push({ level: 'warning', code: 'open-pin', message: `${part.name || PARTS[part.type].name}: pin ${pins} is not connected.`, parts: [part.id], nodes: loose.map(nodeName) });
    }
  }

  const live = () => real.filter((pt) => !excluded.has(pt.id));
  if (live().length && !hasGround) {
    diagnostics.push({ level: 'error', code: 'no-ground', message: 'There is no ground. Place a ground symbol (Sources → Ground) on the node that should be 0 V; without a reference the voltages are undefined.', parts: [], nodes: [] });
  }

  // shorted voltage sources / source loops
  const vuf = new UF();
  for (const part of live()) {
    if (part.type !== 'V' && part.type !== 'AMMETER') continue;
    const [a, b] = pinNodes.get(part.id);
    if (a === b) {
      if (part.type === 'V') {
        excluded.add(part.id);
        diagnostics.push({ level: 'error', code: 'short', message: `Short circuit: both terminals of ${part.name} are joined by a wire. An ideal source would deliver unlimited current. Remove the wire or put a load in between.`, parts: [part.id], nodes: [a] });
      } else excluded.add(part.id); // a bridged ammeter simply reads nothing
      continue;
    }
    if (!vuf.union(a, b)) {
      excluded.add(part.id);
      diagnostics.push({ level: 'error', code: 'source-loop', message: `${part.name} closes a loop that contains only voltage sources${part.type === 'AMMETER' ? ' and ammeters' : ''} (for example two sources in parallel). Add a resistance to the loop.`, parts: [part.id], nodes: [a, b] });
    }
  }

  // islands that are not tied to ground
  if (hasGround) {
    const guf = new UF();
    for (const part of live()) {
      const nodes = pinNodes.get(part.id);
      for (let i = 1; i < nodes.length; i++) guf.union(nodes[0], nodes[i]);
    }
    const g = guf.find('0');
    const islands = new Map();
    for (const part of live()) {
      const r = guf.find(pinNodes.get(part.id)[0]);
      if (r === g) continue;
      if (!islands.has(r)) islands.set(r, []);
      islands.get(r).push(part);
    }
    for (const parts of islands.values()) {
      for (const pt of parts) excluded.add(pt.id);
      const list = parts.map((pt) => pt.name || PARTS[pt.type].name);
      diagnostics.push({
        level: 'error', code: 'floating',
        message: `Floating: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${list.length - 6} more` : ''} ${parts.length === 1 ? 'has' : 'have'} no connection to ground, so ${parts.length === 1 ? 'its' : 'their'} voltages are undefined. Connect this part of the circuit to the rest or give it its own ground symbol.`,
        parts: parts.map((pt) => pt.id), nodes: [...new Set(parts.flatMap((pt) => pinNodes.get(pt.id)))],
      });
    }
  }

  // ---- components ------------------------------------------------------------------
  const components = [];
  const alias = new Map(); // contact part id → {relay id, pole index}
  if (hasGround) {
    const relays = new Map();
    for (const part of live()) {
      const def = PARTS[part.type];
      if (def.relayContact) continue;
      const comps = def.model(part, pinNodes.get(part.id));
      components.push(...comps);
      if (part.type === 'RELAY') relays.set(part.name, comps[0]);
    }
    for (const part of live()) {
      const def = PARTS[part.type];
      if (!def.relayContact) continue;
      const relay = relays.get(String(part.params.relay || '').trim());
      const nodes = pinNodes.get(part.id);
      if (relay) {
        alias.set(part.id, { relay: relay.id, pole: relay.poles.length });
        relay.poles.push(def.relayContact);
        relay.nodes.push(nodes[0], nodes[1]);
      } else {
        components.push({ id: part.id, type: 'SW', nodes, closed: def.relayContact === 'NC' });
        diagnostics.push({ level: 'warning', code: 'no-relay', message: `Contact refers to relay "${part.params.relay}", which does not exist. It stays in its rest position.`, parts: [part.id], nodes: [] });
      }
    }
  }

  // junction dots: three or more conductor ends meet
  const junctions = [];
  for (const [k, d] of degree) {
    if (d >= 3) { const [x, y] = k.split(',').map((v) => +v / 100); junctions.push([x, y]); }
  }

  const nodeAt = (x, y) => {
    const k = key(x, y);
    if (uf.p.has(k)) return nodeName(k);
    const s = onSegment(x, y);
    return s ? nodeName(key(s.a[0], s.a[1])) : null;
  };

  /** Result record for a document part (resolves relay contacts and multi-component parts). */
  const partResult = (part, res) => {
    if (!res || !res.ok) return null;
    const al = alias.get(part.id);
    if (al) {
      const r = res.comp[al.relay];
      if (!r) return null;
      const nodes = pinNodes.get(part.id);
      const v = (res.nodeV[nodes[0]] || 0) - (res.nodeV[nodes[1]] || 0);
      const i = r.poleI[al.pole];
      return { v, i, p: Math.abs(v * i), pinI: [i, -i], on: r.on };
    }
    const r = res.comp[part.id];
    if (!r) return null;
    const def = PARTS[part.type];
    if (def.pinCurrents) {
      const pinI = def.pinCurrents(res, part);
      if (pinI) return { ...r, pinI };
    }
    return r;
  };

  return {
    components, diagnostics, nodeAt, pinNodes, junctions, excluded, hasGround, partResult,
    isOpenPin: (x, y) => openPins.has(key(x, y)),
    pinCurrents: (part, res) => { const r = partResult(part, res); return r ? r.pinI : null; },
  };
}

/** Problems that only show after solving: solver failures and parts beyond their ratings. */
export function resultDiagnostics(doc, net, res) {
  const out = [];
  if (!res) return out;
  if (!res.ok) {
    out.push({ level: 'error', code: res.code, message: res.error, parts: res.parts || [], nodes: res.nodes || [] });
    return out;
  }
  for (const part of doc.parts) {
    const r = net.partResult(part, res);
    if (!r) continue;
    const name = part.name || PARTS[part.type].name;
    if (part.type === 'V' && Math.abs(r.i) > 50) {
      out.push({ level: 'error', code: 'short', message: `Short circuit: ${name} delivers ${Math.abs(r.i).toFixed(0)} A. Its terminals are joined through closed switches or wires without a load.`, parts: [part.id], nodes: [] });
    } else if (r.blown) {
      out.push({ level: 'warning', code: 'blown', message: `${name} has blown. Fix the cause, then replace it (select it → "Replace blown fuse").`, parts: [part.id], nodes: [] });
    } else if (r.overload) {
      out.push({ level: 'warning', code: 'overload', message: `${name} is overloaded: ${r.overload.toFixed(1)}× its rating.`, parts: [part.id], nodes: [] });
    }
  }
  return out;
}
