// General-purpose circuit solver: Modified Nodal Analysis + Newton-Raphson.
//
// Input is a flat netlist: [{ id, type, nodes: [...], ...params }]. Node '0' is ground.
// Nothing in here knows about schematics, scenarios or the UI.
//
// Device types
//   R      nodes [a,b]              R
//   V      nodes [+,-]              V, wave 'dc'|'sine'|'square', freq, offset, duty
//   I      nodes [from,to]          I (flows from→to through the source)
//   C      nodes [a,b]              C, v0
//   L      nodes [a,b]              L
//   SW     nodes [a,b]              closed, Ron
//   D/LED  nodes [anode,cathode]    Is, n  (or model name from DIODE_MODELS), Irated, Imax
//   NPN/PNP nodes [C,B,E]           beta, Is
//   NMOS/PMOS nodes [D,G,S]         Vt, K (A/V²), lambda
//   RELAY  nodes [a,b, p1a,p1b,…]   Rcoil, Vpull, Vdrop, poles ['NO'|'NC',…]
//   LAMP   nodes [a,b]              R (hot), Prated, thermal (bool): cold filament = R/10
//   POT    nodes [a,wiper,b]        R, pos 0..1
//   FUSE   nodes [a,b]              Irated, R
//   MOTOR  nodes [+,-]              R, Ke (V·s/rad), J, friction, load
//   AMMETER nodes [a,b]             ideal (0 V)
//   VOLTMETER nodes [a,b]           10 MΩ
//
// Results: { ok, error, nodeV, comp: { id: { v, i, p, pinI: [...], ... } }, time }
//   v    voltage from pin 0 to pin 1
//   i    current through the part from pin 0 to pin 1 (sources: delivered current)
//   pinI current flowing INTO the part at each pin (sums to 0)

const VT = 0.025852; // thermal voltage at ~300 K
const GMIN = 1e-12;
const RON = 1e-3;
const ROFF = 1e9;

export class SolverError extends Error {
  /** @param {'singular'|'noconv'} code */
  constructor(code, message, info = {}) {
    super(message);
    this.code = code;
    Object.assign(this, info);
  }
}

