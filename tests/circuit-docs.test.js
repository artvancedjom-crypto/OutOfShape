import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Circuit, resistanceBetween } from '../src/circuits/mna.js';
import { buildNetlist, resultDiagnostics } from '../src/circuits/netlist.js';
import { templateDoc, TEMPLATE_IDS } from '../src/circuits/templates.js';
import { builder } from '../src/circuits/model.js';
import { parseSI, editSI } from '../src/circuits/units.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`);
const solve = (doc) => { const net = buildNetlist(doc); const c = new Circuit(net.components); return { net, c, r: c.step() }; };
const part = (doc, name) => doc.parts.find((p) => p.name === name || p.id === name);
const errors = (net) => net.diagnostics.filter((d) => d.level === 'error').map((d) => d.code);

test('SI notation', () => {
  near(parseSI('4k7'), 4700, 1e-9); near(parseSI('100n'), 1e-7, 1e-18); near(parseSI('2.2u'), 2.2e-6, 1e-15);
  near(parseSI('1M'), 1e6, 1e-6); near(parseSI('10 mA'), 0.01, 1e-12); near(parseSI('2R2'), 2.2, 1e-12);
  near(parseSI('470 Ω'), 470, 1e-9); near(parseSI('1e-3'), 1e-3, 1e-15); assert.ok(Number.isNaN(parseSI('abc')));
  near(parseSI(editSI(4700)), 4700, 1e-9); near(parseSI(editSI(47e-6)), 47e-6, 1e-15);
});

test('every template builds without errors and solves', () => {
  for (const id of TEMPLATE_IDS) {
    const { net, r } = solve(templateDoc(id));
    assert.deepEqual(net.diagnostics, [], `${id}: ${JSON.stringify(net.diagnostics)}`);
    assert.ok(r.ok, `${id}: ${r.error}`);
  }
});

test('voltage divider: 12 V, 1k / 2k2 → 8.25 V; loaded with 4k7 → 7.20 V', () => {
  const doc = templateDoc('divider');
  let { net, r } = solve(doc);
  const m = net.nodeAt(16, 4);
  near(r.nodeV[m], 12 * 2200 / 3200, 1e-3);            // hand: 8.25 V
  near(r.comp.R1.i, 12 / 3200, 1e-7);                  // hand: 3.75 mA
  part(doc, 'S1').params.closed = true;
  ({ net, r } = solve(doc));
  const rp = (2200 * 4700) / (2200 + 4700);            // 1498.55 Ω
  near(r.nodeV[net.nodeAt(16, 4)], 12 * rp / (1000 + rp), 2e-3); // hand: 7.197 V
  near(r.comp.R2.i + r.comp.R3.i, r.comp.R1.i, 1e-5);  // KCL at the tap
});

test('series and parallel networks', () => {
  // 10 V across 100 Ω + (300 Ω ∥ 600 Ω) + 200 Ω  → Rtotal = 100 + 200 + 200 = 500 Ω, I = 20 mA
  const b = builder('sp');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 10 } }).part('R', 'R1', 4, 0, { params: { R: 100 } })
    .part('R', 'R2', 10, 0, { params: { R: 300 } }).part('R', 'R3', 10, 3, { params: { R: 600 } }).part('R', 'R4', 16, 0, { params: { R: 200 } }).gnd(0, 8)
    .wire('V1.+', 'R1.1', 'vh').wire('R1.2', 'R2.1').wire('R2.2', 'R4.1').wire([8, 0], [8, 3]).wire([12, 0], [12, 3])
    .wire('R4.2', [18, 7], 'hv').wire([18, 7], [0, 7]).wire('V1.-', 'GND1.gnd');
  const { net, r } = solve(b.doc);
  assert.deepEqual(errors(net), []);
  near(r.comp.R1.i, 0.02, 1e-6); near(r.comp.R2.i, 0.02 * 600 / 900, 1e-6); near(r.comp.R3.i, 0.02 * 300 / 900, 1e-6);
  near(r.comp.R4.v, 4, 1e-4); near(r.comp.V1.i, 0.02, 1e-6);
  // ohmmeter across the parallel pair, sources off (source = short):
  // (300 ∥ 600) ∥ (100 + 200) = 200 ∥ 300 = 120 Ω
  near(resistanceBetween(net.components, net.nodeAt(8, 0), net.nodeAt(12, 0)), 120, 0.01, 'ohmmeter');
});

