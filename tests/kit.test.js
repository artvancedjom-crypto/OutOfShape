import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlcRuntime } from '../src/plc/runtime.js';
import { KitSim } from '../src/kit/sim.js';
import { newScene, addElement, plcIo, ioList, allocateIO, tagProblem, addressProblem, renameTag, placement, loadScene } from '../src/kit/model.js';
import { KIT, RAW } from '../src/kit/elements.js';

/** Scene + PLC + process wired together, like the workbench does. */
export function rig(doc) {
  const rt = new PlcRuntime(plcIo(doc));
  const io = { out: (t) => rt.getOutput(t), set: (t, v) => rt.setInput(t, v) };
  const sim = new KitSim(doc, io);
  const res = rt.load(doc.program.lang, doc.program.source);
  assert.ok(res.ok, 'program: ' + JSON.stringify(res.errors));
  rt.running = true;
  const run = (seconds) => { for (let t = 0; t < seconds - 1e-9; t += 0.02) { sim.step(0.02); rt.scan(20); } };
  const el = (name) => doc.elements.find((e) => e.name === name);
  const st = (name) => sim.st[el(name).id];
  const press = (name, secs = 0.2) => { sim.operate(el(name), 'down'); run(secs); sim.operate(el(name), 'up'); run(0.06); };
  return { rt, sim, run, el, st, press, out: (t) => rt.getOutput(t), inp: (t) => rt.effectiveInput(t) };
}
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, expected ${b} ± ${tol}`);

test('plug-and-play I/O: next free address and a tag for every signal', () => {
  const d = newScene('io');
  const b1 = addElement(d, 'button', 0, 0);
  const m1 = addElement(d, 'motor', 6, 0);
  const lb = addElement(d, 'lightbarrier', 0, 6);
  const lt = addElement(d, 'leveltx', 0, 10);
  const cv = addElement(d, 'conveyor', 10, 10, 0, { control: 'analog (%QW)' });
  const b2 = addElement(d, 'button', 0, 3);
  assert.deepEqual(b1.io.s, { tag: 'Btn1', addr: '%I0.0' });
  assert.deepEqual(m1.io, { run: { tag: 'Mot1_Run', addr: '%Q0.0' }, ok: { tag: 'Mot1_OK', addr: '%I0.1' } });
  assert.deepEqual(lb.io.s, { tag: 'LB1', addr: '%I0.2' });
  assert.deepEqual(lt.io.v, { tag: 'LT1', addr: '%IW64' });
  assert.deepEqual(cv.io, { run: { tag: 'Conv1_Run', addr: '%Q0.1' }, spd: { tag: 'Conv1_Speed', addr: '%QW64' } });
  assert.deepEqual(b2.io.s, { tag: 'Btn2', addr: '%I0.3' });
  // deleting frees the address for the next element; existing assignments never move
  d.elements = d.elements.filter((e) => e !== lb);
  const ls = addElement(d, 'limitswitch', 4, 6);
  assert.equal(ls.io.s.addr, '%I0.2'); assert.equal(b2.io.s.addr, '%I0.3');
  // ninth input bit rolls over to the next byte
  for (let k = 0; k < 6; k++) addElement(d, 'switch', 20 + k * 2, 0);
  assert.ok(ioList(d).some((r) => r.addr === '%I1.0'));
  assert.equal(new Set(ioList(d).map((r) => r.addr)).size, ioList(d).length, 'addresses are unique');
  // a parameter that adds signals gets them allocated, removing it drops them
  cv.params.reversible = true; allocateIO(d); assert.ok(cv.io.rev.addr.startsWith('%Q'));
  cv.params.control = 'fixed'; allocateIO(d); assert.equal(cv.io.spd, undefined);
  // validation of manual edits
  assert.match(tagProblem(d, '1abc'), /letters/); assert.match(tagProblem(d, 'Btn2'), /already used/); assert.match(tagProblem(d, 'END_IF'), /keyword/); assert.equal(tagProblem(d, 'Start'), null);
  const pt = KIT.button.io(b1)[0];
  assert.match(addressProblem(d, '%Q0.0', pt, b1, 's'), /needs a %I/); assert.match(addressProblem(d, '%I0.3', pt, b1, 's'), /already used/); assert.equal(addressProblem(d, '%I7.7', pt, b1, 's'), null); assert.match(addressProblem(d, 'I0.0', pt, b1, 's'), /Not an address/);
});

test('required: button → motor and light barrier → counter react in the scene', () => {
  const d = newScene('req');
  addElement(d, 'button', -8, 6);                          // Btn1  %I0.0  start
  addElement(d, 'button', -6, 6, 0, { contact: 'NC' });    // Btn2  %I0.1  stop (NC)
  addElement(d, 'motor', -8, -6);                          // Mot1_Run %Q0.0, Mot1_OK %I0.2
  addElement(d, 'spawner', -7, 0, 0, { cycle: 2, size: 'small' });
  addElement(d, 'conveyor', 0, 0, 0, { length: 12, speed: 4 }); // Conv1_Run %Q0.1
  addElement(d, 'lightbarrier', 2.5, -1.5, 1, { range: 2 });    // LB1 %I0.3, looks across the belt
  addElement(d, 'sink', 7.5, 0);
  const rows = Object.fromEntries(ioList(d).map((r) => [r.name, r.addr]));
  assert.deepEqual(rows, { Btn1: '%I0.0', Btn2: '%I0.1', Mot1_OK: '%I0.2', LB1: '%I0.3', Mot1_Run: '%Q0.0', Conv1_Run: '%Q0.1' });
  d.program.source = `VAR Count : CTU; Parts : INT; END_VAR