function solveLinear(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    let best = Math.abs(A[c][c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r][c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) throw new SolverError('singular', 'Singular matrix', { index: c });
    if (piv !== c) {
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
    }
    const Ac = A[c];
    const d = Ac[c];
    for (let r = c + 1; r < n; r++) {
      const Ar = A[r];
      const f = Ar[c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) Ar[k] -= f * Ac[k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    const Ar = A[r];
    for (let k = r + 1; k < n; k++) s -= Ar[k] * b[k];
    b[r] = s / Ar[r];
  }
  return b;
}

// exp with linear continuation, so Newton iterations cannot overflow
const XMAX = 150; // e^150 ≈ 1e65: far above any real operating point, far below overflow
const limexp = (x) => (x < XMAX ? Math.exp(x) : Math.exp(XMAX) * (1 + x - XMAX));
const dlimexp = (x) => (x < XMAX ? Math.exp(x) : Math.exp(XMAX));

export const DIODE_MODELS = {
  si: { Is: 2.52e-9, n: 1.752 },
  schottky: { Is: 1e-6, n: 1.05 },
  red: { Is: 1e-18, n: 1.9 },
  yellow: { Is: 1e-19, n: 1.95 },
  green: { Is: 1e-20, n: 2.0 },
  blue: { Is: 1e-26, n: 2.1 },
  white: { Is: 1e-26, n: 2.1 },
};

export function diodeParams(c) {
  const m = DIODE_MODELS[c.model] || DIODE_MODELS[c.type === 'LED' ? 'red' : 'si'];
  return { Is: c.Is > 0 ? c.Is : m.Is, n: c.n > 0 ? c.n : m.n };
}

/** Source value at time t (t = null → DC value / offset). */
export function sourceValue(c, t) {
  const amp = c.V ?? c.I ?? 0;
  const wave = c.wave || 'dc';
  if (wave === 'dc') return amp;
  const off = c.offset || 0;
  if (t == null) return off;
  const f = c.freq || 1;
  if (wave === 'sine') return off + amp * Math.sin(2 * Math.PI * f * t);
  if (wave === 'square') {
    const ph = (t * f) % 1;
    return off + (ph < (c.duty ?? 0.5) ? amp : 0);
  }
  return amp;
}

const NONLINEAR = new Set(['D', 'LED', 'NPN', 'PNP', 'NMOS', 'PMOS']);
const BRANCH = new Set(['V', 'AMMETER']);

/** Drain current of an n-channel square-law MOSFET with vds >= 0. Returns [id, gm, gds]. */
function mosCurrent(vgs, vds, Vt, K, lambda) {
  const vov = vgs - Vt;
  if (vov <= 0) return [0, 0, 0];
  const clm = 1 + lambda * vds;
  if (vds < vov) {
    const id = K * (vov * vds - 0.5 * vds * vds) * clm;
    return [id, K * vds * clm, K * (vov - vds) * clm + K * (vov * vds - 0.5 * vds * vds) * lambda];
  }
  const id = 0.5 * K * vov * vov * clm;
  return [id, K * vov * clm, 0.5 * K * vov * vov * lambda];
}

export class Circuit {
  constructor(components) {
    this.components = components.map((c) => ({ ...c }));
    this.time = 0;
    this.state = {}; // dynamic state per part id: capacitor voltage, inductor current, relay, fuse, motor, lamp
    this.result = null;
    this.dt = null; // adaptive step memory
    this._index();
  }

  _index() {
    const nodes = new Map();
    const idx = (n) => {
      n = String(n);
      if (n === '0' || n.toUpperCase() === 'GND') return -1;
      if (!nodes.has(n)) nodes.set(n, nodes.size);
      return nodes.get(n);
    };
    this.compNodes = this.components.map((c) => c.nodes.map(idx));
    this.nodeIndex = nodes;
    this.nodeNames = [...nodes.keys()];
    let k = nodes.size;
    this.branchIndex = {};
    this.branchOwner = {};
    for (const c of this.components) {
      if (BRANCH.has(c.type)) { this.branchOwner[k] = c.id; this.branchIndex[c.id] = k++; }
    }
    this.size = k;
    this.nonlinear = this.components.some((c) => NONLINEAR.has(c.type));
    this.dynamic = this.components.some((c) => ['C', 'L', 'MOTOR'].includes(c.type) || (c.type === 'LAMP' && c.thermal) || ((c.type === 'V' || c.type === 'I') && c.wave && c.wave !== 'dc'));
  }

  get(id) {
    return this.components.find((c) => c.id === id);
  }

  set(id, key, value) {
    const c = this.get(id);
    if (c) c[key] = value;
  }

  /** Copy dynamic state from a previous circuit (after an edit) for parts that still exist. */
  adoptState(prev) {
    if (!prev) return;
    for (const c of this.components) if (prev.state[c.id]) this.state[c.id] = { ...prev.state[c.id] };
    this.time = prev.time;
  }

  _v(x, ni) {
    return ni < 0 ? 0 : x[ni];
  }

  // ---- one Newton solve at fixed dt (null = DC), returns x or throws SolverError ----
  _newton(x0, dt, t, srcScale = 1) {
    const n = this.size;
    const nn = this.nodeIndex.size;
    let x = x0.slice();
    const maxIt = this.nonlinear ? 300 : 1;
    for (let it = 0; it < maxIt; it++) {
      const A = Array.from({ length: n }, () => new Float64Array(n));
      const b = new Float64Array(n);
      for (let i = 0; i < nn; i++) A[i][i] += GMIN;
      this._stamp(A, b, x, dt, t, srcScale);
      const xn = solveLinear(A, b);
      if (!this.nonlinear) return xn;
      let maxd = 0;
      for (let i = 0; i < nn; i++) {
        const d = Math.abs(xn[i] - x[i]);
        if (!(d <= Infinity)) throw new SolverError('noconv', 'Solution diverged');
        if (d > maxd) maxd = d;
      }
      if (maxd > 0.5) {
        const s = 0.5 / maxd; // damp large Newton steps
        for (let i = 0; i < n; i++) xn[i] = x[i] + (xn[i] - x[i]) * s;
      }
      x = xn;
      if (maxd < 1e-7) return x;
    }
    throw new SolverError('noconv', 'No convergence');
  }

  /** Newton with source stepping as a fallback for hard operating points. */
  _solve(x0, dt, t) {
    try {
      return this._newton(x0, dt, t);
    } catch (e) {
      if (e.code !== 'noconv') throw e;
      let x = new Float64Array(this.size);
      for (const s of [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1]) x = this._newton(x, dt, t, s);
      return x;
    }
  }

  _stamp(A, b, x, dt, t, srcScale) {
    const G = (a, c, g) => {
      if (a >= 0) A[a][a] += g;
      if (c >= 0) A[c][c] += g;
      if (a >= 0 && c >= 0) { A[a][c] -= g; A[c][a] -= g; }
    };
    const I = (a, c, i) => { // current i flows a → c through the element
      if (a >= 0) b[a] -= i;
      if (c >= 0) b[c] += i;
    };
    // generic nonlinear multi-terminal stamp: cur[k] = current into the device at terminal k,
    // J[k][j] = d cur[k] / d v[j]
    const NL = (nd, v, cur, J) => {
      for (let k = 0; k < nd.length; k++) {
        const row = nd[k];
        if (row < 0) continue;
        let lin = cur[k];
        for (let j = 0; j < nd.length; j++) {
          lin -= J[k][j] * v[j];
          if (nd[j] >= 0) A[row][nd[j]] += J[k][j];
        }
        b[row] -= lin;
      }
    };
    const comps = this.components;
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      const nd = this.compNodes[ci];
      const st = this.state[c.id];
      switch (c.type) {
        case 'R':
          G(nd[0], nd[1], 1 / Math.max(c.R, 1e-9));
          break;
        case 'VOLTMETER':
          G(nd[0], nd[1], 1e-7);
          break;
        case 'LAMP':
          G(nd[0], nd[1], 1 / this._lampR(c));
          break;
        case 'FUSE':
          G(nd[0], nd[1], st && st.blown ? 1 / ROFF : 1 / Math.max(c.R || 0.01, 1e-6));
          break;
        case 'POT': {
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          G(nd[0], nd[1], 1 / (c.R * pos));
          G(nd[1], nd[2], 1 / (c.R * (1 - pos)));
          break;
        }
        case 'SW':
          G(nd[0], nd[1], c.closed ? 1 / (c.Ron || RON) : 1 / ROFF);
          break;
        case 'I':
          I(nd[0], nd[1], sourceValue(c, t) * srcScale);
          break;
        case 'V':
        case 'AMMETER': {
          const k = this.branchIndex[c.id];
          const [p, m] = nd;
          if (p >= 0) { A[p][k] += 1; A[k][p] += 1; }
          if (m >= 0) { A[m][k] -= 1; A[k][m] -= 1; }
          b[k] += c.type === 'V' ? sourceValue(c, t) * srcScale : 0;
          break;
        }
        case 'C': {
          if (!dt) { G(nd[0], nd[1], 1e-10); break; }
          const g = c.C / dt;
          const v0 = st ? st.v : (c.v0 || 0);
          G(nd[0], nd[1], g);
          I(nd[0], nd[1], -g * v0);
          break;
        }
        case 'L': {
          if (!dt) { G(nd[0], nd[1], 1 / RON); break; }
          const g = dt / c.L;
          G(nd[0], nd[1], g);
          I(nd[0], nd[1], st ? st.i : 0);
          break;
        }
        case 'MOTOR': {
          // armature: v = i·R + Ke·ω  →  Norton equivalent with ω from the previous step
          const g = 1 / Math.max(c.R || 1, 1e-6);
          const e = (c.Ke || 0.05) * (st ? st.w : 0);
          G(nd[0], nd[1], g);
          I(nd[0], nd[1], -e * g);
          break;
        }
        case 'D':
        case 'LED': {
          const { Is, n } = diodeParams(c);
          const nvt = n * VT;
          const vd = this._v(x, nd[0]) - this._v(x, nd[1]);
          const id = Is * (limexp(vd / nvt) - 1);
          const gd = (Is / nvt) * dlimexp(vd / nvt) + GMIN;
          G(nd[0], nd[1], gd);
          I(nd[0], nd[1], id - gd * vd);
          break;
        }
        case 'NPN':
        case 'PNP': {
          const s = c.type === 'NPN' ? 1 : -1; // PNP: mirror all voltages and currents
          const Is = c.Is || 1e-14;
          const bf = c.beta || 100;
          const br = c.betaR || 1;
          const v = [this._v(x, nd[0]), this._v(x, nd[1]), this._v(x, nd[2])];
          const vbe = s * (v[1] - v[2]);
          const vbc = s * (v[1] - v[0]);
          const ebe = limexp(vbe / VT);
          const ebc = limexp(vbc / VT);
          const debe = dlimexp(vbe / VT) / VT;
          const debc = dlimexp(vbc / VT) / VT;
          const ic = Is * (ebe - ebc) - (Is / br) * (ebc - 1);
          const ib = (Is / bf) * (ebe - 1) + (Is / br) * (ebc - 1);
          const dic = [Is * debe, -Is * debc - (Is / br) * debc]; // d/dvbe, d/dvbc
          const dib = [(Is / bf) * debe, (Is / br) * debc];
          // chain rule to node voltages [C,B,E]; the two factors s cancel
          const Jc = [-dic[1], dic[0] + dic[1], -dic[0]];
          const Jb = [-dib[1], dib[0] + dib[1], -dib[0]];
          const Je = [-(Jc[0] + Jb[0]), -(Jc[1] + Jb[1]), -(Jc[2] + Jb[2])];
          NL(nd, v, [s * ic, s * ib, -s * (ic + ib)], [Jc, Jb, Je]);
          G(nd[1], nd[2], GMIN * 10);
          G(nd[1], nd[0], GMIN * 10);
          break;
        }
        case 'NMOS':
        case 'PMOS': {
          const s = c.type === 'NMOS' ? 1 : -1;
          const Vt = Math.abs(c.Vt ?? 2);
          const K = c.K || 0.5;
          const lambda = c.lambda || 0;
          const v = [this._v(x, nd[0]), this._v(x, nd[1]), this._v(x, nd[2])]; // D,G,S
          let vgs = s * (v[1] - v[2]);
          let vds = s * (v[0] - v[2]);
          // the channel is symmetric: for vds < 0 drain and source swap roles
          const rev = vds < 0;
          if (rev) { vgs -= vds; vds = -vds; }
          const [id0, gm, gds] = mosCurrent(vgs, vds, Vt, K, lambda);
          let Jd;
          let id;
          if (!rev) {
            id = id0; // into drain
            Jd = [gds, gm, -(gm + gds)];
          } else {
            // vgs' = vg - vd, vds' = vs - vd, current flows S→D inside: into drain = -id0
            id = -id0;
            Jd = [gm + gds, -gm, -gds];
          }
          const Jz = [0, 0, 0];
          NL(nd, v, [s * id, 0, -s * id], [Jd, Jz, [-Jd[0], -Jd[1], -Jd[2]]]);
          G(nd[0], nd[2], GMIN * 10);
          break;
        }
        case 'RELAY': {
          G(nd[0], nd[1], 1 / Math.max(c.Rcoil || 400, 1e-3));
          const on = st ? st.on : false;
          const poles = c.poles || [];
          for (let k = 0; k < poles.length; k++) {
            const closed = poles[k] === 'NC' ? !on : on;
            G(nd[2 + 2 * k], nd[3 + 2 * k], closed ? 1 / RON : 1 / ROFF);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  _lampR(c) {
    const hot = Math.max(c.R || 100, 1e-3);
    if (!c.thermal) return hot;
    const st = this.state[c.id];
    const heat = st ? st.heat : 0; // 0 cold … 1 at rated power
    return hot * (0.1 + 0.9 * Math.min(1.2, Math.sqrt(Math.max(0, heat))));
  }

  /** Relay pull-in / drop-out with hysteresis. Returns true if a contact changed. */
  _updateRelays(x) {
    let changed = false;
    this.components.forEach((c, ci) => {
      if (c.type !== 'RELAY') return;
      const nd = this.compNodes[ci];
      const vcoil = Math.abs(this._v(x, nd[0]) - this._v(x, nd[1]));
      const st = this.state[c.id] || { on: false };
      const rated = c.Vrated || 12;
      let on = st.on;
      if (!on && vcoil >= (c.Vpull || 0.75 * rated)) on = true;
      else if (on && vcoil < (c.Vdrop || 0.3 * rated)) on = false;
      if (on !== st.on) changed = true;
      this.state[c.id] = { ...st, on };
    });
    return changed;
  }

  /** Solve once: dt = null → DC operating point, otherwise one backward-Euler step. */
  step(dt = null) {
    const t = dt ? this.time + dt : null;
    let x = this.result && this.result.x && this.result.x.length === this.size ? this.result.x : new Float64Array(this.size);
    try {
      for (let outer = 0; outer < 8; outer++) {
        x = this._solve(x, dt, t);
        if (!this._updateRelays(x)) break;
      }
    } catch (e) {
      this.result = this._failure(e);
      return this.result;
    }
    this.result = this._report(x, dt);
    if (dt) this._commit(dt);
    return this.result;
  }

  /** Operating point; optionally make it the starting state of the transient (capacitors charged, …). */
  solveDC(adopt = false) {
    const r = this.step(null);
    if (adopt && r.ok) {
      for (const c of this.components) {
        const cr = r.comp[c.id];
        if (c.type === 'C') this.state[c.id] = { v: cr.v };
        if (c.type === 'L') this.state[c.id] = { i: cr.i };
      }
    }
    return r;
  }

  /**
   * Advance the transient by `span` seconds with adaptive steps.
   * Steps shrink when voltages move fast or Newton fails, and grow when things are quiet.
   * @param {(result) => void} [onStep] called after every accepted internal step (for the scope)
   */
  advance(span, { dtMax = span, dtMin = span * 1e-6, onStep } = {}) {
    const tEnd = this.time + span;
    let dt = Math.min(this.dt || dtMax / 8, dtMax);
    let prev = this.result && this.result.ok ? this.result : null;
    let guard = 0;
    while (this.time < tEnd - 1e-15 && guard++ < 20000) {
      dt = Math.max(dtMin, Math.min(dt, dtMax, tEnd - this.time));
      const savedState = this.state;
      this.state = { ...savedState };
      const savedTime = this.time;
      const r = this.step(dt);
      let reject = !r.ok;
      let change = 0;
      if (r.ok && prev) {
        let scale = 1;
        for (const k of this.nodeNames) {
          const a = Math.abs(r.nodeV[k]);
          if (a > scale) scale = a;
          const d = Math.abs(r.nodeV[k] - prev.nodeV[k]);
          if (d > change) change = d;
        }
        change /= scale;
        if (change > 0.08 && dt > dtMin * 1.001) reject = true;
      }
      if (reject && dt > dtMin * 1.001) {
        this.state = savedState;
        this.time = savedTime;
        this.result = prev || this.result;
        dt = Math.max(dtMin, dt / (r.ok ? 2 : 4));
        continue;
      }
      if (!r.ok) return r; // failed even at the smallest step
      prev = r;
      if (onStep) onStep(r);
      if (change < 0.02) dt *= 1.5;
    }
    this.dt = dt;
    return this.result;
  }

  // ---- after an accepted transient step: integrate slow states --------------------
  _commit(dt) {
    const r = this.result;
    for (const c of this.components) {
      const cr = r.comp[c.id];
      switch (c.type) {
        case 'C': this.state[c.id] = { v: cr.v }; break;
        case 'L': this.state[c.id] = { i: cr.i }; break;
        case 'FUSE': {
          const st = this.state[c.id] || { blown: false, heat: 0 };
          // simple I²t model: heats above the rating, cools below
          const ratio = Math.abs(cr.i) / Math.max(c.Irated || 1, 1e-9);
          const heat = Math.max(0, st.heat + (ratio * ratio - 1) * dt / (c.tBlow || 0.05));
          this.state[c.id] = { blown: st.blown || heat >= 1, heat: Math.min(heat, 1) };
          break;
        }
        case 'LAMP': {
          if (!c.thermal) break;
          const st = this.state[c.id] || { heat: 0 };
          const target = cr.p / Math.max(c.Prated || 1, 1e-9);
          const k = Math.min(1, dt / (c.tau || 0.05));
          this.state[c.id] = { heat: st.heat + (target - st.heat) * k };
          break;
        }
        case 'MOTOR': {
          const st = this.state[c.id] || { w: 0 };
          const Kt = c.Ke || 0.05;
          const J = c.J || 1e-4;
          const torque = Kt * cr.i - (c.friction || 1e-5) * st.w - Math.sign(st.w || cr.i) * Math.min(Math.abs(Kt * cr.i), c.load || 0);
          this.state[c.id] = { w: st.w + (torque / J) * dt };
          break;
        }
        default: break;
      }
    }
    this.time += dt;
  }

  _failure(e) {
    const out = { ok: false, error: e.message, code: e.code || 'error', nodes: [], parts: [], nodeV: {}, comp: {}, time: this.time };
    if (e.code === 'singular') {
      const k = e.index;
      if (k < this.nodeNames.length) {
        out.nodes = [this.nodeNames[k]];
        out.parts = this.components.filter((c, ci) => this.compNodes[ci].includes(k)).map((c) => c.id);
        out.error = `The equations cannot be solved at node "${this.nodeNames[k]}": it is not held at a defined voltage.`;
      } else {
        out.parts = [this.branchOwner[k]];
        out.error = `The equations cannot be solved around "${this.branchOwner[k]}": voltage sources (or ammeters) form a loop or are shorted.`;
      }
    } else if (e.code === 'noconv') {
      out.parts = this.components.filter((c) => NONLINEAR.has(c.type)).map((c) => c.id);
      out.error = 'The solver did not converge. Check the highlighted diodes/transistors and their surrounding values.';
    }
    return out;
  }

  _report(x, dt) {
    const nodeV = { 0: 0 };
    for (const [name, i] of this.nodeIndex) nodeV[name] = x[i];
    const comp = {};
    const comps = this.components;
    for (let ci = 0; ci < comps.length; ci++) {
      const c = comps[ci];
      const nd = this.compNodes[ci];
      const st = this.state[c.id];
      const va = this._v(x, nd[0]);
      const vb = nd.length > 1 ? this._v(x, nd[1]) : 0;
      const v = va - vb;
      let i = 0;
      let pinI = null;
      let p = null;
      const extra = {};
      switch (c.type) {
        case 'R': i = v / Math.max(c.R, 1e-9); if (c.Pmax && Math.abs(v * i) > c.Pmax) extra.overload = Math.abs(v * i) / c.Pmax; break;
        case 'VOLTMETER': i = v * 1e-7; extra.reading = v; break;
        case 'LAMP': {
          i = v / this._lampR(c);
          const ratio = Math.abs(v * i) / Math.max(c.Prated || 1, 1e-9);
          extra.brightness = Math.min(1.5, ratio);
          if (ratio > 1.5) extra.overload = ratio;
          break;
        }
        case 'FUSE': {
          const blown = !!(st && st.blown);
          i = v * (blown ? 1 / ROFF : 1 / Math.max(c.R || 0.01, 1e-6));
          extra.blown = blown;
          extra.heat = st ? st.heat : 0;
          if (blown) extra.overload = 99;
          break;
        }
        case 'POT': {
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          const vw = this._v(x, nd[1]);
          const vc = this._v(x, nd[2]);
          const i1 = (va - vw) / (c.R * pos);
          const i2 = (vw - vc) / (c.R * (1 - pos));
          i = i1;
          pinI = [i1, i2 - i1, -i2];
          p = Math.abs((va - vw) * i1) + Math.abs((vw - vc) * i2);
          extra.vw = vw;
          break;
        }
        case 'SW': i = v * (c.closed ? 1 / (c.Ron || RON) : 1 / ROFF); break;
        case 'I': i = sourceValue(c, dt ? this.time + dt : null); p = Math.abs(v * i); break;
        case 'V':
        case 'AMMETER': {
          const ib = x[this.branchIndex[c.id]]; // flows + → − inside the source
          pinI = [ib, -ib];
          i = c.type === 'V' ? -ib : ib; // sources report delivered current
          extra.reading = ib;
          if (c.type === 'V' && c.Imax && Math.abs(ib) > c.Imax) extra.overload = Math.abs(ib) / c.Imax;
          break;
        }
        case 'C': {
          const v0 = st ? st.v : (c.v0 || 0);
          i = dt ? (c.C / dt) * (v - v0) : 0;
          if (c.Vmax && Math.abs(v) > c.Vmax) extra.overload = Math.abs(v) / c.Vmax;
          break;
        }
        case 'L': i = dt ? (st ? st.i : 0) + (dt / c.L) * v : v / RON; break;
        case 'MOTOR': {
          const w = st ? st.w : 0;
          i = (v - (c.Ke || 0.05) * w) / Math.max(c.R || 1, 1e-6);
          extra.rpm = (w * 60) / (2 * Math.PI);
          extra.w = w;
          break;
        }
        case 'D':
        case 'LED': {
          const { Is, n } = diodeParams(c);
          i = Is * (limexp(v / (n * VT)) - 1);
          if (c.type === 'LED') extra.brightness = Math.max(0, Math.min(1.5, i / (c.Irated || 0.02)));
          const imax = c.Imax || (c.type === 'LED' ? 0.03 : 1);
          if (i > imax) { extra.overcurrent = true; extra.overload = i / imax; }
          break;
        }
        case 'NPN':
        case 'PNP': {
          const s = c.type === 'NPN' ? 1 : -1;
          const Is = c.Is || 1e-14;
          const bf = c.beta || 100;
          const br = c.betaR || 1;
          const vc = va;
          const vbn = vb;
          const ve = this._v(x, nd[2]);
          const vbe = s * (vbn - ve);
          const vbc = s * (vbn - vc);
          const ebe = limexp(vbe / VT);
          const ebc = limexp(vbc / VT);
          const ic = Is * (ebe - ebc) - (Is / br) * (ebc - 1);
          const ib = (Is / bf) * (ebe - 1) + (Is / br) * (ebc - 1);
          i = ic;
          pinI = [s * ic, s * ib, -s * (ic + ib)];
          extra.ib = ib;
          extra.vbe = vbe;
          extra.vce = s * (vc - ve);
          extra.region = vbe < 0.5 ? 'cut-off' : extra.vce < 0.25 ? 'saturation' : 'active';
          p = Math.abs(extra.vce * ic) + Math.abs(vbe * ib);
          if (c.Icmax && Math.abs(ic) > c.Icmax) extra.overload = Math.abs(ic) / c.Icmax;
          break;
        }
        case 'NMOS':
        case 'PMOS': {
          const s = c.type === 'NMOS' ? 1 : -1;
          const vd = va;
          const vg = vb;
          const vs = this._v(x, nd[2]);
          let vgs = s * (vg - vs);
          let vds = s * (vd - vs);
          const rev = vds < 0;
          if (rev) { vgs -= vds; vds = -vds; }
          const Vt = Math.abs(c.Vt ?? 2);
          const [id0] = mosCurrent(vgs, vds, Vt, c.K || 0.5, c.lambda || 0);
          const id = rev ? -id0 : id0;
          i = id;
          pinI = [s * id, 0, -s * id];
          extra.vgs = s * (vg - vs);
          extra.vds = s * (vd - vs);
          extra.region = vgs <= Vt ? 'cut-off' : vds < vgs - Vt ? 'linear' : 'saturation';
          p = Math.abs(extra.vds * id);
          if (c.Idmax && Math.abs(id) > c.Idmax) extra.overload = Math.abs(id) / c.Idmax;
          break;
        }
        case 'RELAY': {
          i = v / Math.max(c.Rcoil || 400, 1e-3);
          const on = st ? st.on : false;
          extra.on = on;
          pinI = [i, -i];
          const poles = c.poles || [];
          extra.poleI = [];
          for (let k = 0; k < poles.length; k++) {
            const closed = poles[k] === 'NC' ? !on : on;
            const ip = (this._v(x, nd[2 + 2 * k]) - this._v(x, nd[3 + 2 * k])) * (closed ? 1 / RON : 1 / ROFF);
            pinI.push(ip, -ip);
            extra.poleI.push(ip);
          }
          p = Math.abs(v * i);
          break;
        }
        default: break;
      }
      comp[c.id] = { v, i, p: p == null ? Math.abs(v * i) : p, pinI: pinI || [i, -i], ...extra };
    }
    return { ok: true, converged: true, x, nodeV, comp, time: dt ? this.time + dt : this.time };
  }
}

/**
 * Resistance seen between two nodes with all sources switched off, the way a
 * multimeter on the Ω range sees a de-energised circuit: voltage sources → shorts,
 * current sources → open, capacitors → open, inductors → shorts, switches as set,
 * semiconductors → open (the test voltage stays below their threshold).
 */
export function resistanceBetween(components, nodeA, nodeB, state = {}) {
  if (String(nodeA) === String(nodeB)) return 0;
  const lin = [];
  for (const c of components) {
    switch (c.type) {
      case 'V': case 'AMMETER': case 'L': lin.push({ id: c.id, type: 'R', nodes: c.nodes.slice(0, 2), R: RON }); break;
      case 'R': case 'SW': case 'POT': case 'VOLTMETER': lin.push({ ...c }); break;
      case 'LAMP': lin.push({ id: c.id, type: 'R', nodes: c.nodes, R: c.thermal ? c.R / 10 : c.R }); break;
      case 'MOTOR': lin.push({ id: c.id, type: 'R', nodes: c.nodes, R: c.R || 1 }); break;
      case 'FUSE': lin.push({ id: c.id, type: 'R', nodes: c.nodes, R: state[c.id] && state[c.id].blown ? ROFF : (c.R || 0.01) }); break;
      case 'RELAY': {
        lin.push({ id: c.id, type: 'R', nodes: c.nodes.slice(0, 2), R: c.Rcoil || 400 });
        (c.poles || []).forEach((kind, k) => {
          if (kind === 'NC') lin.push({ id: `${c.id}.${k}`, type: 'R', nodes: [c.nodes[2 + 2 * k], c.nodes[3 + 2 * k]], R: RON });
        });
        break;
      }
      default: break; // C, I, semiconductors: open
    }
  }
  // Solve with nodeB as the reference: rename nodes so B becomes ground.
  const ren = (n) => (String(n) === String(nodeB) ? '0' : String(n) === '0' ? '__gnd' : String(n));
  const net = lin.map((c) => ({ ...c, nodes: c.nodes.map(ren) }));
  net.push({ id: '__test', type: 'I', nodes: ['0', ren(nodeA)], I: 1 });
  const r = new Circuit(net).step();
  if (!r.ok) return Infinity;
  const v = r.nodeV[ren(nodeA)];
  return v > 5e7 ? Infinity : Math.max(0, v);
}
