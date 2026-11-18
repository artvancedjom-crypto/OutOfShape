import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, controlDesk, onDesk, addScenery, plastic, figure } from './common.js';

const SOLUTION = `PROGRAM TankLevel
(* Two-point (hysteresis) level control with dry-run & overflow protection *)
VAR
  PumpLatch : BOOL;
  Flash     : TON;
  FlashOn   : BOOL;
END_VAR

IF Auto THEN
  IF Level <= SP_Low  THEN PumpLatch := TRUE;  END_IF;   (* start below low setpoint *)
  IF Level >= SP_High THEN PumpLatch := FALSE; END_IF;   (* stop above high setpoint *)
  Pump := PumpLatch AND NOT LS_HighHigh;
ELSE
  PumpLatch := FALSE;
  Pump := Manual_Pump AND NOT LS_HighHigh;               (* jog, still protected *)
END_IF;

(* consumer valve only when the dry-run switch reports water *)
Valve_Out := Demand AND LS_Low;

(* flashing alarm beacon *)
Flash(IN := NOT Flash.Q, PT := T#400ms);
IF Flash.Q THEN FlashOn := NOT FlashOn; END_IF;
Alarm := (LS_HighHigh OR NOT LS_Low) AND FlashOn;
Lamp_Auto := Auto;
END_PROGRAM
`;

const STARTER = `(* Tank level control exercise
   Keep Level (0..100 %) between SP_Low and SP_High using the Pump.
   - Do not switch the pump on/off every scan: you need hysteresis!
   - LS_HighHigh = TRUE means the tank is about to overflow.
   - LS_Low = FALSE means the tank is (nearly) empty: close Valve_Out. *)

Pump := Level < SP_Low;   // TODO: this chatters – add a latch
Valve_Out := Demand;
Lamp_Auto := Auto;
`;

