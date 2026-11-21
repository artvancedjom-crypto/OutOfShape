// Live simulation of a circuit document: rebuilds the netlist when the document
// changes (keeping capacitor charge, relay state … for parts that still exist),
// advances the transient in real time and evaluates probes.
import { Circuit, resistanceBetween } from './mna.js';
import { buildNetlist, resultDiagnostics } from './netlist.js';
import { PARTS } from './parts.js';

export const SPEEDS = [
  ['auto', 'Speed: auto'], ['1', 'Real time'], ['0.1', '10× slower'], ['0.01', '100× slower'],
  ['0.001', '1 ms per second'], ['0.0001', '100 µs per second'], ['10', '10× faster'],
];

const BURNABLE = new Set(['R', 'LED', 'D', 'LAMP', 'NPN', 'PNP', 'NMOS', 'PMOS', 'C', 'POT']);

export class Simulation {
  constructor() {
    this.doc = null;
    this.net = null;
    this.circuit = null;
    this.result = null;
    this.diagnostics = [];
    this.running = true;
    this.speed = 'auto';
    this.samples = []; // scope buffer: {t, v: {probeId: value}}
    this.window = 0;
    this.load = 0; // fraction of the requested simulated time that was achieved
    this.burned = new Set(); // parts destroyed by overload (open circuit until replaced)
    this.burnOut = true; // setting: do badly overloaded parts burn out?
    this.stress = new Map(); // part id → seconds spent at ≥ 2× rating
  }

  /** Call after every document change. */
  rebuild(doc) {
    const prev = this.circuit;
    this.doc = doc;
    for (const id of [...this.burned]) if (!doc.parts.some((p) => p.id === id)) this.burned.delete(id);
    this.net = buildNetlist(doc, { burned: this.burned });
    this.circuit = new Circuit(this.net.components);
    if (prev) this.circuit.adoptState(prev);
    this.char = this._characteristicTime();
    this.dirty = true;
    this.solveNow();
  }

  /** Forget all dynamic state (capacitor charge, blown fuses, motor speed) and restart at t = 0. */
  restart() {
    if (!this.doc) return;
    this.burned.clear();
    this.stress.clear();
    this.net = buildNetlist(this.doc);
    this.circuit = new Circuit(this.net.components);
    this.samples = [];
    this.solveNow();
  }

  resetPartState(id) {
    if (!this.circuit) return;
    delete this.circuit.state[id];
    this.stress.delete(id);
    if (this.burned.delete(id)) this.rebuild(this.doc);
    else this.solveNow();
  }

  /** Jump to the DC operating point (capacitors charged, inductors settled). */
  settle() {
    if (this.circuit) { this.result = this.circuit.solveDC(true); this._diag(); }
  }

  /** Set a live value on a solver component without rebuilding (switches, sliders). */
  poke(id, key, value) {
    if (this.circuit) this.circuit.set(id, key, value);
  }

  solveNow() {
    const c = this.circuit;
    if (!c || !c.components.length) { this.result = null; this._diag(); return; }
    // A zero-length look: DC for static circuits, a tiny transient step otherwise so state is respected.
    this.result = c.dynamic ? c.step(this._dtProbe()) : c.step();
    this._diag();
  }

  _dtProbe() {
    return Math.max(1e-9, this.char / 2000);
  }

  _diag() {
    this.diagnostics = [...(this.net ? this.net.diagnostics : []), ...resultDiagnostics(this.doc, this.net, this.result)];
  }

  _characteristicTime() {
    const comps = this.net.components;
    const rs = comps.filter((c) => c.type === 'R' && c.R > 0).map((c) => Math.log(c.R));
    const rref = rs.length ? Math.exp(rs.reduce((a, b) => a + b, 0) / rs.length) : 1000;
    let T = 0;
    for (const c of comps) {
      if (c.type === 'C') T = Math.max(T, c.C * rref);
      else if (c.type === 'L') T = Math.max(T, c.L / rref);
      else if ((c.type === 'V' || c.type === 'I') && c.wave && c.wave !== 'dc') T = Math.max(T, 2 / (c.freq || 1));
      else if (c.type === 'MOTOR') T = Math.max(T, ((c.J || 1e-4) * (c.R || 1)) / ((c.Ke || 0.05) ** 2));
      else if (c.type === 'LAMP' && c.thermal) T = Math.max(T, 0.05);
      else if (c.type === 'FUSE') T = Math.max(T, 0.05);
    }
    return T > 0 ? Math.min(Math.max(T, 1e-9), 3600) : 1;
  }