Mot1_Run := (Btn1 OR Mot1_Run) AND Btn2 AND Mot1_OK;
Conv1_Run := Mot1_Run;
Count(CU := LB1, R := FALSE, PV := 100);
Parts := Count.CV;`;
  const r = rig(d);
  r.run(1);
  assert.equal(r.out('Mot1_Run'), false); assert.equal(r.st('Mot1').speed, 0);
  r.press('Btn1');
  assert.equal(r.out('Mot1_Run'), true, 'motor latched after the button was released');
  r.run(3); assert.ok(r.st('Mot1').speed > 0.9, 'the motor in the scene spins'); assert.ok(r.st('Conv1').v > 3.9, 'the belt runs');
  r.run(20);
  const made = r.st('Src1').made; const counted = r.rt.get('Parts'); const binned = r.st('Bin1').n;
  assert.ok(made >= 9 && counted >= made - 3 && counted <= made, `made ${made}, counted ${counted}`);
  assert.ok(binned >= counted - 2 && binned <= counted, `binned ${binned}, counted ${counted}`);
  r.press('Btn2');
  assert.equal(r.out('Mot1_Run'), false); r.run(3); assert.ok(r.st('Mot1').speed < 0.05); assert.equal(r.st('Conv1').v, 0);
  const frozen = r.rt.get('Parts'); r.run(5); assert.equal(r.rt.get('Parts'), frozen, 'nothing is counted while the belt stands');
});

test('workpieces: transfer between belts, cylinder pushes, gate holds back, sensors tell types apart', () => {
  const d = newScene('flow');
  addElement(d, 'spawner', -9, 0, 0, { cycle: 3, size: 'mixed', material: 'mixed', color: 'red' });
  addElement(d, 'conveyor', -2, 0, 0, { length: 12, speed: 4 });
  addElement(d, 'lightbarrier', -4.5, -1.5, 1, { range: 2, height: 'high (tall workpieces only)' }); // LB1
  addElement(d, 'inductive', -2.5, -1.5, 1, { range: 1.5 });                                        // Ind1
  addElement(d, 'cylinder1', 1, -2, 1, { stroke: 3, time: 0.3 });                                    // Cyl1 pushes +z
  addElement(d, 'sink', 1, 3.5, 0, { expects: 'large' });                                            // Bin1
  addElement(d, 'sink', 5.5, 0, 0, { expects: 'small' });                                            // Bin2
  addElement(d, 'lightbarrier', 1.5, 1.5, 3, { range: 2 });                                          // LB2 at the pusher
  d.program.source = `VAR Tall, Pushing : BOOL; E1, E2 : R_TRIG; END_VAR
