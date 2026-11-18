// Modified Nodal Analysis circuit solver.
// Supports: R, V (DC source), I (current source), C (backward-Euler transient),
// L (backward-Euler), switch, diode / LED (Shockley, Newton-Raphson),
// NPN transistor (Ebers-Moll transport model), relay (coil + contact w/ hysteresis),
// lamp (resistor with brightness), potentiometer (two resistors).
//
// Component format: { id, type, nodes: [...], ...params }. Node '0' / 'GND' is ground.

const VT = 0.025852; // thermal voltage at ~300K
const GMIN = 1e-12;

function solveLinear(A, b) {
  // Gaussian elimination with partial pivoting (in place on copies)
  const n = b.length;
  const M = A.map((r) => r.slice());
  const x = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    let best = Math.abs(M[c][c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(M[r][c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-18) throw new Error('Singular matrix – check for floating nodes or source loops');
    if (piv !== c) {
      [M[c], M[piv]] = [M[piv], M[c]];
      [x[c], x[piv]] = [x[piv], x[c]];
    }
    const d = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f === 0) continue;
      const Mr = M[r];
      const Mc = M[c];
      for (let k = c; k < n; k++) Mr[k] -= f * Mc[k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// exp with linear continuation to avoid overflow during Newton iterations
function limexp(x) {
  const X = 40;
  if (x < X) return Math.exp(x);
  return Math.exp(X) * (1 + x - X);
}
function dlimexp(x) {
  const X = 40;
  return x < X ? Math.exp(x) : Math.exp(X);
}

export const DIODE_MODELS = {
  si: { Is: 2.52e-9, n: 1.752 },
  red: { Is: 1e-18, n: 1.9 }, // ~1.8–2.0V @ 10mA
  green: { Is: 1e-20, n: 2.0 },
  blue: { Is: 1e-26, n: 2.1 }, // ~3V
  white: { Is: 1e-26, n: 2.1 },
  yellow: { Is: 1e-19, n: 1.95 },
};

export class Circuit {
  constructor(components) {
    this.components = components.map((c) => ({ ...c }));
    this.time = 0;
    this.state = {}; // per-component dynamic state (capacitor voltage, inductor current, relay state)
    this.result = null;
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
    // extra MNA unknowns: currents through voltage sources & inductors (DC) — we use V-sources only
    let k = nodes.size;
    this.branchIndex = {};
    for (const c of this.components) {
      if (c.type === 'V') this.branchIndex[c.id] = k++;
    }
    this.size = k;
  }

  get(id) {
    return this.components.find((c) => c.id === id);
  }

  set(id, key, value) {
    const c = this.get(id);
    if (c) c[key] = value;
  }

  /** Solve operating point (dt = null) or one transient step of dt seconds. */
  step(dt = null) {
    const n = this.size;
    const nn = this.nodeIndex.size;
    let x = this.result ? this.result.x.slice() : new Array(n).fill(0);
    if (x.length !== n) x = new Array(n).fill(0);
    // relay contact iteration (outer loop) – re-solve when a contact changes state
    let converged = false;
    for (let outer = 0; outer < 6; outer++) {
      converged = false;
      for (let it = 0; it < 300; it++) {
        const A = Array.from({ length: n }, () => new Array(n).fill(0));
        const b = new Array(n).fill(0);
        for (let i = 0; i < nn; i++) A[i][i] += GMIN;
        this._stamp(A, b, x, dt);
        let xn;
        try {
          xn = solveLinear(A, b);
        } catch (e) {
          this.result = { error: e.message, x, nodeV: {}, comp: {} };
          return this.result;
        }
        let maxd = 0;
        for (let i = 0; i < nn; i++) maxd = Math.max(maxd, Math.abs(xn[i] - x[i]));
        if (this._nonlinear && maxd > 0.5) {
          const s = 0.5 / maxd; // damp Newton step
          for (let i = 0; i < n; i++) xn[i] = x[i] + (xn[i] - x[i]) * s;
        }
        x = xn;
        if (!this._nonlinear || maxd < 1e-7) { converged = true; break; }
      }
      if (!this._updateRelays(x)) break;
    }
    this.result = this._report(x, dt, converged);
    // commit dynamic state
    if (dt) {
      for (const c of this.components) {
        const r = this.result.comp[c.id];
        if (c.type === 'C') this.state[c.id] = { v: r.v };
        if (c.type === 'L') this.state[c.id] = { i: r.i };
      }
      this.time += dt;
    }
    return this.result;
  }

  _v(x, ni) {
    return ni < 0 ? 0 : x[ni];
  }

  _stamp(A, b, x, dt) {
    this._nonlinear = false;
    const G = (a, c, g) => {
      if (a >= 0) A[a][a] += g;
      if (c >= 0) A[c][c] += g;
      if (a >= 0 && c >= 0) { A[a][c] -= g; A[c][a] -= g; }
    };
    const I = (a, c, i) => {
      // current i flowing from node a to node c through the element (leaving a)
      if (a >= 0) b[a] -= i;
      if (c >= 0) b[c] += i;
    };
    this.components.forEach((c, ci) => {
      const nd = this.compNodes[ci];
      switch (c.type) {
        case 'R':
        case 'LAMP':
          G(nd[0], nd[1], 1 / Math.max(c.R, 1e-6));
          break;
        case 'POT': {
          // nodes: [a, wiper, b], R total, pos 0..1
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          G(nd[0], nd[1], 1 / (c.R * pos));
          G(nd[1], nd[2], 1 / (c.R * (1 - pos)));
          break;
        }
        case 'SW':
          G(nd[0], nd[1], c.closed ? 1e3 : 1e-9);
          break;
        case 'I':
          I(nd[0], nd[1], c.I);
          break;
        case 'V': {
          const k = this.branchIndex[c.id];
          const [p, m] = nd;
          if (p >= 0) { A[p][k] += 1; A[k][p] += 1; }
          if (m >= 0) { A[m][k] -= 1; A[k][m] -= 1; }
          b[k] += c.V;
          break;
        }
        case 'C': {
          if (!dt) { G(nd[0], nd[1], 1e-9); break; }
          const g = c.C / dt;
          const v0 = this.state[c.id] ? this.state[c.id].v : (c.v0 || 0);
          G(nd[0], nd[1], g);
          I(nd[0], nd[1], -g * v0);
          break;
        }
        case 'L': {
          if (!dt) { G(nd[0], nd[1], 1e3); break; }
          const g = dt / c.L;
          const i0 = this.state[c.id] ? this.state[c.id].i : 0;
          G(nd[0], nd[1], g);
          I(nd[0], nd[1], i0);
          break;
        }
        case 'D':
        case 'LED': {
          this._nonlinear = true;
          const m = DIODE_MODELS[c.model || (c.type === 'LED' ? 'red' : 'si')];
          const nvt = m.n * VT;
          const vd = this._v(x, nd[0]) - this._v(x, nd[1]);
          const id = m.Is * (limexp(vd / nvt) - 1);
          const gd = (m.Is / nvt) * dlimexp(vd / nvt) + GMIN;
          G(nd[0], nd[1], gd);
          I(nd[0], nd[1], id - gd * vd);
          break;
        }
        case 'NPN': {
          // nodes: [C, B, E]
          this._nonlinear = true;
          const Is = c.Is || 1e-14;
          const bf = c.beta || 100;
          const br = 1;
          const [nc, nb, ne] = nd;
          const vb = this._v(x, nb);
          const vbe = vb - this._v(x, ne);
          const vbc = vb - this._v(x, nc);
          const ebe = limexp(vbe / VT);
          const ebc = limexp(vbc / VT);
          const debe = dlimexp(vbe / VT) / VT;
          const debc = dlimexp(vbc / VT) / VT;
          // terminal currents INTO the device at C and B (E = -(Ic+Ib))
          const ict = Is * (ebe - ebc);
          const ic = ict - (Is / br) * (ebc - 1);
          const ib = (Is / bf) * (ebe - 1) + (Is / br) * (ebc - 1);
          // partial derivatives wrt vbe, vbc
          const dic_dvbe = Is * debe;
          const dic_dvbc = -Is * debc - (Is / br) * debc;
          const dib_dvbe = (Is / bf) * debe;
          const dib_dvbc = (Is / br) * debc;
          // express in node voltages: vbe = vb - ve, vbc = vb - vc
          // dI/dvc = -d/dvbc ; dI/dvb = d/dvbe + d/dvbc ; dI/dve = -d/dvbe
          const rows = [
            [nc, ic, [-dic_dvbc, dic_dvbe + dic_dvbc, -dic_dvbe]],
            [nb, ib, [-dib_dvbc, dib_dvbe + dib_dvbc, -dib_dvbe]],
          ];
          const ie = -(ic + ib);
          rows.push([ne, ie, [
            -(rows[0][2][0] + rows[1][2][0]),
            -(rows[0][2][1] + rows[1][2][1]),
            -(rows[0][2][2] + rows[1][2][2]),
          ]]);
          const vn = [this._v(x, nc), vb, this._v(x, ne)];
          const cols = [nc, nb, ne];
          for (const [row, cur, J] of rows) {
            if (row < 0) continue;
            // current into device from node = leaving node: KCL row gets +J
            let lin = cur;
            for (let j = 0; j < 3; j++) {
              lin -= J[j] * vn[j];
              if (cols[j] >= 0) A[row][cols[j]] += J[j];
            }
            b[row] -= lin;
          }
          // tiny junction conductances for stability
          G(nb, ne, GMIN * 10);
          G(nb, nc, GMIN * 10);
          break;
        }
        case 'RELAY': {
          // nodes: [coilA, coilB, p1a, p1b, p2a, p2b, ...]; poles: ['NO'|'NC', ...]
          G(nd[0], nd[1], 1 / c.Rcoil);
          const on = this.state[c.id] ? this.state[c.id].on : false;
          const poles = c.poles || ['NO'];
          poles.forEach((kind, k) => {
            const closed = kind === 'NC' ? !on : on;
            G(nd[2 + 2 * k], nd[3 + 2 * k], closed ? 1e3 : 1e-9);
          });
          break;
        }
        default:
          break;
      }
    });
  }

  _updateRelays(x) {
    let changed = false;
    this.components.forEach((c, ci) => {
      if (c.type !== 'RELAY') return;
      const nd = this.compNodes[ci];
      const vcoil = Math.abs(this._v(x, nd[0]) - this._v(x, nd[1]));
      const st = this.state[c.id] || { on: false };
      let on = st.on;
      if (!on && vcoil >= (c.Vpull || 0.75 * (c.Vrated || 12))) on = true;
      else if (on && vcoil < (c.Vdrop || 0.3 * (c.Vrated || 12))) on = false;
      if (on !== st.on) changed = true;
      this.state[c.id] = { on };
    });
    return changed;
  }

  _report(x, dt, converged) {
    const nodeV = { 0: 0, GND: 0 };
    for (const [name, i] of this.nodeIndex) nodeV[name] = x[i];
    const comp = {};
    this.components.forEach((c, ci) => {
      const nd = this.compNodes[ci];
      const va = this._v(x, nd[0]);
      const vb = this._v(x, nd[1]);
      const v = va - vb;
      let i = 0;
      const extra = {};
      switch (c.type) {
        case 'R': i = v / c.R; break;
        case 'LAMP': i = v / c.R; extra.brightness = Math.min(1.5, (v * i) / (c.Prated || 1)); break;
        case 'POT': {
          const pos = Math.min(0.999, Math.max(0.001, c.pos ?? 0.5));
          i = (va - this._v(x, nd[1])) / (c.R * pos);
          extra.vw = this._v(x, nd[1]);
          break;
        }
        case 'SW': i = v * (c.closed ? 1e3 : 1e-9); break;
        case 'I': i = c.I; break;
        case 'V': i = -x[this.branchIndex[c.id]]; break; // current delivered out of + terminal
        case 'C': {
          const v0 = this.state[c.id] ? this.state[c.id].v : (c.v0 || 0);
          i = dt ? (c.C / dt) * (v - v0) : 0;
          break;
        }
        case 'L': {
          const i0 = this.state[c.id] ? this.state[c.id].i : 0;
          i = dt ? i0 + (dt / c.L) * v : v * 1e3;
          break;
        }
        case 'D':
        case 'LED': {
          const m = DIODE_MODELS[c.model || (c.type === 'LED' ? 'red' : 'si')];
          i = m.Is * (Math.exp(Math.min(v / (m.n * VT), 80)) - 1);
          if (c.type === 'LED') extra.brightness = Math.max(0, Math.min(1.5, i / (c.Irated || 0.02)));
          if (c.type === 'LED' && i > (c.Imax || 0.03)) extra.overcurrent = true;
          break;
        }
        case 'NPN': {
          const [nc, nb, ne] = nd;
          const Is = c.Is || 1e-14;
          const bf = c.beta || 100;
          const vbe = this._v(x, nb) - this._v(x, ne);
          const vbc = this._v(x, nb) - this._v(x, nc);
          const ebe = Math.exp(Math.min(vbe / VT, 80));
          const ebc = Math.exp(Math.min(vbc / VT, 80));
          const ic = Is * (ebe - ebc) - Is * (ebc - 1);
          const ib = (Is / bf) * (ebe - 1) + Is * (ebc - 1);
          i = ic;
          extra.ib = ib;
          extra.vbe = vbe;
          extra.vce = this._v(x, nc) - this._v(x, ne);
          extra.region = vbe < 0.5 ? 'cut-off' : extra.vce < 0.25 ? 'saturation' : 'active';
          break;
        }
        case 'RELAY': {
          i = v / c.Rcoil;
          extra.on = this.state[c.id] ? this.state[c.id].on : false;
          break;
        }
      }
      comp[c.id] = { v, i, p: Math.abs(v * i), ...extra };
    });
    return { x, nodeV, comp, converged, time: this.time };
  }
}
