import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Circuit } from '../src/circuits/mna.js';
const near = (a, b, tol) => assert.ok(Math.abs(a - b) < tol, `${a} !~ ${b}`);

test('divider', () => {
  const c = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 10 }, { id: 'R1', type: 'R', nodes: ['a', 'm'], R: 1000 }, { id: 'R2', type: 'R', nodes: ['m', '0'], R: 3000 }]);
  const r = c.step();
  near(r.nodeV.m, 7.5, 1e-6); near(r.comp.R1.i, 2.5e-3, 1e-9); near(r.comp.V1.i, 2.5e-3, 1e-9);
});
test('LED + resistor', () => {
  const c = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 9 }, { id: 'R1', type: 'R', nodes: ['a', 'k'], R: 330 }, { id: 'D1', type: 'LED', nodes: ['k', '0'], model: 'red' }]);
  const r = c.step();
  assert.ok(r.converged); console.log('LED Vf', r.comp.D1.v, 'I', r.comp.D1.i);
  near(r.comp.D1.v, 1.9, 0.25); near(r.comp.R1.i, r.comp.D1.i, 1e-6);
});
test('RC charge', () => {
  const c = new Circuit([{ id: 'V1', type: 'V', nodes: ['a', '0'], V: 5 }, { id: 'R1', type: 'R', nodes: ['a', 'c'], R: 1000 }, { id: 'C1', type: 'C', nodes: ['c', '0'], C: 1e-4 }]);
  let r; for (let k = 0; k < 1000; k++) r = c.step(1e-4);
  near(r.nodeV.c, 5 * (1 - Math.exp(-1)), 0.02);
});
test('NPN switch saturates', () => {
  const c = new Circuit([
    { id: 'V1', type: 'V', nodes: ['vcc', '0'], V: 9 }, { id: 'S1', type: 'SW', nodes: ['vcc', 'in'], closed: true },
    { id: 'RB', type: 'R', nodes: ['in', 'b'], R: 10000 }, { id: 'RC', type: 'R', nodes: ['vcc', 'led'], R: 470 },
    { id: 'D1', type: 'LED', nodes: ['led', 'c'], model: 'red' }, { id: 'Q1', type: 'NPN', nodes: ['c', 'b', '0'], beta: 150 }]);
  let r = c.step(); assert.ok(r.converged); console.log('Q', r.comp.Q1);
  assert.equal(r.comp.Q1.region, 'saturation'); assert.ok(r.comp.D1.i > 0.01);
  c.set('S1', 'closed', false); r = c.step();
  assert.ok(r.comp.D1.i < 1e-5); assert.equal(r.comp.Q1.region, 'cut-off');
});
test('relay', () => {
  const c = new Circuit([
    { id: 'V1', type: 'V', nodes: ['vcc', '0'], V: 12 }, { id: 'S1', type: 'SW', nodes: ['vcc', 'k'], closed: true },
    { id: 'K1', type: 'RELAY', nodes: ['k', '0', 'vcc', 'lamp', 'vcc', 'nc'], poles: ['NO', 'NC'], Rcoil: 400, Vrated: 12 },
    { id: 'L1', type: 'LAMP', nodes: ['lamp', '0'], R: 24, Prated: 6 }, { id: 'R9', type: 'R', nodes: ['nc', '0'], R: 1000 }]);
  let r = c.step(); assert.equal(r.comp.K1.on, true); near(r.nodeV.lamp, 12, 0.1);
  c.set('S1', 'closed', false); r = c.step(); assert.equal(r.comp.K1.on, false); near(r.nodeV.lamp, 0, 0.01);
});
