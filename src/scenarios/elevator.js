import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, addScenery, plastic, figure } from './common.js';

const SOLUTION = `PROGRAM Elevator3
(* 3-floor elevator: call memory, direction preference, door cycle *)
VAR
  Req1, Req2, Req3 : BOOL;
  Pos   : INT := 1;     (* last floor seen *)
  Dir   : INT := 0;     (* 1 = up, -1 = down *)
  Step  : INT := 0;
  Above, Below, Here : BOOL;
  DoorTimer : TON;
END_VAR

(* register calls *)
IF Call_1 THEN Req1 := TRUE; END_IF;
IF Call_2 THEN Req2 := TRUE; END_IF;
IF Call_3 THEN Req3 := TRUE; END_IF;

IF Floor_1 THEN Pos := 1; END_IF;
IF Floor_2 THEN Pos := 2; END_IF;
IF Floor_3 THEN Pos := 3; END_IF;

Here  := (Req1 AND Floor_1) OR (Req2 AND Floor_2) OR (Req3 AND Floor_3);
Above := (Pos < 2 AND Req2) OR (Pos < 3 AND Req3);
Below := (Pos > 2 AND Req2) OR (Pos > 1 AND Req1);

CASE Step OF
  0: (* idle, doors closed *)
     Motor_Up := FALSE; Motor_Down := FALSE; Door_Open := FALSE;
     IF Here THEN
       Step := 3;
     ELSIF Door_Closed THEN
       IF Above AND (Dir >= 0 OR NOT Below) THEN Dir := 1; Step := 1;
       ELSIF Below THEN Dir := -1; Step := 2;
       ELSE Dir := 0;
       END_IF;
     END_IF;
  1: (* travelling up *)
     Motor_Up := Door_Closed;
     IF (Floor_2 AND Req2) OR (Floor_3 AND Req3) OR Limit_Top THEN
       Motor_Up := FALSE; Step := 3;
     END_IF;
  2: (* travelling down *)
     Motor_Down := Door_Closed;
     IF (Floor_1 AND Req1) OR (Floor_2 AND Req2) OR Limit_Bottom THEN
       Motor_Down := FALSE; Step := 3;
     END_IF;
  3: (* open door, serve floor *)
     Door_Open := TRUE;
     IF Floor_1 THEN Req1 := FALSE; END_IF;
     IF Floor_2 THEN Req2 := FALSE; END_IF;
     IF Floor_3 THEN Req3 := FALSE; END_IF;
     DoorTimer(IN := Door_Opened, PT := SP_DoorTime);
     IF DoorTimer.Q THEN DoorTimer(IN := FALSE); Door_Open := FALSE; Step := 4; END_IF;
  4: (* wait for door closed *)
     IF Door_Closed THEN Step := 0; END_IF;
END_CASE;

Lamp_Call1 := Req1;
Lamp_Call2 := Req2;
Lamp_Call3 := Req3;
END_PROGRAM
`;

const STARTER = `(* Elevator exercise
   Floors 1..3 with call buttons Call_1..Call_3 and floor sensors Floor_1..Floor_3.
   Drive Motor_Up / Motor_Down, open the door with Door_Open.
   Never move unless Door_Closed! Limit_Top / Limit_Bottom are overtravel switches. *)
VAR
  Req3 : BOOL;
END_VAR

IF Call_3 THEN Req3 := TRUE; END_IF;
Motor_Up := Req3 AND NOT Floor_3 AND Door_Closed;
IF Floor_3 THEN Req3 := FALSE; END_IF;
Lamp_Call3 := Req3;
`;

const FLOOR_H = 8;