test('wires that cross are not connected; a wire end on a wire is', () => {
  const mk = (join) => {
    const b = builder('x');
    b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 10 } }).part('R', 'R1', 6, 2, { params: { R: 1000 } }).gnd(0, 8)
      .wire('V1.+', [0, 0], [10, 0]).wire('V1.-', 'GND1.gnd').wire('R1.2', [8, 7], 'hv').wire([8, 7], [0, 7]);
    // vertical wire from R1.1 upward: crossing the top rail (ends beyond it) or ending on it
    b.wire('R1.1', [4, join ? 0 : -2]);
    return b.doc;
  };
  let { net, r } = solve(mk(true));
  near(r.comp.R1.i, 0.01, 1e-7);
  assert.equal(net.junctions.length >= 1, true);
  ({ net, r } = solve(mk(false)));
  near(r.comp.R1.i, 0, 1e-6, 'crossing must not conduct');
});

test('net labels connect wire ends with the same name', () => {
  const b = builder('lbl');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 5 } }).part('R', 'R1', 10, 4, { rot: 1, params: { R: 500 } }).gnd(0, 8).gnd(10, 8, 'G2')
    .wire('V1.+', [0, 0], [3, 0]).wire('R1.1', [10, 0], [7, 0]).wire('V1.-', 'GND1.gnd').wire('R1.2', 'G2.gnd')
    .label([3, 0], 'VCC').label([7, 0], 'VCC');
  const { r } = solve(b.doc);
  near(r.comp.R1.i, 0.01, 1e-7);
});

test('RC charging: τ = R·C, 63.2 % after 1τ, 99.3 % after 5τ (adaptive steps)', () => {
  const doc = templateDoc('rc');
  part(doc, 'S1').params.closed = false; // position a = source
  const net = buildNetlist(doc);
  const c = new Circuit(net.components);
  const tau = 10000 * 100e-6; // 1 s
  let steps = 0;
  c.advance(tau, { dtMax: tau / 20, onStep: () => steps++ });
  const node = net.nodeAt(23, 7);
  near(c.result.nodeV[node], 5 * (1 - Math.exp(-1)), 0.06, 'V_C(τ)'); // hand: 3.161 V
  c.advance(4 * tau, { dtMax: tau / 20 });
  near(c.result.nodeV[node], 5 * (1 - Math.exp(-5)), 0.03, 'V_C(5τ)'); // hand: 4.966 V
  assert.ok(steps >= 20 && steps < 2000, `steps ${steps}`);
  // discharge
  c.set('S1', 'closed', true); c.set('S1#b', 'closed', true); c.set('S1', 'closed', false);
});

test('LED with series resistor: current within ±5 % of the hand calculation', () => {
  // red LED model: Is = 1e-18 A, n = 1.9. Solve Is·(e^(V/nVt) − 1) = (9 − V)/390 by bisection.
  const nvt = 1.9 * 0.025852;
  let lo = 0; let hi = 9;
  for (let k = 0; k < 80; k++) { const v = (lo + hi) / 2; if (1e-18 * (Math.exp(v / nvt) - 1) > (9 - v) / 390) hi = v; else lo = v; }
  const iHand = (9 - lo) / 390; // ≈ 18.4 mA at Vf ≈ 1.84 V
  const { r } = solve(templateDoc('led'));
  assert.ok(Math.abs(r.comp.D1.i - iHand) / iHand < 0.05, `LED ${r.comp.D1.i} vs ${iHand}`);
  near(r.comp.D1.v, lo, 0.02);
  // rule-of-thumb check as well: (9 V − ~1.9 V) / 390 Ω ≈ 18 mA
  assert.ok(Math.abs(r.comp.D1.i - (9 - 1.9) / 390) / 0.0182 < 0.05);
});