E1(CLK := LB1); E2(CLK := LB2);
IF E1.Q THEN Tall := TRUE; END_IF;
IF E2.Q AND Tall THEN Pushing := TRUE; Tall := FALSE; END_IF;
IF Cyl1_Out THEN Pushing := FALSE; END_IF;
Cyl1_Ext := Pushing;
Conv1_Run := NOT Pushing AND Cyl1_Home;`;
  const r = rig(d);
  let sawMetal = 0; let sawTall = 0;
  for (let k = 0; k < 60 * 50; k++) { r.sim.step(0.02); r.rt.scan(20); if (r.inp('Ind1')) sawMetal++; if (r.inp('LB1')) sawTall++; }
  const b1 = r.st('Bin1'); const b2 = r.st('Bin2');
  assert.ok(b1.n + b2.n >= 12, `sorted ${b1.n}+${b2.n}`);
  assert.equal(b1.wrong, 0, 'only large in the side bin'); assert.equal(b2.wrong, 0, 'only small at the end');
  assert.ok(b1.ok >= 2 && b2.ok >= 2 && sawMetal > 0 && sawTall > 0);
  // gate: closed gate holds the queue, open gate lets it through
  const g = newScene('gate');
  addElement(g, 'spawner', -9, 0, 0, { cycle: 1.5 }); addElement(g, 'conveyor', -2, 0, 0, { length: 12, speed: 4 });
  addElement(g, 'gate', 0.5, -1.5, 1, { reach: 2 }); addElement(g, 'sink', 5.5, 0);
  g.program.source = 'Conv1_Run := TRUE; Gate1_Open := FALSE;';
  let q = rig(g); q.run(12);
  assert.equal(q.st('Bin1').n, 0); assert.ok(q.sim.items.length >= 3 && q.sim.items.every((i) => i.x < 0.5), 'queue stands before the gate');
  assert.equal(q.inp('Gate1_IsClosed'), true);
  g.program.source = 'Conv1_Run := TRUE; Gate1_Open := TRUE;';
  q = rig(g); q.run(12); assert.ok(q.st('Bin1').n >= 4); assert.equal(q.inp('Gate1_IsOpen'), true);
});

test('liquids: pump through pipes, valve by gravity, level / pressure / temperature sensors, heater', () => {
  const d = newScene('tank');
  addElement(d, 'reservoir', -12, 0); addElement(d, 'pipe', -8.5, 0, 0, { length: 3 }); addElement(d, 'pump', -6, 0, 0, { rate: 50 });
  addElement(d, 'pipe', -4, 0, 0, { length: 2 }); addElement(d, 'tank', -1, 0, 0, { capacity: 1000, initial: 0, height: 2 });
  addElement(d, 'valve', 2, 0, 0, { rate: 40 }); addElement(d, 'elbow', 3.5, 0, 1); addElement(d, 'pipe', 3.5, 2, 1, { length: 3 }); addElement(d, 'drain', 3.5, 4.5);
  addElement(d, 'leveltx', -1.5, 2.5); addElement(d, 'levelswitch', -0.5, 2.5, 0, { level: 80 }); addElement(d, 'pressure', 0.5, 2.5, 0, { max: 0.4 });
  addElement(d, 'temperature', -1.5, -2.5); addElement(d, 'heater', -0.5, -2.5, 0, { power: 419 });
  d.program.source = 'Pump1_Run := NOT LSL1; Valve1_Open := FALSE; Heat1_On := FALSE;';
  let r = rig(d);
  r.run(10);                                   // 50 L/s for 10 s = 500 L
  near(r.st('Tank1').vol, 500, 2, 'volume'); near(r.inp('LT1'), RAW * 0.5, 60, 'level raw'); near(r.inp('PT1'), RAW * (0.5 * 2 * 0.0981) / 0.4, 80, 'pressure raw');
  r.run(10); near(r.st('Tank1').vol, 800, 3, 'pump stops at the 80 % switch'); assert.equal(r.inp('LSL1'), true);
  // heating: 419 kW into 800 L → 0.125 K/s
  d.program.source = 'Pump1_Run := FALSE; Valve1_Open := FALSE; Heat1_On := TRUE;';
  r = rig(d); r.st('Tank1').vol = 800; r.run(40);
  near(r.st('Tank1').temp, 20 + 40 * 0.125, 0.4, 'temperature'); near(r.inp('TT1'), RAW * r.st('Tank1').temp / 100, 30);
  // gravity drain through elbow + pipe into the consumer
  d.program.source = 'Pump1_Run := FALSE; Valve1_Open := TRUE; Heat1_On := FALSE;';
  r = rig(d); r.st('Tank1').vol = 800; r.run(30);
  assert.ok(r.st('Tank1').vol < 250 && r.st('Tank1').vol > 20, 'drained ' + r.st('Tank1').vol);
  near(r.st('Drain1').total + r.st('Tank1').vol, 800, 1, 'nothing is lost');
  // a gap in the pipe run stops the flow
  d.elements = d.elements.filter((e) => e.name !== 'Elb1'); r = rig(d); r.st('Tank1').vol = 800; r.run(5); near(r.st('Tank1').vol, 800, 0.01, 'open pipe end: no flow');
});

test('fault injection: stuck sensor, wire break, jammed and slow actuator', () => {
  const d = newScene('faults');
  addElement(d, 'switch', 0, 0); addElement(d, 'cylinder1', 4, 0, 0, { time: 1 }); addElement(d, 'leveltx', 0, 4, 0, { signal: '4-20 mA' }); addElement(d, 'lamp', 8, 0);
  d.program.source = 'Cyl1_Ext := Sw1; Lamp1 := Sw1;';
  const mk = (fault, name) => { d.elements.forEach((e) => { e.fault = ''; }); d.elements.find((e) => e.name === name).fault = fault; return rig(d); };
  let r = mk('', 'Sw1'); r.press('Sw1'); r.run(1.5); assert.equal(r.inp('Cyl1_Out'), true); assert.equal(r.st('Lamp1').on, true);
  r = mk('stuck0', 'Sw1'); r.press('Sw1'); r.run(1.5); assert.equal(r.inp('Sw1'), false, 'stuck at 0'); assert.equal(r.st('Cyl1').pos, 0);
  r = mk('stuck1', 'Sw1'); r.run(1.5); assert.equal(r.inp('Sw1'), true, 'stuck at 1'); assert.equal(r.inp('Cyl1_Out'), true);
  r = mk('jam', 'Cyl1'); r.press('Sw1'); r.run(3); assert.equal(r.out('Cyl1_Ext'), true); assert.equal(r.st('Cyl1').pos, 0, 'jammed: commanded but does not move'); assert.equal(r.inp('Cyl1_Home'), true);
  r = mk('slow', 'Cyl1'); r.press('Sw1'); r.run(2); assert.ok(r.st('Cyl1').pos > 0.4 && r.st('Cyl1').pos < 0.7, 'slow: a quarter of the speed'); r.run(3); assert.equal(r.inp('Cyl1_Out'), true);
  r = mk('break', 'Lamp1'); r.press('Sw1'); r.run(0.5); assert.equal(r.out('Lamp1'), true); assert.equal(r.st('Lamp1').on, false, 'wire break: output set, lamp dark');
  r = mk('break', 'LT1'); r.run(0.2); assert.equal(r.inp('LT1'), -32768, '4-20 mA wire break is visible to the program');
});

test('operating elements, analog signals, encoder, scale, elevator', () => {
  const d = newScene('ops');
  addElement(d, 'estop', 0, 0); addElement(d, 'selector', 3, 0); addElement(d, 'potentiometer', 5, 0, 0, { value: 30 }); addElement(d, 'setpoint', 8, 0, 0, { value: 12 });
  addElement(d, 'conveyor', 0, 6, 0, { length: 6, speed: 2, control: 'analog (%QW)' }); addElement(d, 'encoder', 0, 4.5, 0, { ppr: 10 });
  addElement(d, 'spawner', -4, 6, 0, { cycle: 50, size: 'large', material: 'metal' }); addElement(d, 'scale', 4, 6, 0, { max: 1500 });
  addElement(d, 'elevator', 12, 12, 0, { floors: 3, floorHeight: 5, speed: 2.5 });
  d.program.source = `Conv1_Run := EStop1; Conv1_Speed := Pot1;