export default {
  id: 'elevator',
  name: '3-Floor Elevator',
  difficulty: 'Advanced',
  minutes: 40,
  icon: '🛗',
  summary: 'A three-storey lift with landing call buttons, floor position sensors, door limit switches and overtravel limits. Ride it in first-person mode!',
  objectives: [
    'Register calls (latch) and light the call lamps until served.',
    'Choose the travel direction; keep going in the same direction while there are calls ahead.',
    'Stop at the requested floor, open the door for SP_DoorTime, then close.',
    'Never move with the door open (the sim counts violations) and never hit the limit switches.',
    'Tip: in first-person mode walk into the car on floor 1 and call floor 3.',
  ],
  io: {
    inputs: [
      { name: 'Call_1', addr: '%I0.0', desc: 'Landing call floor 1', ui: 'momentary' },
      { name: 'Call_2', addr: '%I0.1', desc: 'Landing call floor 2', ui: 'momentary' },
      { name: 'Call_3', addr: '%I0.2', desc: 'Landing call floor 3', ui: 'momentary' },
      { name: 'Floor_1', addr: '%I0.3', desc: 'Car level at floor 1', ui: 'sensor' },
      { name: 'Floor_2', addr: '%I0.4', desc: 'Car level at floor 2', ui: 'sensor' },
      { name: 'Floor_3', addr: '%I0.5', desc: 'Car level at floor 3', ui: 'sensor' },
      { name: 'Door_Closed', addr: '%I0.6', desc: 'Door closed limit switch', ui: 'sensor' },
      { name: 'Door_Opened', addr: '%I0.7', desc: 'Door fully open limit switch', ui: 'sensor' },
      { name: 'Limit_Top', addr: '%I1.0', desc: 'Overtravel top', ui: 'sensor' },
      { name: 'Limit_Bottom', addr: '%I1.1', desc: 'Overtravel bottom', ui: 'sensor' },
      { name: 'SP_DoorTime', type: 'TIME', addr: '%MD40', desc: 'HMI setpoint: door dwell time', ui: 'setpoint' },
    ],
    outputs: [
      { name: 'Motor_Up', addr: '%Q0.0' }, { name: 'Motor_Down', addr: '%Q0.1' }, { name: 'Door_Open', addr: '%Q0.2' },
      { name: 'Lamp_Call1', addr: '%Q0.3' }, { name: 'Lamp_Call2', addr: '%Q0.4' }, { name: 'Lamp_Call3', addr: '%Q0.5' },
    ],
  },
  params: [
    { key: 'speed', label: 'Car speed', min: 0.5, max: 5, step: 0.25, default: 2.5, unit: 'studs/s' },
    { key: 'door', label: 'Door dwell (SP_DoorTime)', min: 1, max: 8, step: 0.5, default: 2.5, unit: 's', input: 'SP_DoorTime', scale: 1000 },
    { key: 'doorSpeed', label: 'Door travel time', min: 0.3, max: 3, step: 0.1, default: 1, unit: 's' },
  ],
  programs: { solution: { lang: 'ST', source: SOLUTION }, starter: { lang: 'ST', source: STARTER } },
  match: {
    keywords: [['elevator', 5], ['lift', 3], ['floor', 1.5], ['storey', 2], ['car', 0.5], ['landing', 2], ['call button', 3], ['hoist', 2], ['door', 1], ['limit switch', 2], ['overtravel', 2]],
    params: [{ key: 'door', re: /door[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i }],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(14, 0, 16);
    addScenery(world, [[-24, -22], [24, -24], [-26, 20], [26, 24]]);
    const SX = 0; // shaft centre
    const SZ = -4;
    const TOP = FLOOR_H * 2;
    // shaft corner columns
    for (const [dx, dz] of [[-3.5, -3.5], [-3.5, 3.5], [3.5, -3.5], [3.5, 3.5]]) {
      const c = brick(1, 1, Math.round(((TOP + 10) / PLATE)), COLORS.gray, { studs: false });
      c.position.set(SX + dx, 0, SZ + dz);
      s.add(c);
    }
    // back wall + side walls (glass-ish panels)
    const panel = new THREE.MeshStandardMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false, side: THREE.DoubleSide });
    for (const [x, z, w, d] of [[SX - 3.5, SZ, 0.2, 7], [SX, SZ - 3.5, 7, 0.2], [SX, SZ + 3.5, 7, 0.2]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, TOP + 10, d), panel);
      m.position.set(x, (TOP + 10) / 2, z);
      s.add(m);
      world.addCollider(m, 0.2);
    }
    const roof = brick(8, 8, 3, COLORS.red);
    roof.position.set(SX, TOP + 10, SZ);
    s.add(roof);
    // landings (floors 2 & 3) + building
    const landings = [];
    for (let f = 0; f < 3; f++) {
      const y = f * FLOOR_H;
      if (f > 0) {
        const slab = brick(12, 14, 2, [COLORS.tan, COLORS.white, COLORS.yellow][f], { studs: true });
        slab.position.set(SX + 10, y - 0.8, SZ);
        s.add(slab);
        const rail = brick(12, 1, 3, COLORS.blue);
        rail.position.set(SX + 10, y, SZ + 6.5);
        s.add(rail);
      }
      landings.push(y);
      const lb = label(`FLOOR ${f + 1}`, { size: 0.7 });
      lb.position.set(SX + 5, y + 6.2, SZ - 4);
      s.add(lb);
    }
    // stair-like ramp so the player can walk up (ground → floor 2 → floor 3)
    world.groundAt = (x, z, feet) => {
      // elevator car floor
      const inCar = Math.abs(x - SX) < 3.2 && Math.abs(z - SZ) < 3.2;
      if (inCar) return carY + 0.4;
      // landings
      if (x > SX + 3.8 && x < SX + 16 && Math.abs(z - SZ) < 7) {
        let best = 0;
        for (const y of landings) if (y <= feet + 1.2) best = Math.max(best, y);
        return best;
      }
      return 0;
    };

    // car
    const car = new THREE.Group();
    const cfloor = brick(6, 6, 1, COLORS.dark, { studs: false });
    car.add(cfloor);
    const croof = brick(6, 6, 1, COLORS.dark, { studs: false });
    croof.position.y = 6.4;
    car.add(croof);
    const back = brick(1, 6, 16, COLORS.azure, { studs: false });
    back.position.set(-2.5, 0.4, 0);
    car.add(back);
    for (const z of [-2.5, 2.5]) {
      const side = brick(6, 1, 16, COLORS.azure, { studs: false });
      side.position.set(0, 0.4, z);
      car.add(side);
    }
    const doorMat = plastic(COLORS.yellow);
    const doorL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 2.5), doorMat);
    const doorR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 2.5), doorMat);
    doorL.castShadow = doorR.castShadow = true;
    car.add(doorL, doorR);
    const carLamp = new THREE.PointLight(0xfff2cc, 6, 10);
    carLamp.position.y = 5.5;
    car.add(carLamp);
    const ind = label('1', { size: 1.1, bg: 'rgba(0,0,0,0.85)', color: '#ff7a1a' });
    ind.position.set(3.2, 7.6, 0);
    car.add(ind);
    car.position.set(SX, 0, SZ);
    s.add(car);
    // counterweight
    const cw = brick(1, 2, 6, COLORS.black);
    cw.position.set(SX - 2.8, 0, SZ - 2.8);
    s.add(cw);
    // cables
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 6), plastic(COLORS.black));
    s.add(cable);

    // call buttons on each landing
    const callLamps = [];
    for (let f = 0; f < 3; f++) {
      const y = f * FLOOR_H;
      const post = brick(1, 1, 9, COLORS.dark, { studs: false });
      post.position.set(SX + 4.5, y, SZ + 4.6);
      s.add(post);
      const b = pushButton(0xffffff, { housing: COLORS.dark });
      b.scale.setScalar(0.8);
      b.position.set(SX + 4.5, y + 3.6, SZ + 4.6);
      s.add(b);
      wireButton(world, io, b, `Call_${f + 1}`, 'momentary', `Call button floor ${f + 1}`);
      const l = lamp(0xffa000, { r: 0.3, h: 0.3 });
      l.position.set(SX + 4.5, y + 5, SZ + 4.6);
      s.add(l);
      callLamps.push(l);
    }
    s.add(figure(12, 8, COLORS.green, -1.2));
    const fig2 = figure(12, -8, COLORS.pink, -2);
    fig2.position.y = FLOOR_H;
    s.add(fig2);

    let carY = 0;
    let door = 0; // 0 closed .. 1 open
    let violations = 0;
    let overtravel = 0;
    let trips = 0;
    let wasMoving = false;
    const sim = {
      reset() {
        carY = 0;
        door = 0;
        violations = overtravel = trips = 0;
      },
      update(dt) {
        const up = io.out('Motor_Up');
        const down = io.out('Motor_Down');
        const dir = (up ? 1 : 0) - (down ? 1 : 0);
        if (dir !== 0 && door > 0.02) violations++;
        carY += dir * params.speed * dt;
        if (carY > TOP + 0.6) { carY = TOP + 0.6; overtravel++; }
        if (carY < -0.6) { carY = -0.6; overtravel++; }
        const moving = dir !== 0;
        if (wasMoving && !moving) trips++;
        wasMoving = moving;
        door += ((io.out('Door_Open') ? 1 : -1) * dt) / params.doorSpeed;
        door = Math.max(0, Math.min(1, door));
        for (let f = 0; f < 3; f++) io.set(`Floor_${f + 1}`, Math.abs(carY - f * FLOOR_H) < 0.12);
        io.set('Door_Closed', door < 0.01);
        io.set('Door_Opened', door > 0.99);
        io.set('Limit_Top', carY > TOP + 0.4);
        io.set('Limit_Bottom', carY < -0.4);
      },
      render() {
        car.position.y = carY;
        doorL.position.set(3, 3.4, -1.25 - door * 2.2);
        doorR.position.set(3, 3.4, 1.25 + door * 2.2);
        const floorNum = Math.min(3, Math.max(1, Math.round(carY / FLOOR_H) + 1));
        ind.userData.setText(String(floorNum) + (io.out('Motor_Up') ? '▲' : io.out('Motor_Down') ? '▼' : ''));
        cw.position.y = TOP - carY;
        const topY = TOP + 10;
        cable.scale.y = topY - (carY + 7);
        cable.position.set(SX, (topY + carY + 7) / 2, SZ);
        for (let f = 0; f < 3; f++) callLamps[f].userData.set(io.out(`Lamp_Call${f + 1}`));
      },
      status() {
        return [
          ['Car height', `${carY.toFixed(2)} (floor ${(carY / FLOOR_H + 1).toFixed(2)})`],
          ['Door', door < 0.01 ? 'closed' : door > 0.99 ? 'open' : 'moving'],
          ['Stops made', String(trips)],
          ['Moved with door open', violations ? `⚠ ${violations} scans` : '0'],
          ['Overtravel', overtravel ? `⚠ ${overtravel}` : '0'],
        ];
      },
    };
    return sim;
  },
};
