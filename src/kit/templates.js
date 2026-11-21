// The six built-in plants, built from ordinary kit elements. A template opens as
// the user's own editable copy: everything here can be moved, deleted, rewired or
// reprogrammed exactly like a plant built from nothing.
import { newScene, makeElement, allocateIO } from './model.js';
import { TEMPLATE_META } from './template-meta.js';

function scene(id) {
  const meta = TEMPLATE_META[id];
  const d = newScene(meta.name);
  d.templateId = id;
  d.id = 'tpl_' + id;
  const add = (type, name, x, z, rot = 0, params = {}) => {
    const el = makeElement(d, type, x, z, rot, params);
    el.name = name;
    d.elements.push(el);
    return add;
  };
  return { d, add, done: (lang, source) => { d.program = { name: 'Solution', lang, source }; allocateIO(d); return d; } };
}

// ---------------------------------------------------------------------------------
function motor() {
  const { add, done } = scene('motor');
  add('button', 'Start', -6.5, 8.5, 0, { color: 'green' });
  add('button', 'Stop', -4.5, 8.5, 0, { contact: 'NC', color: 'red' });
  add('estop', 'E_Stop', -1, 9);
  add('lamp', 'Lamp_Run', 2.5, 8.5, 0, { color: 'green' });
  add('lamp', 'Lamp_Fault', 4.5, 8.5, 0, { color: 'red' });
  add('motor', 'Motor', 0.5, -1.5);
  add('spawner', 'Feed', -9, -8, 0, { cycle: 3 });
  add('conveyor', 'Belt', -2, -8, 0, { length: 12, speed: 3 });
  add('sink', 'Bin', 5.5, -7.5);
  const all = (first) => [{ type: 'NO', var: first }, { type: 'NO', var: 'Stop' }, { type: 'NO', var: 'E_Stop' }, { type: 'NO', var: 'Motor_OK' }];
  return done('LD', {
    rungs: [
      { comment: 'Start/stop with seal-in; Stop, E-stop and the thermal contact are NC (TRUE = healthy)', branches: [all('Start'), all('Motor_Run')], out: { type: 'COIL', var: 'Motor_Run' } },
      { comment: 'The motor drives the belt', branches: [[{ type: 'NO', var: 'Motor_Run' }]], out: { type: 'COIL', var: 'Belt_Run' } },
      { comment: 'Run lamp', branches: [[{ type: 'NO', var: 'Motor_Run' }]], out: { type: 'COIL', var: 'Lamp_Run' } },
      { comment: 'Fault lamp: E-stop pressed or overload tripped', branches: [[{ type: 'NC', var: 'E_Stop' }], [{ type: 'NC', var: 'Motor_OK' }]], out: { type: 'COIL', var: 'Lamp_Fault' } },
    ],
  });
}