test('BJT switch saturates: V_CE < 0.25 V, I_C set by the load, I_C/I_B < β', () => {
  const { r } = solve(templateDoc('npn'));
  const q = r.comp.Q1;
  assert.equal(q.region, 'saturation');
  assert.ok(q.vce < 0.25);
  near(q.ib, (3.3 - 0.73) / 10000, 2e-5);              // hand: ≈ 257 µA
  near(q.i, (9 - 2.2 - q.vce) / 330, 1.5e-3);          // hand: ≈ 20 mA through RC + green LED
  assert.ok(q.i / q.ib < 120);
  near(q.pinI[0] + q.pinI[1] + q.pinI[2], 0, 1e-12);
});

test('relay latching circuit: START latches, STOP releases', () => {
  const doc = templateDoc('relay');
  const net = buildNetlist(doc);
  const c = new Circuit(net.components);
  const lamp = (id) => net.partResult(part(doc, id), c.result).p;
  c.step();
  assert.equal(c.result.comp.K1.on, false); assert.ok(lamp('L2') > 2.5 && lamp('L1') < 1e-6);
  c.set('S1', 'closed', true); c.step();
  assert.equal(c.result.comp.K1.on, true);
  c.set('S1', 'closed', false); c.step();
  assert.equal(c.result.comp.K1.on, true, 'holds after START is released');
  near(lamp('L1'), 12 * 12 / 48, 0.05); assert.ok(lamp('L2') < 1e-6);   // hand: 3 W
  near(c.result.comp.K1.i, 12 / 400, 1e-4);                             // hand: 30 mA
  c.set('S2', 'closed', false); c.step();                               // STOP pressed (NC opens)
  assert.equal(c.result.comp.K1.on, false);
  c.set('S2', 'closed', true); c.step();
  assert.equal(c.result.comp.K1.on, false, 'stays off after STOP is released');
});

test('NMOS square law: saturation and linear region', () => {
  // Vt = 2 V, K = 0.5 A/V², Vgs = 4 V → Id,sat = 0.5·0.5·(4−2)² = 1 A (if Vds ≥ 2 V)
  const sat = new Circuit([{ id: 'VD', type: 'V', nodes: ['d', '0'], V: 10 }, { id: 'VG', type: 'V', nodes: ['g', '0'], V: 4 }, { id: 'M1', type: 'NMOS', nodes: ['d', 'g', '0'], Vt: 2, K: 0.5 }]).step();
  near(sat.comp.M1.i, 1.0, 1e-6); assert.equal(sat.comp.M1.region, 'saturation');
  // switch with 100 Ω load from 10 V: linear region, Id ≈ 10 V / (100 Ω + Ron), Ron = 1/(K·Vov) = 1 Ω
  const lin = new Circuit([{ id: 'VD', type: 'V', nodes: ['v', '0'], V: 10 }, { id: 'RL', type: 'R', nodes: ['v', 'd'], R: 100 }, { id: 'VG', type: 'V', nodes: ['g', '0'], V: 4 }, { id: 'M1', type: 'NMOS', nodes: ['d', 'g', '0'], Vt: 2, K: 0.5 }]).step();
  assert.equal(lin.comp.M1.region, 'linear'); near(lin.comp.M1.i, 10 / 101, 1e-3);
  const off = new Circuit([{ id: 'VD', type: 'V', nodes: ['v', '0'], V: 10 }, { id: 'RL', type: 'R', nodes: ['v', 'd'], R: 100 }, { id: 'VG', type: 'V', nodes: ['g', '0'], V: 1 }, { id: 'M1', type: 'NMOS', nodes: ['d', 'g', '0'], Vt: 2, K: 0.5 }]).step();
  near(off.comp.M1.i, 0, 1e-6);
});

test('error: missing ground', () => {
  const b = builder('ng');
  b.part('V', 'V1', 0, 4, { rot: 1 }).part('R', 'R1', 6, 4, { rot: 1 }).wire('V1.+', [0, 0], [6, 0], 'R1.1').wire('V1.-', [0, 8], [6, 8], 'R1.2');
  const net = buildNetlist(b.doc);
  assert.deepEqual(errors(net), ['no-ground']);
  assert.equal(net.components.length, 0);
});