export default {
  id: 'tank',
  name: 'Tank Level Control',
  difficulty: 'Intermediate',
  minutes: 20,
  icon: '🛢️',
  summary: 'Fill a storage tank with a pump and keep the level inside a band while a consumer draws water. Analog level transmitter, discrete level switches, auto/manual mode and alarms.',
  objectives: [
    'In AUTO, start the pump at SP_Low and stop it at SP_High (hysteresis – watch the "pump starts" counter).',
    'Never overflow: LS_HighHigh must force the pump off, also in MANUAL.',
    'Open Valve_Out only when the consumer demands water AND the dry-run switch LS_Low is TRUE.',
    'Flash the Alarm beacon on high-high or low level.',
    'Try the sensor noise parameter: what happens to a controller without hysteresis?',
  ],
  io: {
    inputs: [
      { name: 'Level', type: 'REAL', addr: '%IW64', desc: 'Level transmitter LT1 (0–100 %)', ui: 'analog', min: 0, max: 100, unit: '%' },
      { name: 'LS_Low', addr: '%I0.0', desc: 'Level switch low (TRUE = water above 10 %)', ui: 'sensor' },
      { name: 'LS_HighHigh', addr: '%I0.1', desc: 'Level switch high-high (TRUE ≥ 95 %)', ui: 'sensor' },
      { name: 'Auto', addr: '%I0.2', desc: 'Mode selector AUTO/MANUAL', ui: 'toggle' },
      { name: 'Manual_Pump', addr: '%I0.3', desc: 'Manual pump jog button', ui: 'momentary' },
      { name: 'Demand', addr: '%I0.4', desc: 'Consumer demand request', ui: 'toggle' },
      { name: 'SP_Low', type: 'REAL', addr: '%MD20', desc: 'HMI setpoint: pump start level', ui: 'setpoint', unit: '%' },
      { name: 'SP_High', type: 'REAL', addr: '%MD24', desc: 'HMI setpoint: pump stop level', ui: 'setpoint', unit: '%' },
    ],
    outputs: [
      { name: 'Pump', addr: '%Q0.0', desc: 'Feed pump P1' },
      { name: 'Valve_Out', addr: '%Q0.1', desc: 'Outlet valve V1 to consumer' },
      { name: 'Alarm', addr: '%Q0.2', desc: 'Alarm beacon' },
      { name: 'Lamp_Auto', addr: '%Q0.3', desc: 'AUTO mode indicator' },
    ],
  },
  params: [
    { key: 'spLow', label: 'Start level (SP_Low)', min: 5, max: 60, step: 1, default: 30, unit: '%', input: 'SP_Low' },
    { key: 'spHigh', label: 'Stop level (SP_High)', min: 40, max: 95, step: 1, default: 80, unit: '%', input: 'SP_High' },
    { key: 'capacity', label: 'Tank capacity', min: 200, max: 5000, step: 50, default: 1000, unit: 'L' },
    { key: 'inflow', label: 'Pump flow', min: 5, max: 200, step: 5, default: 60, unit: 'L/s' },
    { key: 'outflow', label: 'Consumer flow (full tank)', min: 0, max: 150, step: 5, default: 35, unit: 'L/s' },
    { key: 'noise', label: 'Transmitter noise', min: 0, max: 5, step: 0.5, default: 0.5, unit: '%' },
  ],
  programs: { solution: { lang: 'ST', source: SOLUTION }, starter: { lang: 'ST', source: STARTER } },
  match: {
    keywords: [['tank', 3], ['level control', 5], ['liquid level', 4], ['water level', 4], ['level sensor', 3], ['level switch', 3], ['float switch', 3], ['pump', 2], ['fill', 1], ['overflow', 2], ['reservoir', 2], ['hysteresis', 2], ['valve', 1], ['high level', 2], ['low level', 2], ['dry run', 2]],
    params: [
      { key: 'capacity', re: /(?:capacity|volume)[^.\d]{0,25}?(\d+(?:[.,]\d+)?)\s*(?:l\b|liters|litres)/i },
      { key: 'capacity', re: /(\d+(?:\.\d+)?)\s*m(?:3|³)/i, scale: 1000 },
      { key: 'inflow', re: /(?:pump|inflow|inlet)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:l\/s|liters? per second)/i },
      { key: 'outflow', re: /(?:outflow|outlet|consum\w*|drain)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:l\/s|liters? per second)/i },
      { key: 'spLow', re: /(?:start|low(?:er)?)[^.\d]{0,30}?(\d{1,2})\s*%/i },
      { key: 'spHigh', re: /(?:stop|high(?:er)?|upper)[^.\d]{0,30}?(\d{2})\s*%/i },
    ],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(-14, 0, 20);
    addScenery(world, [[-26, -22], [24, -26], [-24, 24, 1.1], [27, 10]]);
    const TANK_H = 16;
    const TANK_R = 5;
    // concrete pad
    s.add(at(tile(20, 20, COLORS.gray, 1), 0, 0, -4));
    // tank: brick ring base + glass wall + water
    const tank = new THREE.Group();
    tank.position.set(0, 0.4, -4);
    for (let a = 0; a < 16; a++) {
      const b = brick(2, 1, 3, a % 2 ? COLORS.white : COLORS.azure);
      const ang = (a / 16) * Math.PI * 2;
      b.position.set(Math.cos(ang) * TANK_R, 0, Math.sin(ang) * TANK_R);
      b.rotation.y = -ang + Math.PI / 2;
      tank.add(b);
    }
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(TANK_R, TANK_R, TANK_H, 40, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xcfefff, transparent: true, opacity: 0.22, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    );
    glass.position.y = 1.2 + TANK_H / 2;
    tank.add(glass);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(TANK_R, 0.25, 8, 40), plastic(COLORS.azure));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 1.2 + TANK_H;
    tank.add(rim);
    const waterMat = new THREE.MeshStandardMaterial({ color: COLORS.water, transparent: true, opacity: 0.78, roughness: 0.1 });
    const water = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R - 0.2, TANK_R - 0.2, 1, 40), waterMat);
    water.position.y = 1.2;
    tank.add(water);
    // scale marks
    for (let p = 0; p <= 100; p += 25) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 0.08), plastic(COLORS.black));
      m.position.set(0, 1.2 + (TANK_H * p) / 100, TANK_R + 0.1);
      tank.add(m);
    }
    s.add(tank);
    world.addCollider(glass, 0.5);
    // level switches on the wall
    const mkSwitch = (pct, text) => {
      const b = brick(1, 1, 2, COLORS.orange, { studs: false });
      b.position.set(TANK_R + 0.6, 1.2 + (TANK_H * pct) / 100 - 0.4, 0);
      tank.add(b);
      const l = lamp(0x33ff66, { r: 0.22, h: 0.2 });
      l.rotation.z = -Math.PI / 2;
      l.position.set(TANK_R + 1.15, 1.2 + (TANK_H * pct) / 100, 0);
      tank.add(l);
      const lb = label(text, { size: 0.45 });
      lb.position.set(TANK_R + 2.6, 1.2 + (TANK_H * pct) / 100 + 0.5, 0);
      tank.add(lb);
      return l;
    };
    const lsLow = mkSwitch(10, 'LS_Low 10%');
    const lsHH = mkSwitch(95, 'LS_HH 95%');
    // level transmitter
    const lt = brick(2, 2, 3, COLORS.yellow);
    lt.position.set(0, 1.2 + TANK_H, 0);
    tank.add(lt);
    const ltLabel = label('LT1: 0.0 %', { size: 0.7, bg: 'rgba(10,60,120,0.9)' });
    ltLabel.position.set(0, TANK_H + 4.2, 0);
    tank.add(ltLabel);

    // pump + pipes
    const sump = tile(10, 6, COLORS.water, 2);
    sump.position.set(-16, 0, -14);
    s.add(sump);
    const pump = new THREE.Group();
    pump.position.set(-11, 0.4, -6);
    pump.add(brick(4, 3, 6, COLORS.blue));
    const imp = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.4, 6), plastic(COLORS.yellow));
    imp.rotation.x = Math.PI / 2;
    imp.position.set(0, 1.4, 1.7);
    pump.add(imp);
    const pl = label('P1', { size: 0.7 });
    pl.position.set(0, 3.8, 0);
    pump.add(pl);
    s.add(pump);
    world.addCollider(pump.children[0]);
    const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, metalness: 0.5, roughness: 0.35 });
    const pipe = (x1, y1, z1, x2, y2, z2, r = 0.35) => {
      const a = new THREE.Vector3(x1, y1, z1);
      const b = new THREE.Vector3(x2, y2, z2);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), pipeMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      m.castShadow = true;
      s.add(m);
      return m;
    };
    pipe(-16, 0.5, -12, -11, 0.5, -7.5);
    pipe(-11, 2.8, -6, -11, 19.5, -6);
    pipe(-11, 19.5, -6, -2, 19.5, -4);
    pipe(-2, 19.5, -4, -2, 18, -4);
    // inflow stream
    const streamMat = new THREE.MeshStandardMaterial({ color: COLORS.water, transparent: true, opacity: 0.7 });
    const stream = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1, 8), streamMat);
    stream.position.set(-2, 0, -4);
    s.add(stream);
    // outlet pipe + valve + consumer fountain
    pipe(4.6, 1.4, -4, 12, 1.4, -4);
    const valve = new THREE.Group();
    valve.position.set(9, 1.4, -4);
    const vb = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), plastic(COLORS.red));
    valve.add(vb);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.12, 6, 16), plastic(COLORS.yellow));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = 1.0;
    valve.add(wheel);
    const vl = label('V1', { size: 0.6 });
    vl.position.y = 2;
    valve.add(vl);
    s.add(valve);
    const basin = new THREE.Group();
    basin.position.set(15, 0.4, -4);
    for (let a = 0; a < 8; a++) {
      const b = brick(2, 1, 2, COLORS.tan);
      const ang = (a / 8) * Math.PI * 2;
      b.position.set(Math.cos(ang) * 2.4, 0, Math.sin(ang) * 2.4);
      b.rotation.y = -ang + Math.PI / 2;
      basin.add(b);
    }
    const fountain = new THREE.Mesh(new THREE.ConeGeometry(0.6, 3, 10, 1, true), streamMat);
    fountain.position.y = 1.5;
    basin.add(fountain);
    const bl = label('CONSUMER', { size: 0.6 });
    bl.position.y = 4.2;
    basin.add(bl);
    s.add(basin);

    // HMI desk
    const desk = controlDesk(14, 4, COLORS.white);
    desk.position.set(-6, 0, 12);
    s.add(desk);
    world.addCollider(desk);
    const bAuto = onDesk(desk, pushButton(0x2266ff), -5, 0, 'AUTO/MAN');
    const bMan = onDesk(desk, pushButton(0x1fbf3a), -2, 0, 'PUMP JOG');
    const bDem = onDesk(desk, pushButton(0xff9900), 1, 0, 'DEMAND');
    const lAuto = onDesk(desk, lamp(0x3399ff), 3.5, -0.6, 'AUTO');
    const lAlarm = onDesk(desk, lamp(0xff2222), 5.5, -0.6, 'ALARM');
    wireButton(world, io, bAuto, 'Auto', 'toggle', 'Mode selector AUTO/MANUAL');
    wireButton(world, io, bMan, 'Manual_Pump', 'momentary', 'Manual pump (MANUAL mode only)');
    wireButton(world, io, bDem, 'Demand', 'toggle', 'Consumer demand');
    const beacon = lamp(0xff3300, { r: 0.7, h: 1 });
    beacon.position.set(0, 1.2 + TANK_H + 1.4, 3);
    tank.add(beacon);
    s.add(figure(-12, 14, COLORS.azure, 0.3));

    let vol = 0;
    let overflowL = 0;
    let pumpStarts = 0;
    let lastPump = false;
    let qin = 0;
    let qout = 0;
    let noisy = 0;
    let t = 0;
    const sim = {
      reset() {
        vol = params.capacity * 0.2;
        overflowL = 0;
        pumpStarts = 0;
        lastPump = false;
        io.set('Auto', true);
        io.set('Demand', true);
        bAuto.userData.press(true);
        bDem.userData.press(true);
      },
      update(dt) {
        t += dt;
        const pumpOn = !!io.out('Pump');
        if (pumpOn && !lastPump) pumpStarts++;
        lastPump = pumpOn;
        const frac = vol / params.capacity;
        qin = pumpOn ? params.inflow : 0;
        qout = io.out('Valve_Out') ? params.outflow * Math.sqrt(Math.max(0, frac)) : 0;
        vol += (qin - qout) * dt;
        if (vol > params.capacity) { overflowL += vol - params.capacity; vol = params.capacity; }
        if (vol < 0) vol = 0;
        const lvl = (vol / params.capacity) * 100;
        // noise: low-pass filtered random walk
        noisy += ((Math.random() - 0.5) * 2 * params.noise - noisy) * 0.5;
        io.set('Level', Math.max(0, Math.min(100, lvl + noisy)));
        io.set('LS_Low', lvl > 10);
        io.set('LS_HighHigh', lvl >= 95);
      },
      render(dt) {
        const lvl = vol / params.capacity;
        const h = Math.max(0.01, lvl * TANK_H);
        water.scale.y = h;
        water.position.y = 1.2 + h / 2;
        ltLabel.userData.setText(`LT1: ${(lvl * 100).toFixed(1)} %`);
        lsLow.userData.set(lvl > 0.1);
        lsHH.userData.set(lvl >= 0.95);
        if (io.out('Pump')) imp.rotation.z += dt * 20;
        const flowing = io.out('Pump');
        stream.visible = flowing;
        if (flowing) {
          const top = 18;
          const bottom = 1.6 + h;
          stream.scale.y = top - bottom;
          stream.position.y = (top + bottom) / 2;
        }
        wheel.rotation.z = io.out('Valve_Out') ? Math.PI / 2 : 0;
        vb.material = plastic(io.out('Valve_Out') ? COLORS.green : COLORS.red);
        fountain.visible = qout > 0.5;
        fountain.scale.y = Math.max(0.2, qout / Math.max(1, params.outflow));
        fountain.position.y = 1.5 * fountain.scale.y;
        lAuto.userData.set(io.out('Lamp_Auto'));
        lAlarm.userData.set(io.out('Alarm'));
        beacon.userData.set(io.out('Alarm'));
      },
      status() {
        return [
          ['Level', `${((vol / params.capacity) * 100).toFixed(1)} % (${vol.toFixed(0)} L)`],
          ['Inflow / outflow', `${qin.toFixed(0)} / ${qout.toFixed(1)} L/s`],
          ['Pump starts', String(pumpStarts)],
          ['Overflowed', overflowL > 0 ? `⚠ ${overflowL.toFixed(0)} L` : '0 L'],
        ];
      },
    };
    return sim;
  },
};