function traffic() {
  const { add, done } = scene('traffic');
  add('spawner', 'Src_NS', 0, -27, 1, { kind: 'car', cycle: 5, random: true });
  add('road', 'Road_N', 0, -14, 1, { length: 24 });
  add('crossing', 'Crossing', 0, 0);
  add('road', 'Road_S', 0, 12, 1, { length: 20 });
  add('sink', 'Exit_S', 0.5, 23.5);
  add('spawner', 'Src_EW', -27, 0, 0, { kind: 'car', cycle: 6, random: true });
  add('road', 'Road_W', -14, 0, 0, { length: 24 });
  add('road', 'Road_E', 12, 0, 0, { length: 20 });
  add('sink', 'Exit_E', 23.5, 0.5);
  add('trafficlight', 'NS', 2.5, -3.5, 1, { reach: 5 });
  add('trafficlight', 'EW', -3.5, -2.5, 0, { reach: 5 });
  add('inductive', 'Car_NS', 2.5, -6.5, 2, { range: 4 });
  add('inductive', 'Car_EW', -6.5, -2.5, 1, { range: 4 });
  add('button', 'Ped_Button', 5.5, -6.5, 0, { color: 'yellow' });
  add('lamp', 'Walk', 5.5, -4.5, 0, { color: 'white' });
  add('switch', 'Night_Mode', -6.5, 6.5);
  add('setpoint', 'SP_Green', -10, 7.5, 0, { value: 8, unit: 's' });
  add('setpoint', 'SP_Yellow', -10, 9.5, 0, { value: 3, unit: 's' });
  return done('ST', `PROGRAM TrafficLights
(* Two-phase intersection with yellow and all-red clearance, green extension
   while nobody waits on the cross street, pedestrian request and night flashing.
   Car_NS / Car_EW are inductive loops next to the stop lines. *)
VAR
  State     : INT := 0;
  StepTimer : TON;
  Flasher   : TON;
  BlinkOn   : BOOL;
  PedLatch  : BOOL;
  GreenT, YellowT : TIME;
  AllRed    : TIME := T#2s;
END_VAR

GreenT  := INT_TO_TIME(SP_Green * 1000);    (* HMI setpoints are in seconds *)
YellowT := INT_TO_TIME(SP_Yellow * 1000);
IF Ped_Button THEN PedLatch := TRUE; END_IF;

Flasher(IN := NOT Flasher.Q, PT := T#500ms);
IF Flasher.Q THEN BlinkOn := NOT BlinkOn; END_IF;

IF Night_Mode THEN
  State := 0;
  StepTimer(IN := FALSE);
  NS_Red := FALSE; NS_Green := FALSE; EW_Red := FALSE; EW_Green := FALSE;
  NS_Yellow := BlinkOn; EW_Yellow := BlinkOn;
  Walk := FALSE;
  RETURN;
END_IF;

CASE State OF
  0: (* North-South green *)
     StepTimer(IN := TRUE, PT := GreenT);
     IF StepTimer.Q AND (Car_EW OR PedLatch OR NOT Car_NS) THEN State := 1; StepTimer(IN := FALSE); END_IF;
  1: StepTimer(IN := TRUE, PT := YellowT);
     IF StepTimer.Q THEN State := 2; StepTimer(IN := FALSE); END_IF;
  2: StepTimer(IN := TRUE, PT := AllRed);
     IF StepTimer.Q THEN State := 3; StepTimer(IN := FALSE); END_IF;
  3: (* East-West green, pedestrians may walk *)
     StepTimer(IN := TRUE, PT := GreenT);
     IF StepTimer.Q AND (Car_NS OR NOT Car_EW) THEN State := 4; StepTimer(IN := FALSE); PedLatch := FALSE; END_IF;
  4: StepTimer(IN := TRUE, PT := YellowT);
     IF StepTimer.Q THEN State := 5; StepTimer(IN := FALSE); END_IF;
  5: StepTimer(IN := TRUE, PT := AllRed);
     IF StepTimer.Q THEN State := 0; StepTimer(IN := FALSE); END_IF;
ELSE
  State := 0;
END_CASE;

NS_Green  := State = 0;
NS_Yellow := State = 1;
NS_Red    := State >= 2;
EW_Green  := State = 3;
EW_Yellow := State = 4;
EW_Red    := State <= 2 OR State = 5;
Walk      := State = 3 AND PedLatch;
END_PROGRAM
`);
}

function tank() {
  const { add, done } = scene('tank');
  add('reservoir', 'Reservoir', -14, 0);
  add('pipe', 'P1', -10.5, 0.5, 0, { length: 3 });
  add('pump', 'Pump', -8, 0.5, 0, { rate: 60 });
  add('pipe', 'P2', -5.5, 0.5, 0, { length: 3 });
  add('tank', 'Tank', -2, 0, 0, { capacity: 1000, initial: 20 });
  add('valve', 'Valve_Out', 1, 0.5, 0, { rate: 35 });
  add('pipe', 'P3', 3.5, 0.5, 0, { length: 3 });
  add('drain', 'Consumer', 6, 0);
  add('leveltx', 'LT1', -3.5, 2.5, 0, { noise: 0.5 });
  add('levelswitch', 'LS_Low', -2.5, 2.5, 0, { level: 10 });
  add('levelswitch', 'LS_HighHigh', -1.5, 2.5, 0, { level: 95 });
  add('switch', 'Auto', -6.5, 8.5, 0, { start: true });
  add('button', 'Manual_Pump', -4.5, 8.5, 0, { color: 'green' });
  add('switch', 'Demand', -2.5, 8.5, 0, { start: true });
  add('lamp', 'Lamp_Auto', 0.5, 8.5, 0, { color: 'blue' });
  add('lamp', 'Alarm', 2.5, 8.5, 0, { color: 'red' });
  add('setpoint', 'SP_Low', -10, 7.5, 0, { value: 30, unit: '%' });
  add('setpoint', 'SP_High', -10, 9.5, 0, { value: 80, unit: '%' });
  return done('ST', `PROGRAM TankLevel
(* Two-point (hysteresis) level control with dry-run and overflow protection.
   LT1 is an analog input: 0..27648 means 0..100 %. *)
VAR
  Level     : REAL;
  PumpLatch : BOOL;
  Flash     : TON;
  FlashOn   : BOOL;
END_VAR

Level := INT_TO_REAL(LT1) / 276.48;

IF Auto THEN
  IF Level <= INT_TO_REAL(SP_Low)  THEN PumpLatch := TRUE;  END_IF;
  IF Level >= INT_TO_REAL(SP_High) THEN PumpLatch := FALSE; END_IF;
  Pump_Run := PumpLatch AND NOT LS_HighHigh;
ELSE
  PumpLatch := FALSE;
  Pump_Run := Manual_Pump AND NOT LS_HighHigh;       (* jog, still protected *)
END_IF;

Valve_Out_Open := Demand AND LS_Low;                 (* never drain an empty tank *)

Flash(IN := NOT Flash.Q, PT := T#400ms);
IF Flash.Q THEN FlashOn := NOT FlashOn; END_IF;
Alarm := (LS_HighHigh OR NOT LS_Low) AND FlashOn;
Lamp_Auto := Auto;
END_PROGRAM
`);
}

