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

// ---- phase 2: wire currents ---------------------------------------------------------
import { buildFlowGraph, solveFlow } from '../src/circuits/flow.js';

test('wire currents obey KCL: divider with the load switched in', () => {
  const doc = templateDoc('divider');
  part(doc, 'S1').params.closed = true;
  const { net, r } = solve(doc);
  const g = solveFlow(buildFlowGraph(doc), net, r);
  const at = (x, y) => g.edges.filter((e) => Math.abs((e.a.x + e.b.x) / 2 - x) < 0.6 && Math.abs((e.a.y + e.b.y) / 2 - y) < 0.6);
  const i1 = r.comp.R1.i; const i2 = r.comp.R2.i; const i3 = r.comp.R3.i;
  // top rail between R1 and the tap carries all of I(R1); beyond the tap only I(R3)
  near(Math.abs(at(14, 4)[0].i), i1, 1e-9, 'before the tap');
  near(Math.abs(at(17.5, 4)[0].i), i3, 1e-9, 'after the tap');
  near(Math.abs(at(16, 5.5)[0].i), i2, 1e-9, 'down to R2');
  // bottom rail: return current adds up again toward the source
  near(Math.abs(at(10, 13)[0].i), i1, 1e-9, 'return to the source');
  near(Math.abs(at(20.5, 13)[0].i), i3, 1e-9, 'return from R3');
  // every part path equals the part current
  for (const pp of g.partPaths.filter((x) => x.part.name === 'R2')) near(pp.i, i2, 1e-12);
  // direction: current leaves V1+ (4,7) upward, i.e. from the pin toward the top rail
  const up = g.edges.find((e) => Math.abs(e.a.x - 4) < 0.01 && Math.abs(e.b.x - 4) < 0.01 && Math.min(e.a.y, e.b.y) < 7 && Math.max(e.a.y, e.b.y) <= 7.01);
  const towardTop = up.a.y > up.b.y ? up.i : -up.i;
  near(towardTop, i1, 1e-9, 'conventional current flows out of the + terminal');
});

test('no current, no flow: open switch leaves every edge at zero', () => {
  const doc = templateDoc('led');
  part(doc, 'S1').params.closed = false;
  const { net, r } = solve(doc);
  const g = solveFlow(buildFlowGraph(doc), net, r);
  assert.ok(g.edges.every((e) => Math.abs(e.i) < 1e-7));
  assert.ok(g.partPaths.every((p) => Math.abs(p.i) < 1e-7));
});

test('burned-out part becomes an open circuit and is reported', () => {
  const doc = templateDoc('led');
  part(doc, 'R1').params.R = 10; // ~700 mA through a 30 mA LED
  const net = buildNetlist(doc, { burned: new Set(['D1']) });
  const r = new Circuit(net.components).step();
  assert.ok(r.ok); near(r.comp.R1.i, 0, 1e-6);
  assert.equal(net.partResult(part(doc, 'D1'), r).burned, true);
  assert.ok(resultDiagnostics(doc, net, r).some((d) => d.code === 'burned'));
});

// ---- phase 3: catalog -----------------------------------------------------------------
import { registerEntry, fitDiodeIs, characteristic, exportEntries, validateEntry, defsUsedBy, registerDocDefs, subcircuitLayout } from '../src/circuits/catalog.js';
import { PARTS } from '../src/circuits/parts.js';
import { loadCircuit } from '../src/circuits/model.js';

test('variant: LED fitted to a datasheet point (3.2 V at 20 mA) carries that current', () => {
  const n = 2.2;
  const Is = fitDiodeIs(3.2, 0.02, n);
  registerEntry({ kind: 'variant', id: 'u_test_led', name: 'Blue LED 3.2V', base: 'LED', params: { Is, n, Irated: 0.02, Imax: 0.03, model: 'blue' } });
  assert.equal(PARTS.u_test_led.params.find((p) => p.key === 'n').def, n);
  // 5 V supply, series resistor (5 − 3.2)/0.02 = 90 Ω → the LED must sit at its datasheet point
  const b = builder('v');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 5 } }).part('R', 'R1', 5, 0, { params: { R: 90 } }).part('u_test_led', 'D1', 10, 4, { rot: 1 }).gnd(0, 8)
    .wire('V1.+', 'R1.1', 'vh').wire('R1.2', 'D1.A', 'hv').wire('V1.-', 'GND1.gnd').wire('D1.K', [10, 7], [0, 7]);
  const { net, r } = solve(b.doc);
  assert.deepEqual(errors(net), []);
  near(r.comp.D1.i, 0.02, 0.0002, 'I at the datasheet point'); near(r.comp.D1.v, 3.2, 0.01);
  // the curve preview passes through the same point
  const ch = characteristic('LED', { Is, n, Imax: 0.03, Irated: 0.02 });
  const pt = ch.series[0].pts.reduce((a, c) => (Math.abs(c[0] - 3.2) < Math.abs(a[0] - 3.2) ? c : a));
  assert.ok(Math.abs(pt[1] - 0.02) / 0.02 < 0.5 && ch.marks.length === 2);
});