test('error: short circuit across a voltage source (wire), highlighted on the source', () => {
  const b = builder('short');
  b.part('V', 'V1', 0, 4, { rot: 1 }).gnd(0, 8).wire('V1.-', 'GND1.gnd').wire('V1.+', [0, 0], [3, 0], [3, 7], [0, 7]);
  const net = buildNetlist(b.doc);
  const d = net.diagnostics.find((x) => x.code === 'short');
  assert.ok(d && d.parts.includes('V1') && /Short circuit/.test(d.message));
  assert.ok(new Circuit(net.components).step().ok, 'rest of the circuit still solves');
});

test('error: short circuit through a closed switch is reported after solving', () => {
  const b = builder('short2');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 9 } }).part('SW', 'S1', 5, 0, { params: { closed: true } }).gnd(0, 8)
    .wire('V1.+', 'S1.1', 'vh').wire('S1.2', [7, 7], 'hv').wire([7, 7], [0, 7]).wire('V1.-', 'GND1.gnd');
  const { net, r } = solve(b.doc);
  const d = resultDiagnostics(b.doc, net, r).find((x) => x.code === 'short');
  assert.ok(d && d.parts.includes('V1'));
});

test('error: floating sub-circuit and unconnected part', () => {
  const b = builder('float');
  b.part('V', 'V1', 0, 4, { rot: 1 }).part('R', 'R1', 6, 4, { rot: 1 }).gnd(0, 8)
    .wire('V1.+', [0, 0], [6, 0], 'R1.1').wire('V1.-', 'GND1.gnd').wire('R1.2', [6, 7], [0, 7])
    // island: second source + resistor, no ground
    .part('V', 'V2', 12, 4, { rot: 1 }).part('R', 'R2', 18, 4, { rot: 1 }).wire('V2.+', [12, 0], [18, 0], 'R2.1').wire('V2.-', [12, 8], [18, 8], 'R2.2')
    // loose part
    .part('R', 'R9', 26, 4);
  const net = buildNetlist(b.doc);
  const fl = net.diagnostics.find((d) => d.code === 'floating');
  assert.deepEqual(fl.parts.sort(), ['R2', 'V2']);
  assert.ok(net.diagnostics.find((d) => d.code === 'unconnected').parts.includes('R9'));
  const r = new Circuit(net.components).step();
  assert.ok(r.ok); near(r.comp.R1.i, 9 / 1000, 1e-7, 'grounded part still simulates');
});

test('error: two voltage sources in parallel', () => {
  const b = builder('loop');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 9 } }).part('V', 'V2', 6, 4, { rot: 1, params: { V: 5 } }).gnd(0, 8)
    .wire('V1.+', [0, 0], [6, 0], 'V2.+').wire('V1.-', 'GND1.gnd').wire('V2.-', [6, 7], [0, 7]);
  const net = buildNetlist(b.doc);
  assert.deepEqual(errors(net), ['source-loop']);
});

test('solver reports a singular matrix instead of throwing', () => {
  const r = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 5 }, { id: 'V2', type: 'V', nodes: ['a', '0'], V: 3 }]).step();
  assert.equal(r.ok, false); assert.equal(r.code, 'singular'); assert.ok(r.parts.length > 0 && r.error.length > 20);
});

test('fuse blows above its rating and opens the circuit', () => {
  const c = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 12 }, { id: 'F1', type: 'FUSE', nodes: ['a', 'b'], Irated: 0.5, R: 0.05 }, { id: 'R1', type: 'R', nodes: ['b', '0'], R: 6 }]);
  c.advance(0.5, { dtMax: 0.01 });
  assert.equal(c.result.comp.F1.blown, true); assert.ok(Math.abs(c.result.comp.R1.i) < 1e-6);
});

test('DC motor spins up to (V − I·R)/Ke', () => {
  const c = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 6 }, { id: 'M1', type: 'MOTOR', nodes: ['a', '0'], R: 4, Ke: 0.03, J: 2e-5, friction: 2e-5 }]);
  near(c.step().comp.M1.i, 1.5, 1e-6, 'stall current');
  c.advance(3, { dtMax: 0.005 });
  const m = c.result.comp.M1;
  near(m.w, (6 - m.i * 4) / 0.03, 1); assert.ok(m.i < 0.3 && m.rpm > 1500);
});