Lift1_Up := Sel1_R AND NOT Lift1_F3 AND Lift1_DoorClosed; Lift1_Down := Sel1_L AND NOT Lift1_F1 AND Lift1_DoorClosed; Lift1_Door := FALSE;`;
  const r = rig(d);
  r.run(0.1); assert.equal(r.inp('EStop1'), true); near(r.inp('Pot1'), RAW * 0.3, 1); assert.equal(r.inp('SP1'), 12);
  r.run(4.9); near(r.st('Conv1').v, 0.6, 0.01, 'belt at 30 % of 2 studs/s'); near(r.inp('Enc1'), 30, 2, 'encoder pulses for 3 studs');
  r.sim.operate(r.el('EStop1'), 'down'); r.run(1); assert.equal(r.inp('EStop1'), false); assert.equal(r.st('Conv1').v, 0);
  r.sim.operate(r.el('EStop1'), 'down'); r.sim.operate(r.el('Pot1'), 'down'); r.run(0.1); near(r.inp('Pot1'), RAW * 0.4, 1, 'click = +10 %');
  for (let k = 0; k < 6; k++) r.sim.operate(r.el('Pot1'), 'down');
  r.run(12); near(r.inp('WT1'), RAW * 750 / 1500, 40, 'large metal piece (750 g) on the scale');
  // elevator: selector right → up to floor 3, left → down to floor 1
  r.sim.operate(r.el('Sel1'), 'down'); r.run(0.1); assert.equal(r.inp('Sel1_R'), true); r.run(6);
  assert.equal(r.inp('Lift1_F3'), true); near(r.st('Lift1').pos, 10, 0.15);
  r.sim.operate(r.el('Sel1'), 'down'); r.run(0.1); assert.equal(r.inp('Sel1_L'), true); r.run(6); assert.equal(r.inp('Lift1_F1'), true);
});

test('stacking on bricks and placement rules; tag rename reaches the program', () => {
  const d = newScene('stack');
  const b = addElement(d, 'brick', 0, 0, 0, { w: 4, d: 4, h: 6 });
  const lamp = addElement(d, 'lamp', 0.5, 0.5);
  let p = placement(d, lamp); assert.deepEqual([p.ok, p.y], [true, 2.4]);
  lamp.y = p.y;
  const b2 = addElement(d, 'brick', 0, 0, 0, { w: 2, d: 2, h: 3 }); p = placement(d, b2); assert.equal(p.ok, false, 'the lamp is in the way');
  const m = addElement(d, 'motor', 10, 0); const m2 = addElement(d, 'motor', 11, 0); assert.equal(placement(d, m2).ok, false); assert.equal(placement(d, m).ok, false);
  m2.x = 14.5; assert.equal(placement(d, m2).ok, true); m2.x = 40; assert.equal(placement(d, m2).ok, false);
  void b;
  d.program.source = 'Mot1_Run := Mot1_OK AND NOT mot2_ok; (* Mot1_Running stays *)';
  assert.equal(d.program.source.includes('Mot1_Run'), true);
  renameTag(d, m, 'run', 'MainDrive');
  assert.equal(d.program.source, 'MainDrive := Mot1_OK AND NOT mot2_ok; (* Mot1_Running stays *)');
  const again = loadScene(d); assert.equal(again.elements.find((e) => e.name === 'Mot1').io.run.tag, 'MainDrive');
});
