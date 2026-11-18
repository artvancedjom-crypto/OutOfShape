import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchText } from '../src/docs/matcher.js';
import { SAMPLES } from '../src/docs/samples-data.js';

const best = (t) => matchText(t)[0];
const param = (m, k) => (m.params.find((p) => p.key === k) || {}).value;

test('tank spec → tank scenario with parameters', () => {
  const m = best(SAMPLES.find((s) => s.name.includes('Tank')).text);
  assert.equal(m.id, 'tank');
  assert.ok(m.confidence > 0.8);
  assert.equal(param(m, 'capacity'), 2000);
  assert.equal(param(m, 'inflow'), 80);
  assert.equal(param(m, 'outflow'), 45);
  assert.equal(param(m, 'spLow'), 25);
  assert.equal(param(m, 'spHigh'), 85);
});

test('traffic lab sheet → traffic scenario, green 12 s, amber 3 s', () => {
  const m = best(SAMPLES.find((s) => s.name.includes('Traffic')).text);
  assert.equal(m.id, 'traffic');
  assert.equal(param(m, 'green'), 12);
  assert.equal(param(m, 'yellow'), 3);
});

test('RC experiment → rc circuit, R/C/V extracted', () => {
  const m = best(SAMPLES.find((s) => s.name.includes('RC')).text);
  assert.equal(m.id, 'rc');
  assert.equal(param(m, 'R'), 22000);
  assert.ok(Math.abs(param(m, 'C') - 47e-6) < 1e-12);
  assert.equal(param(m, 'V'), 9);
});

test('handout pages match LED and transistor separately', () => {
  const s = SAMPLES.find((x) => x.pages);
  assert.equal(best(s.pages[0]).id, 'led');
  assert.equal(param(best(s.pages[0]), 'R'), 470);
  const t = best(s.pages[1]);
  assert.equal(t.id, 'npn');
  assert.equal(param(t, 'RB'), 22000);
  assert.equal(param(t, 'beta'), 200);
});

test('unrelated text → no confident match', () => {
  const m = best('A recipe for banana bread: mix flour, sugar and eggs, bake for 40 minutes.');
  assert.ok(m.confidence < 0.35);
});