function conveyor() {
  const { add, done } = scene('conveyor');
  add('spawner', 'Source', -13, 0, 0, { cycle: 3.5, size: 'mixed' });
  add('conveyor', 'Conveyor', -4, 0, 0, { length: 16, speed: 4 });
  add('lightbarrier', 'PE_Tall', -4.5, -1.5, 1, { range: 2, height: 'high (tall workpieces only)' });
  add('cylinder1', 'Pusher', 1, -2, 1, { stroke: 3, time: 0.4 });
  add('lightbarrier', 'PE_Pusher', 1.5, 1.5, 3, { range: 2 });
  add('lightbarrier', 'PE_End', 3.5, -1.5, 1, { range: 2 });
  add('sink', 'Bin_Tall', 1.5, 3.5, 0, { expects: 'large' });
  add('sink', 'Bin_Small', 5.5, 0.5, 0, { expects: 'small' });
  add('button', 'Start', -10.5, 6.5, 0, { color: 'green' });
  add('button', 'Stop', -8.5, 6.5, 0, { contact: 'NC', color: 'red' });
  add('lamp', 'Lamp_Run', -6.5, 6.5, 0, { color: 'green' });
  return done('ST', `PROGRAM SortingConveyor
(* Tall workpieces are pushed into the side bin, small ones run to the end. *)
VAR
  Running  : BOOL;
  TallFlag : BOOL;      (* a tall workpiece is on its way to the pusher *)
  Pushing  : BOOL;
  TallEdge, PushEdge, EndEdge : R_TRIG;
  C_Tall, C_Small : CTU;
END_VAR

Running := (Start OR Running) AND Stop;

TallEdge(CLK := PE_Tall);
PushEdge(CLK := PE_Pusher);
EndEdge(CLK := PE_End);

IF TallEdge.Q THEN TallFlag := TRUE; END_IF;
IF PushEdge.Q AND TallFlag THEN
  Pushing := TRUE;
  TallFlag := FALSE;
END_IF;
IF Pusher_Out THEN Pushing := FALSE; END_IF;        (* retract at the end stop *)

Pusher_Ext   := Pushing;
Conveyor_Run := Running AND NOT Pushing AND Pusher_Home;
Lamp_Run     := Running;

C_Tall(CU := Pusher_Out, R := FALSE, PV := 999);
C_Small(CU := EndEdge.Q, R := FALSE, PV := 999);
END_PROGRAM
`);
}

