import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlcRuntime } from '../src/plc/runtime.js';

const io = { inputs: [{ name: 'Start' }, { name: 'Stop' }, { name: 'Level', type: 'REAL' }], outputs: [{ name: 'Motor' }, { name: 'Lamp' }, { name: 'Count', type: 'INT' }] };

test('seal-in circuit + TON + CASE + FOR', () => {
  const rt = new PlcRuntime(io);
  const r = rt.load('ST', `
PROGRAM Main
VAR
  T1 : TON;  C : CTU; i, acc : INT; state : INT := 0;
  K_IDLE : INT := 0; END_VAR
VAR CONSTANT RUN : INT := 1; END_VAR
Motor := (Start OR Motor) AND Stop;  // seal-in
T1(IN := Motor, PT := T#1s500ms);
Lamp := T1.Q;
C(CU := T1.Q, R := NOT Stop, PV := 3);
Count := C.CV;
acc := 0;
FOR i := 1 TO 4 DO acc := acc + i; END_FOR;
CASE state OF
  0: IF Motor THEN state := RUN; END_IF;
  RUN, 2..3: state := 5;
ELSE ;
END_CASE;
END_PROGRAM`);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  rt.running = true;
  rt.setInput('Stop', true);
  rt.scan(50);
  assert.equal(rt.getOutput('Motor'), false);
  rt.setInput('Start', true); rt.scan(50); rt.setInput('Start', false); rt.scan(50);
  assert.equal(rt.getOutput('Motor'), true);
  for (let k = 0; k < 27; k++) rt.scan(50);
  assert.equal(rt.getOutput('Lamp'), false);
  rt.scan(50); rt.scan(50);
  assert.equal(rt.getOutput('Lamp'), true);
  assert.equal(rt.getOutput('Count'), 1);
  assert.equal(rt.get('acc'), 10);
  assert.equal(rt.get('state'), 5);
});

test('errors carry line numbers', () => {
  const rt = new PlcRuntime(io);
  let r = rt.load('ST', 'Motor := Foo;');
  assert.equal(r.ok, false); assert.match(r.errors[0].msg, /Undeclared/);
  r = rt.load('ST', '\n\nStart := TRUE;');
  assert.equal(r.errors[0].line, 3);
  r = rt.load('ST', 'IF Start THEN Motor := TRUE;');
  assert.equal(r.ok, false);
});

test('watchdog', () => {
  const rt = new PlcRuntime(io);
  const r = rt.load('ST', 'WHILE TRUE DO Lamp := NOT Lamp; END_WHILE;');
  assert.ok(r.ok); rt.running = true; rt.scan(50);
  assert.match(rt.error.msg, /Watchdog/);
});

test('ladder compiles and runs', () => {
  const rt = new PlcRuntime(io);
  const ld = { rungs: [
    { branches: [[{ type: 'NO', var: 'Start' }], [{ type: 'NO', var: 'Motor' }]].map((b, i) => i === 0 ? [...b, ] : b), out: { type: 'COIL', var: 'M1' } },
    { branches: [[{ type: 'NO', var: 'M1' }, { type: 'NO', var: 'Stop' }]], out: { type: 'COIL', var: 'Motor' } },
    { branches: [[{ type: 'P', var: 'Start' }]], out: { type: 'CTU', var: 'C1', preset: 2 } },
    { branches: [[{ type: 'NO', var: 'C1' }]], out: { type: 'SET', var: 'Lamp' } },
  ] };
  const r = rt.load('LD', ld);
  assert.equal(r.ok, true, JSON.stringify(r.errors) + rt.generatedST);
  rt.running = true; rt.setInput('Stop', true);
  for (const v of [true, false, true, false]) { rt.setInput('Start', v); rt.scan(10); }
  assert.equal(rt.getOutput('Motor'), true);
  assert.equal(rt.getOutput('Lamp'), true);
});