  /** Simulated seconds per real second. */
  rate() {
    if (this.speed !== 'auto') return parseFloat(this.speed);
    return this.circuit && this.circuit.dynamic ? (5 * this.char) / 4 : 1;
  }

  /** Parts that run at twice their rating for about a second burn out (if enabled). */
  _burnCheck(dtReal) {
    if (!this.burnOut || !this.result || !this.result.ok) return false;
    let any = false;
    for (const part of this.doc.parts) {
      if (!BURNABLE.has(part.type) || this.burned.has(part.id)) continue;
      const r = this.net.partResult(part, this.result);
      if (r && r.overload >= 2) {
        const t = (this.stress.get(part.id) || 0) + dtReal * Math.min(4, r.overload / 2);
        this.stress.set(part.id, t);
        if (t > 1.2) { this.burned.add(part.id); any = true; }
      } else if (this.stress.has(part.id)) this.stress.delete(part.id);
    }
    if (any) this.rebuild(this.doc);
    return any;
  }

  /** Advance by one animation frame. Returns true if results changed. */
  tick(dtReal) {
    this._burnCheck(dtReal);
    const c = this.circuit;
    if (!c || !c.components.length || !this.running) return false;
    const span = Math.min(dtReal, 0.05) * this.rate();
    const needsTime = c.dynamic || c.components.some((x) => x.type === 'FUSE');
    if (!needsTime) {
      if (this.dirty) { this.dirty = false; this.result = c.step(); this._diag(); }
      c.time += span;
      this._sample(this.result, c.time);
      return true;
    }
    const t0 = performance.now();
    const dtMax = Math.max(Math.min(span, this.char / 40), span / 150);
    const target = c.time + span;
    // keep the UI responsive: stop after a few milliseconds even if the requested span is not reached
    let r = this.result;
    while (c.time < target - 1e-15) {
      const chunk = Math.min(target - c.time, dtMax * 8);
      r = c.advance(chunk, { dtMax, dtMin: dtMax / 2000, onStep: (s) => this._sample(s, s.time) });
      if (!r.ok || performance.now() - t0 > 9) break;
    }
    this.load = Math.min(1, 1 - (target - c.time) / span);
    if (!r.ok) c.time = target; // do not hammer a failing circuit
    this.result = r;
    this._diag();
    return true;
  }

  _sample(res, t) {
    if (!res || !res.ok || !this.doc) return;
    const ch = this.doc.probes.filter((p) => p.scope && p.kind !== 'R');
    if (!ch.length) return;
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < this.window / 1500) return;
    const v = {};
    for (const p of ch) v[p.id] = this.probeValue(p, res);
    this.samples.push({ t, v });
    const limit = t - this.window;
    let cut = 0;
    while (cut < this.samples.length && this.samples[cut].t < limit) cut++;
    if (cut > 200) this.samples.splice(0, cut);
  }

  /** Width of the scope's time axis in simulated seconds (about 8 s of wall time). */
  updateWindow() {
    this.window = 8 * this.rate();
  }

  partResult(part) {
    return this.net ? this.net.partResult(part, this.result) : null;
  }

  nodeVoltage(x, y) {
    if (!this.net || !this.result || !this.result.ok) return null;
    const n = this.net.nodeAt(x, y);
    if (n == null) return null;
    const v = this.result.nodeV[n];
    return v === undefined ? null : { node: n, v };
  }

  /** @returns {number|null} */
  probeValue(p, res = this.result) {
    if (!this.net || !res || !res.ok) return null;
    if (p.kind === 'A') {
      const part = this.doc.parts.find((x) => x.id === p.part);
      const r = part && this.net.partResult(part, res);
      return r ? r.i : null;
    }
    const a = this.net.nodeAt(p.at[0], p.at[1]);
    const b = p.ref ? this.net.nodeAt(p.ref[0], p.ref[1]) : '0';
    if (a == null || b == null) return null;
    if (p.kind === 'R') return resistanceBetween(this.net.components, a, b, this.circuit.state);
    const va = res.nodeV[a];
    const vb = res.nodeV[b];
    return va === undefined || vb === undefined ? null : va - vb;
  }

  probeLabel(p) {
    if (p.name) return p.name;
    if (p.kind === 'A') { const part = this.doc.parts.find((x) => x.id === p.part); return `I(${part ? part.name || PARTS[part.type].name : '?'})`; }
    const a = this.net ? this.net.nodeAt(p.at[0], p.at[1]) : '?';
    const b = p.ref && this.net ? this.net.nodeAt(p.ref[0], p.ref[1]) : null;
    return p.kind === 'R' ? `R(${a ?? '?'}–${b ?? '0'})` : b ? `V(${a ?? '?'}–${b})` : `V(${a ?? '?'})`;
  }
}