function bottling() {
  const { add, done } = scene('bottling');
  add('spawner', 'Bottles', -13, 0, 0, { kind: 'bottle', cycle: 2.5 });
  add('conveyor', 'Conveyor', -3, 0, 0, { length: 18, speed: 3 });
  add('filler', 'Fill', -4, -2, 1, { rate: 25 });
  add('capper', 'Cap', 2, -2, 1);
  add('lightbarrier', 'PE_End', 5.5, -1.5, 1, { range: 2 });
  add('sink', 'Crate', 7.5, 0.5, 0, { expects: 'filled + capped' });
  add('button', 'Start', -10.5, 6.5, 0, { color: 'green' });
  add('button', 'Stop', -8.5, 6.5, 0, { contact: 'NC', color: 'red' });
  add('button', 'Reset_Count', -6.5, 6.5, 0, { color: 'blue' });
  add('lamp', 'Lamp_Run', -4.5, 6.5, 0, { color: 'green' });
  add('lamp', 'Lamp_Done', -2.5, 6.5, 0, { color: 'yellow' });
  add('setpoint', 'SP_CapTime', 1, 6.5, 0, { value: 600, unit: 'ms' });
  add('setpoint', 'SP_Batch', 4, 6.5, 0, { value: 12, unit: 'bottles' });
  return done('ST', `PROGRAM BottlingLine
(* The belt stops whenever a bottle stands under the filler or the capper and
   that station has not finished its work yet. *)
VAR
  Running, FillDone, CapDone : BOOL;
  CapTimer : TON;
  Still    : TON;       (* belt has been off long enough to stand still *)
  EndEdge  : F_TRIG;    (* a bottle has left the belt *)
  Count    : CTU;
END_VAR

Running := (Start OR Running) AND Stop AND NOT Count.Q;

Still(IN := NOT Conveyor_Run, PT := T#250ms);

(* filling: until the level sensor reports full *)
IF NOT Fill_Bottle THEN FillDone := FALSE; END_IF;
IF Fill_Bottle AND Fill_Full THEN FillDone := TRUE; END_IF;
Fill_Valve := Running AND Fill_Bottle AND NOT FillDone AND Still.Q;

(* capping: press down, hold for the set time *)
IF NOT Cap_Bottle THEN CapDone := FALSE; END_IF;
CapTimer(IN := Cap_Bottle AND Cap_Down AND NOT CapDone, PT := INT_TO_TIME(SP_CapTime));
IF CapTimer.Q THEN CapDone := TRUE; END_IF;
Cap_Press := Running AND Cap_Bottle AND NOT CapDone AND Still.Q;

(* never move while a station works or the press is not fully up *)
Conveyor_Run := Running AND Cap_Up
                AND NOT (Fill_Bottle AND NOT FillDone)
                AND NOT (Cap_Bottle AND NOT CapDone);

EndEdge(CLK := PE_End);
Count(CU := EndEdge.Q, R := Reset_Count, PV := SP_Batch);
Lamp_Run  := Running;
Lamp_Done := Count.Q;
END_PROGRAM
`);
}

function elevator() {
  const { add, done } = scene('elevator');
  add('elevator', 'Lift', 0, -4, 0, { floors: 3 });
  for (let f = 1; f <= 3; f++) {
    add('button', `Call_${f}`, 3.5 + f, 1.5, 0, { color: 'white' });
    add('lamp', `Lamp_Call${f}`, 3.5 + f, 3.5, 0, { color: 'orange' });
  }
  add('setpoint', 'SP_DoorTime', 10, 1.5, 0, { value: 2500, unit: 'ms' });
  return done('ST', `PROGRAM Elevator3
(* 3-floor lift: call memory, direction preference, door cycle *)
VAR
  Req1, Req2, Req3 : BOOL;
  Pos   : INT := 1;     (* last floor seen *)
  Dir   : INT := 0;     (* 1 = up, -1 = down *)
  Step  : INT := 0;
  Above, Below, Here : BOOL;
  DoorTimer : TON;
END_VAR

IF Call_1 THEN Req1 := TRUE; END_IF;
IF Call_2 THEN Req2 := TRUE; END_IF;
IF Call_3 THEN Req3 := TRUE; END_IF;

IF Lift_F1 THEN Pos := 1; END_IF;
IF Lift_F2 THEN Pos := 2; END_IF;
IF Lift_F3 THEN Pos := 3; END_IF;

Here  := (Req1 AND Lift_F1) OR (Req2 AND Lift_F2) OR (Req3 AND Lift_F3);
Above := (Pos < 2 AND Req2) OR (Pos < 3 AND Req3);
Below := (Pos > 2 AND Req2) OR (Pos > 1 AND Req1);

CASE Step OF
  0: (* idle, door closed *)
     Lift_Up := FALSE; Lift_Down := FALSE; Lift_Door := FALSE;
     IF Here THEN
       Step := 3;
     ELSIF Lift_DoorClosed THEN
       IF Above AND (Dir >= 0 OR NOT Below) THEN Dir := 1; Step := 1;
       ELSIF Below THEN Dir := -1; Step := 2;
       ELSE Dir := 0;
       END_IF;
     END_IF;
  1: (* travelling up *)
     Lift_Up := Lift_DoorClosed;
     IF (Lift_F2 AND Req2) OR (Lift_F3 AND Req3) OR Lift_LimTop THEN Lift_Up := FALSE; Step := 3; END_IF;
  2: (* travelling down *)
     Lift_Down := Lift_DoorClosed;
     IF (Lift_F1 AND Req1) OR (Lift_F2 AND Req2) OR Lift_LimBot THEN Lift_Down := FALSE; Step := 3; END_IF;
  3: (* open the door, serve the floor *)
     Lift_Door := TRUE;
     IF Lift_F1 THEN Req1 := FALSE; END_IF;
     IF Lift_F2 THEN Req2 := FALSE; END_IF;
     IF Lift_F3 THEN Req3 := FALSE; END_IF;
     DoorTimer(IN := Lift_DoorOpen, PT := INT_TO_TIME(SP_DoorTime));
     IF DoorTimer.Q THEN DoorTimer(IN := FALSE); Lift_Door := FALSE; Step := 4; END_IF;
  4: IF Lift_DoorClosed THEN Step := 0; END_IF;
END_CASE;

Lamp_Call1 := Req1;
Lamp_Call2 := Req2;
Lamp_Call3 := Req3;
END_PROGRAM
`);
}