test('variant: transistor with its own hFE; invalid entries are rejected with a reason', () => {
  registerEntry({ kind: 'variant', id: 'u_bc547c', name: 'BC547C', base: 'NPN', params: { beta: 520, Icmax: 0.1 } });
  assert.equal(PARTS.u_bc547c.params.find((p) => p.key === 'beta').def, 520);
  assert.equal(PARTS.u_bc547c.category, 'Semiconductors');
  assert.throws(() => validateEntry({ kind: 'variant', name: 'x', base: 'NOPE', params: {} }), /unknown model/);
  assert.throws(() => validateEntry({ kind: 'variant', name: 'x', base: 'R', params: { R: -5 } }), /below the minimum/);
  assert.throws(() => validateEntry({ kind: 'variant', name: 'x', base: 'R', params: { Q: 5 } }), /no parameter/);
  assert.throws(() => validateEntry({ kind: 'variant', name: '', base: 'R', params: {} }), /no name/);
  const ch = characteristic('NPN', { beta: 520, Is: 1e-14, Icmax: 0.1 });
  assert.equal(ch.series.length, 4); assert.ok(ch.series[3].pts.at(-1)[1] > ch.series[0].pts.at(-1)[1]);
  for (const t of ['NMOS', 'R', 'LAMP', 'RELAY', 'MOTOR', 'FUSE', 'C']) assert.ok(characteristic(t, Object.fromEntries(PARTS[t].params.map((p) => [p.key, p.def]))).series[0].pts.length > 2, t);
});

test('subcircuit: a divider saved as one part behaves like the flat circuit', () => {
  // inner: IN —R 1k— OUT —R 3k— ground
  const inner = builder('inner');
  inner.part('R', 'Ra', 4, 0, { params: { R: 1000 } }).part('R', 'Rb', 8, 3, { rot: 1, params: { R: 3000 } }).gnd(8, 7)
    .wire([0, 0], 'Ra.1').wire('Ra.2', [8, 0], 'Rb.1').wire([8, 0], [12, 0]).wire('Rb.2', 'GND1.gnd')
    .label([0, 0], 'IN').label([12, 0], 'OUT');
  const entry = registerEntry({ kind: 'subcircuit', id: 'u_div', name: 'Divider 1:4', category: 'Passive', prefix: 'X',
    pins: [{ name: 'IN', side: 'left' }, { name: 'OUT', side: 'right' }], circuit: { parts: inner.doc.parts, wires: inner.doc.wires, labels: inner.doc.labels } });
  const lay = subcircuitLayout(entry);
  assert.deepEqual(lay.pins.map((p) => [p.x, p.y]), [[-3, 0], [3, 0]]);
  const b = builder('outer');
  b.part('V', 'V1', 0, 4, { rot: 1, params: { V: 8 } }).part('u_div', 'X1', 8, 0).part('R', 'RL', 14, 4, { rot: 1, params: { R: 3000 } }).gnd(0, 9)
    .wire('V1.+', [0, 0], 'X1.IN').wire('X1.OUT', [14, 0], 'RL.1').wire('V1.-', 'GND1.gnd').wire('RL.2', [14, 8], [0, 8]);
  const { net, r } = solve(b.doc);
  assert.deepEqual(net.diagnostics, []);
  // hand: 3k ∥ 3k = 1.5k → OUT = 8 · 1.5/2.5 = 4.8 V; I(in) = 8/2.5k = 3.2 mA; I(load) = 1.6 mA
  near(r.nodeV[net.nodeAt(14, 0)], 4.8, 1e-6);
  const x = net.partResult(part(b.doc, 'X1'), r);
  near(x.pinI[0], 0.0032, 1e-9, 'current into IN'); near(x.pinI[1], -0.0016, 1e-9, 'current out of OUT');
  near(x.p, 0.0032 * 3.2 + 4.8 * 4.8 / 3000, 1e-9, 'power inside');
  // two instances do not share inner nodes
  const b2 = builder('two');
  b2.part('V', 'V1', 0, 4, { rot: 1, params: { V: 8 } }).part('u_div', 'X1', 8, 0).part('u_div', 'X2', 16, 0).gnd(0, 9)
    .wire('V1.+', [0, 0], 'X1.IN').wire('X1.OUT', 'X2.IN').wire('V1.-', 'GND1.gnd');
  const s2 = solve(b2.doc);
  // second divider (4k to ground) loads the first: 3k ∥ 4k = 1714.3 → 8·1714.3/2714.3 = 5.053 V, then ×3/4
  near(s2.r.nodeV[s2.net.nodeAt(11, 0)], 8 * (12000 / 7) / (1000 + 12000 / 7), 1e-6);
  near(s2.r.nodeV[s2.net.nodeAt(19, 0)], 0.75 * 8 * (12000 / 7) / (1000 + 12000 / 7), 1e-6);
});

test('custom parts travel with the circuit and with catalog exports', () => {
  const b = builder('carry');
  b.part('u_div', 'X1', 8, 0).part('u_bc547c', 'Q1', 20, 0);
  const defs = defsUsedBy(b.doc);
  assert.deepEqual(Object.keys(defs).sort(), ['u_bc547c', 'u_div']);
  const saved = JSON.parse(JSON.stringify({ ...b.doc, defs }));
  delete PARTS.u_div; delete PARTS.u_bc547c;
  assert.equal(loadCircuit(saved).parts.length, 0, 'unknown types are dropped without their definitions');
  registerDocDefs(saved);
  assert.equal(loadCircuit(saved).parts.length, 2, 'definitions embedded in the file restore them');
  const file = JSON.parse(exportEntries([PARTS.u_div.entry]));
  assert.equal(file.file, 'outofshape-catalog'); assert.equal(file.entries[0].name, 'Divider 1:4');
});

test('blue and white LEDs reach their forward voltage (≈3 V at 20 mA)', () => {
  for (const model of ['blue', 'white', 'green', 'red']) {
    const r = new Circuit([{ id: 'I1', type: 'I', nodes: ['0', 'a'], I: 0.02 }, { id: 'D1', type: 'LED', nodes: ['a', '0'], model }]).step();
    assert.ok(r.ok);
    const expected = { blue: 3.1, white: 3.1, green: 2.2, red: 1.85 }[model];
    near(r.comp.D1.v, expected, 0.2, model);
  }
});
