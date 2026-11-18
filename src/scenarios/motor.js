import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, controlDesk, onDesk, flywheel, addScenery, figure, strip } from './common.js';

const LADDER = {
  rungs: [
    {
      comment: 'Start/stop with seal-in, E-stop and overload interlocks',
      branches: [
        [{ type: 'NO', var: 'Start' }, { type: 'NO', var: 'Stop' }, { type: 'NO', var: 'E_Stop' }, { type: 'NO', var: 'Overload_OK' }],
        [{ type: 'NO', var: 'Motor' }, { type: 'NO', var: 'Stop' }, { type: 'NO', var: 'E_Stop' }, { type: 'NO', var: 'Overload_OK' }],
      ],
      out: { type: 'COIL', var: 'Motor' },
    },
    { comment: 'Run lamp', branches: [[{ type: 'NO', var: 'Motor' }]], out: { type: 'COIL', var: 'Lamp_Run' } },
    { comment: 'Fault lamp (E-stop pressed or overload tripped)', branches: [[{ type: 'NC', var: 'E_Stop' }], [{ type: 'NC', var: 'Overload_OK' }]], out: { type: 'COIL', var: 'Lamp_Fault' } },
  ],
};

export default {
  id: 'motor',
  name: 'Motor Start/Stop with Interlocks',
  difficulty: 'Beginner',
  minutes: 10,
  icon: '⚙️',
  summary: 'The "hello world" of PLCs: a seal-in (latching) circuit for a motor contactor with a normally-closed stop button, emergency stop and thermal overload.',
  objectives: [
    'Pressing START runs the motor; it keeps running after START is released (seal-in).',
    'STOP is wired normally-closed (input is TRUE when NOT pressed). Pressing it stops the motor.',
    'E-STOP (latching mushroom) and the thermal overload must stop the motor and prevent restarts.',
    'Lamp_Run shows the running state; Lamp_Fault lights when E-stop or overload is active.',
    'Raise the load to trip the overload, then reset it with the blue button on the thermal relay.',
  ],
  io: {
    inputs: [
      { name: 'Start', addr: '%I0.0', desc: 'Start push button (NO)', ui: 'momentary' },
      { name: 'Stop', addr: '%I0.1', desc: 'Stop push button (NC → TRUE when released)', ui: 'nc-momentary' },
      { name: 'E_Stop', addr: '%I0.2', desc: 'Emergency stop (NC, latching)', ui: 'nc-toggle' },
      { name: 'Overload_OK', addr: '%I0.3', desc: 'Thermal overload contact (NC → TRUE = OK)', ui: 'sensor' },
    ],
    outputs: [
      { name: 'Motor', addr: '%Q0.0', desc: 'Main contactor K1' },
      { name: 'Lamp_Run', addr: '%Q0.1', desc: 'Green pilot light' },
      { name: 'Lamp_Fault', addr: '%Q0.2', desc: 'Red pilot light' },
    ],
  },
  params: [
    { key: 'load', label: 'Mechanical load', min: 0, max: 150, step: 5, default: 60, unit: '%' },
    { key: 'trip', label: 'Overload trip temperature', min: 60, max: 140, step: 5, default: 100, unit: '°C' },
  ],
  programs: {
    solution: { lang: 'LD', source: LADDER },
    starter: {
      lang: 'ST',
      source: `(* Motor start/stop – write the seal-in logic.
   Remember: Stop, E_Stop and Overload_OK are NC contacts,
   so they are TRUE in the healthy state. *)

Motor := Start;   // TODO: add seal-in and interlocks
Lamp_Run := Motor;
`,
    },
    alt: {
      lang: 'ST',
      label: 'Solution (Structured Text)',
      source: `PROGRAM MotorControl
VAR
  Permissive : BOOL;
END_VAR

Permissive := Stop AND E_Stop AND Overload_OK;
Motor := (Start OR Motor) AND Permissive;
Lamp_Run := Motor;
Lamp_Fault := NOT E_Stop OR NOT Overload_OK;
END_PROGRAM
`,
    },
  },
  match: {
    keywords: [['motor', 2], ['start', 1], ['stop', 1], ['seal-in', 4], ['self-holding', 4], ['latching', 2], ['holding contact', 3], ['contactor', 3], ['overload', 3], ['emergency stop', 3], ['e-stop', 3], ['interlock', 2], ['dol', 2], ['direct on line', 3], ['pilot light', 2], ['normally closed', 1.5]],
    params: [{ key: 'load', re: /load[^.\d]{0,20}(\d{1,3})\s*%/i }, { key: 'trip', re: /trip[^.\d]{0,25}(\d{2,3})\s*°?\s*c\b/i }],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(-4, 0, 22);
    addScenery(world, [[-26, -24], [24, -26, 1.2], [-27, 20], [26, 22, 0.9]]);
    s.add(at(strip(40, 30, COLORS.gray, 0.02), 0, 0, -2));

    // control desk
    const desk = controlDesk(12, 4, COLORS.blue);
    desk.position.set(-6, 0, 10);
    s.add(desk);
    world.addCollider(desk);
    const bStart = onDesk(desk, pushButton(0x1fbf3a), -4, 0, 'START');
    const bStop = onDesk(desk, pushButton(0xe02020), -1.3, 0, 'STOP');
    const bE = onDesk(desk, pushButton(0xe02020, { housing: COLORS.yellow, mushroom: true }), 1.6, 0, 'E-STOP');
    const lRun = onDesk(desk, lamp(0x22ff55), 3.8, -0.6, 'RUN');
    const lFault = onDesk(desk, lamp(0xff2222), 5.2, -0.6, 'FAULT');
    wireButton(world, io, bStart, 'Start', 'momentary', 'START (NO)');
    wireButton(world, io, bStop, 'Stop', 'nc-momentary', 'STOP (NC)');
    world.addInteractable(bE, {
      tip: 'E-STOP (latching NC) – click to latch/release',
      onDown() {
        const released = !io.get('E_Stop');
        io.set('E_Stop', released);
        bE.userData.press(!released);
      },
    });

    // motor + flywheel
    const motor = new THREE.Group();
    motor.position.set(6, 0, -6);
    const body = brick(6, 6, 12, COLORS.dark);
    motor.add(body);
    for (let i = 0; i < 5; i++) motor.add(at(brick(6.4, 0.6, 12, COLORS.gray, { studs: false }), 0, 0, -2.4 + i * 1.2));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 4, 12), new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.6, roughness: 0.3 }));
    shaft.rotation.x = Math.PI / 2;
    shaft.position.set(0, 2.4, 4.5);
    motor.add(shaft);
    const fan = flywheel(3, COLORS.yellow);
    fan.position.set(0, 2.4, 6.4);
    motor.add(fan);
    const ml = label('MOTOR M1', { size: 0.8 });
    ml.position.set(0, 6.4, 0);
    motor.add(ml);
    s.add(motor);
    world.addCollider(body);

    // electrical cabinet with contactor + thermal relay
    const cab = new THREE.Group();
    cab.position.set(-12, 0, -8);
    cab.add(brick(8, 3, 21, COLORS.gray));
    const k1 = brick(2, 1, 5, COLORS.white);
    k1.position.set(-1.8, 4, 1.6);
    cab.add(k1);
    const k1lamp = lamp(0x33aaff, { r: 0.3, h: 0.3 });
    k1lamp.rotation.x = Math.PI / 2;
    k1lamp.position.set(-1.8, 5.4, 2.2);
    cab.add(k1lamp);
    const ol = brick(2, 1, 4, COLORS.white);
    ol.position.set(1.8, 4, 1.6);
    cab.add(ol);
    const olReset = pushButton(0x2266ff, { housing: COLORS.white });
    olReset.scale.setScalar(0.5);
    olReset.rotation.x = Math.PI / 2;
    olReset.position.set(1.8, 5, 2.3);
    cab.add(olReset);
    const cl = label('K1  |  F1 overload', { size: 0.6 });
    cl.position.set(0, 9.6, 1.8);
    cab.add(cl);
    const tempLabel = label('F1: 20 °C', { size: 0.6, bg: 'rgba(30,60,140,0.85)' });
    tempLabel.position.set(1.8, 7.3, 2.4);
    cab.add(tempLabel);
    s.add(cab);
    world.addCollider(cab.children[0]);

    // small belt conveyor driven by the motor
    const belt = tile(18, 4, COLORS.black, 1);
    belt.position.set(-2, 3, -16);
    s.add(belt);
    for (const x of [-10, 6]) s.add(at(brick(2, 4, 7, COLORS.yellow), x, 0, -16));
    const crates = [];
    for (let i = 0; i < 4; i++) {
      const c = brick(2, 2, 3, [COLORS.red, COLORS.azure, COLORS.orange, COLORS.lime][i]);
      c.position.set(-10 + i * 4.5, 3.4, -16);
      s.add(c);
      crates.push(c);
    }
    s.add(figure(-12, 13, COLORS.orange, 0.4));

    let temp = 20;
    let tripped = false;
    let speed = 0;
    world.addInteractable(olReset, {
      tip: 'Overload reset (works once cooled below 60% of trip temperature)',
      onDown() {
        olReset.userData.press(true);
        if (tripped && temp < params.trip * 0.6) tripped = false;
      },
      onUp() { olReset.userData.press(false); },
    });

    const sim = {
      reset() {
        temp = 20; tripped = false; speed = 0;
        io.set('Stop', true); io.set('E_Stop', true); io.set('Start', false); io.set('Overload_OK', true);
        bE.userData.press(false);
      },
      update(dt) {
        const run = io.out('Motor');
        // motor inertia – load slows acceleration
        const target = run ? 1 : 0;
        const acc = run ? 1.4 / (0.6 + params.load / 100) : 0.7;
        speed += Math.sign(target - speed) * Math.min(Math.abs(target - speed), acc * dt);
        // thermal model
        const heat = run ? (params.load / 100) ** 2 * 18 : 0;
        temp += (heat - (temp - 20) * 0.08) * dt;
        if (temp >= params.trip) tripped = true;
        io.set('Overload_OK', !tripped);
      },
      render(dt) {
        fan.rotation.z -= speed * dt * 18;
        for (const c of crates) {
          c.position.x += speed * dt * 4;
          if (c.position.x > 6) c.position.x -= 17;
        }
        lRun.userData.set(io.out('Lamp_Run'));
        lFault.userData.set(io.out('Lamp_Fault'));
        k1lamp.userData.set(io.out('Motor'));
        tempLabel.userData.setText(`F1: ${temp.toFixed(0)} °C ${tripped ? 'TRIPPED' : ''}`);
      },
      status() {
        return [
          ['Motor speed', `${(speed * 1450).toFixed(0)} rpm`],
          ['Winding temp', `${temp.toFixed(1)} °C`],
          ['Overload', tripped ? 'TRIPPED – cool down & reset' : 'OK'],
        ];
      },
    };
    return sim;
  },
};