const BUILDERS = { motor, traffic, tank, conveyor, bottling, elevator };

/** What each template asks the learner to do, and where document values go. */
const EXTRA = {
  motor: {
    objectives: ['START runs the motor; it keeps running after START is released (seal-in).', 'STOP is wired normally-closed: its input is TRUE while NOT pressed.', 'The emergency stop (latching) and the thermal contact Motor_OK must stop the motor and block a restart.', 'Raise the motor load in its settings until the overload trips; it resets itself when cooled down.', 'Try a fault: select the motor and set it to "jammed".'],
    docParams: { load: ['Motor', 'load'], trip: ['Motor', 'trip'] },
  },
  traffic: {
    objectives: ['Never show green to both directions: the scene counts crashes.', 'Sequence green → yellow → all red → other direction; times come from the setpoints SP_Green and SP_Yellow.', 'Extend green while nobody waits on the cross street (inductive loops Car_NS, Car_EW).', 'Latch Ped_Button and light Walk during the East-West green.', 'Night_Mode: flash both yellow lights.'],
    docParams: { green: ['SP_Green', 'value'], yellow: ['SP_Yellow', 'value'] },
  },
  tank: {
    objectives: ['In AUTO start the pump at SP_Low and stop it at SP_High (hysteresis).', 'LS_HighHigh must stop the pump in every mode: the tank shows how much overflowed.', 'Open Valve_Out only when Demand is on AND LS_Low reports liquid.', 'Scale the analog level LT1 (0..27648) to percent.', 'Flash Alarm on high-high or low level.'],
    docParams: { capacity: ['Tank', 'capacity'], inflow: ['Pump', 'rate'], outflow: ['Valve_Out', 'rate'], spLow: ['SP_Low', 'value'], spHigh: ['SP_High', 'value'] },
  },
  conveyor: {
    objectives: ['Start/stop the belt with a seal-in (Stop is NC).', 'Remember a tall workpiece (edge on PE_Tall) until it reaches PE_Pusher.', 'Stop the belt, extend the pusher until Pusher_Out, retract, resume.', 'Count both kinds with CTU counters.', 'Goal: 0 wrong workpieces in both bins.'],
    docParams: { interval: ['Source', 'cycle'], speed: ['Conveyor', 'speed'] },
  },
  bottling: {
    objectives: ['Stop the belt when a bottle stands under the filler; open Fill_Valve until Fill_Full.', 'Stop when a bottle stands under the capper; press for SP_CapTime.', 'Never move the belt while the press is not fully up (the capper counts violations).', 'Count finished bottles at PE_End and stop after SP_Batch; Reset_Count starts the next batch.', 'Goal: every bottle in the crate is filled and capped, nothing spilled.'],
    docParams: { capTime: ['SP_CapTime', 'value', 1000] },
  },
  elevator: {
    objectives: ['Latch the calls and light the call lamps until served.', 'Keep travelling in one direction while there are calls ahead.', 'Stop at the requested floor, open the door for SP_DoorTime, close it.', 'Never move with the door open and never run into the limit switches (the lift counts both).'],
    docParams: { door: ['SP_DoorTime', 'value', 1000] },
  },
};

export const SCENE_TEMPLATES = Object.keys(BUILDERS).map((id) => ({ ...TEMPLATE_META[id], ...EXTRA[id] }));
export const SCENE_TEMPLATE_IDS = Object.keys(BUILDERS);
export const sceneTemplate = (id) => SCENE_TEMPLATES.find((t) => t.id === id);

/** Fresh copy of a template plant. */
export function templateScene(id) {
  return BUILDERS[id] ? BUILDERS[id]() : null;
}

/** Put values found in a document onto the template's elements. Returns the list of what was set. */
export function applyDocParams(doc, templateId, params) {
  const map = (EXTRA[templateId] || {}).docParams || {};
  const applied = [];
  for (const [key, value] of Object.entries(params || {})) {
    const m = map[key];
    if (!m) continue;
    const el = doc.elements.find((e) => e.name === m[0]);
    if (!el) continue;
    el.params[m[1]] = value * (m[2] || 1);
    applied.push(`${m[0]}.${m[1]}`);
  }
  return applied;
}
