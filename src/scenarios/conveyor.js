import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, controlDesk, onDesk, addScenery, photoEye, plastic, figure } from './common.js';

const SOLUTION = `PROGRAM SortingConveyor
(* Sort tall boxes to the side chute, let small boxes run to the end. *)
VAR
  Running  : BOOL;
  TallFlag : BOOL;      (* a tall box is travelling to the pusher *)
  Pushing  : BOOL;
  TallEdge : R_TRIG;
  PushEdge : R_TRIG;
  EndEdge  : R_TRIG;
  C_Tall   : CTU;
  C_Small  : CTU;
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
IF Pusher_Out THEN Pushing := FALSE; END_IF;   (* retract at end stop *)

Pusher   := Pushing;
Conveyor := Running AND NOT Pushing AND Pusher_Home;
Lamp_Run := Running;

C_Tall(CU := Pusher_Out, R := FALSE, PV := 999);
C_Small(CU := EndEdge.Q, R := FALSE, PV := 999);
END_PROGRAM
`;

const STARTER = `(* Sorting conveyor exercise
   - Start/Stop the belt (Stop is NC).
   - PE_Tall sees only tall boxes, PE_Pusher sees every box in front of the pusher.
   - Extend Pusher for tall boxes only; retract on Pusher_Out.
   - Count tall and small boxes with CTU counters. *)
VAR
  Running : BOOL;
END_VAR

Running := (Start OR Running) AND Stop;
Conveyor := Running;
Lamp_Run := Running;
`;

export default {
  id: 'conveyor',
  name: 'Conveyor Sorting Station',
  difficulty: 'Intermediate',
  minutes: 25,
  icon: '📦',
  summary: 'Boxes of two heights travel on a belt. A height photo-eye detects tall boxes; a pneumatic pusher must divert them to the side chute while small boxes continue. Uses edge detection, latches and counters.',
  objectives: [
    'Start/stop the belt with a seal-in circuit (Stop is NC).',
    'Remember a tall box (R_TRIG on PE_Tall) until it reaches PE_Pusher.',
    'Stop the belt, extend the pusher until Pusher_Out, then retract and resume.',
    'Count sorted boxes with CTU counters (C_Tall / C_Small).',
    'Goal: 0 mis-sorted boxes.',
  ],
  io: {
    inputs: [
      { name: 'Start', addr: '%I0.0', desc: 'Start button (NO)', ui: 'momentary' },
      { name: 'Stop', addr: '%I0.1', desc: 'Stop button (NC)', ui: 'nc-momentary' },
      { name: 'PE_Tall', addr: '%I0.2', desc: 'Height photo-eye (blocked by tall boxes)', ui: 'sensor' },
      { name: 'PE_Pusher', addr: '%I0.3', desc: 'Photo-eye in front of pusher', ui: 'sensor' },
      { name: 'PE_End', addr: '%I0.4', desc: 'End-of-belt photo-eye', ui: 'sensor' },
      { name: 'Pusher_Home', addr: '%I0.5', desc: 'Pusher retracted limit switch', ui: 'sensor' },
      { name: 'Pusher_Out', addr: '%I0.6', desc: 'Pusher extended limit switch', ui: 'sensor' },
    ],
    outputs: [
      { name: 'Conveyor', addr: '%Q0.0', desc: 'Belt motor' },
      { name: 'Pusher', addr: '%Q0.1', desc: 'Pusher solenoid valve (spring return)' },
      { name: 'Lamp_Run', addr: '%Q0.2', desc: 'Run lamp' },
    ],
  },
  params: [
    { key: 'speed', label: 'Belt speed', min: 1, max: 8, step: 0.5, default: 4, unit: 'studs/s' },
    { key: 'interval', label: 'Box interval', min: 2, max: 10, step: 0.5, default: 3.5, unit: 's' },
    { key: 'tallRatio', label: 'Share of tall boxes', min: 0, max: 100, step: 5, default: 40, unit: '%' },
    { key: 'pusherSpeed', label: 'Pusher stroke time', min: 0.2, max: 2, step: 0.1, default: 0.6, unit: 's' },
  ],
  programs: { solution: { lang: 'ST', source: SOLUTION }, starter: { lang: 'ST', source: STARTER } },
  match: {
    keywords: [['conveyor', 4], ['sorting', 4], ['sort', 2], ['belt', 2], ['pusher', 3], ['diverter', 3], ['photo-eye', 3], ['photoelectric', 3], ['light barrier', 3], ['proximity sensor', 2], ['boxes', 1], ['parts', 0.5], ['cylinder', 1], ['reject', 2], ['height', 1], ['counter', 1]],
    params: [
      { key: 'interval', re: /every\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
      { key: 'speed', re: /(?:belt|conveyor)\s+speed[^.\d]{0,20}?(\d+(?:\.\d+)?)/i },
    ],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(-6, 0, 22);
    addScenery(world, [[-26, -24], [26, -24], [-26, 24], [27, 22]]);
    s.add(at(tile(46, 22, COLORS.gray, 1), -2, 0, 2));
    const BELT_Y = 3.2;
    const X0 = -20;
    const X1 = 16;
    // frame + belt
    for (let x = X0; x <= X1; x += 6) {
      s.add(at(brick(1, 1, 7, COLORS.yellow), x, 0.4, -2.2));
      s.add(at(brick(1, 1, 7, COLORS.yellow), x, 0.4, 2.2));
    }
    const belt = tile(X1 - X0 + 2, 4, COLORS.black, 1);
    belt.position.set((X0 + X1) / 2, BELT_Y - 0.4, 0);
    s.add(belt);
    world.addCollider(belt, 0.8);
    // moving cleats to visualise belt motion
    const cleats = [];
    for (let x = X0; x < X1; x += 2) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.06, 3.8), plastic(COLORS.dark));
      c.position.set(x, BELT_Y + 0.02, 0);
      s.add(c);
      cleats.push(c);
    }
    // side rail opposite pusher
    s.add(at(tile(14, 0.5, COLORS.red, 3), -12, BELT_Y, 2.4));
    // sensors
    const peTall = photoEye(5.2);
    peTall.position.set(-4, BELT_Y + 0.5, 0);
    peTall.children[2].position.y = 2.0; // high beam
    s.add(peTall);
    const lt = label('PE_Tall', { size: 0.5 });
    lt.position.set(-4, BELT_Y + 4.5, -2.6);
    s.add(lt);
    const pePush = photoEye(5.2);
    pePush.position.set(4.2, BELT_Y - 0.4, 0);
    pePush.children[2].position.y = 0.9;
    s.add(pePush);
    const lp = label('PE_Pusher', { size: 0.5 });
    lp.position.set(5.5, BELT_Y + 3.2, 2.6);
    s.add(lp);
    const peEnd = photoEye(5.2);
    peEnd.position.set(X1 - 1, BELT_Y - 0.4, 0);
    peEnd.children[2].position.y = 0.9;
    s.add(peEnd);
    // pusher
    const pusherBase = brick(4, 3, 6, COLORS.blue);
    pusherBase.position.set(4, BELT_Y - 1.2, -5.6);
    s.add(pusherBase);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 10), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.7, roughness: 0.25 }));
    rod.rotation.x = Math.PI / 2;
    s.add(rod);
    const plate = brick(4, 1, 4, COLORS.orange, { studs: false });
    s.add(plate);
    const pl = label('PUSHER', { size: 0.55 });
    pl.position.set(4, BELT_Y + 3.4, -5.6);
    s.add(pl);
    // chute + bins
    const chute = tile(5, 8, COLORS.azure, 1);
    chute.position.set(4, BELT_Y - 1.6, 6.5);
    chute.rotation.x = 0.25;
    s.add(chute);
    const mkBin = (x, z, col, text) => {
      const g = new THREE.Group();
      g.add(at(brick(6, 1, 6, col), 0, 0, -2.5), at(brick(6, 1, 6, col), 0, 0, 2.5), at(brick(1, 4, 6, col), -2.5, 0, 0), at(brick(1, 4, 6, col), 2.5, 0, 0));
      g.position.set(x, 0.4, z);
      const l = label(text, { size: 0.6 });
      l.position.set(0, 4, 0);
      g.add(l);
      s.add(g);
      return g;
    };
    mkBin(4, 12.5, COLORS.red, 'TALL');
    mkBin(X1 + 4.5, 0, COLORS.green, 'SMALL');
    // desk
    const desk = controlDesk(8, 4, COLORS.white);
    desk.position.set(-14, 0, 9);
    s.add(desk);
    world.addCollider(desk);
    const bStart = onDesk(desk, pushButton(0x1fbf3a), -2.5, 0, 'START');
    const bStop = onDesk(desk, pushButton(0xe02020), 0, 0, 'STOP');
    const lRun = onDesk(desk, lamp(0x22ff55), 2.5, -0.6, 'RUN');
    wireButton(world, io, bStart, 'Start', 'momentary', 'START');
    wireButton(world, io, bStop, 'Stop', 'nc-momentary', 'STOP (NC)');
    s.add(figure(-18, 12, COLORS.lime, 0.6));

    let boxes = [];
    let ext = 0;
    let spawnT = 0;
    let cleatOff = 0;
    const stats = { tallOk: 0, smallOk: 0, wrong: 0 };

    const spawn = () => {
      if (boxes.some((b) => b.x < X0 + 5 && b.z === 0)) return;
      const tall = Math.random() * 100 < params.tallRatio;
      const mesh = brick(2, 2, tall ? 6 : 3, tall ? COLORS.red : COLORS.green);
      s.add(mesh);
      boxes.push({ x: X0 + 0.5, z: 0, y: BELT_Y, tall, mesh, state: 'belt', vy: 0 });
    };
    const sim = {
      reset() {
        for (const b of boxes) s.remove(b.mesh);
        boxes = [];
        ext = 0;
        spawnT = 0.5;
        stats.tallOk = stats.smallOk = stats.wrong = 0;
        io.set('Stop', true);
        io.set('Start', false);
      },
      update(dt) {
        const run = io.out('Conveyor');
        const v = run ? params.speed : 0;
        if (run) {
          spawnT -= dt;
          if (spawnT <= 0) { spawn(); spawnT = params.interval; }
          cleatOff = (cleatOff + v * dt) % 2;
        }
        // pusher kinematics
        const rate = 1 / params.pusherSpeed;
        ext += (io.out('Pusher') ? rate : -rate) * dt;
        ext = Math.max(0, Math.min(1, ext));
        const plateFront = -2.2 + ext * 5.2; // z of plate front face
        let pTall = false;
        let pPush = false;
        let pEnd = false;
        for (const b of boxes) {
          if (b.state === 'belt') {
            b.x += v * dt;
            // pusher contact
            if (Math.abs(b.x - 4) < 2.6 && plateFront > b.z - 1) b.z = plateFront + 1;
            if (b.z > 2.6) { b.state = 'chute'; }
            if (b.x > X1 + 1.2) { b.state = 'fall'; }
            if (b.tall && Math.abs(b.x - -4) < 1) pTall = true;
            if (Math.abs(b.x - 4.2) < 1 && b.z < 2) pPush = true;
            if (Math.abs(b.x - (X1 - 1)) < 1) pEnd = true;
          } else if (b.state === 'chute') {
            b.z += 6 * dt;
            b.y -= 1.6 * dt;
            if (b.z > 11.5) {
              b.state = 'done';
              if (b.tall) stats.tallOk++; else stats.wrong++;
            }
          } else if (b.state === 'fall') {
            b.x += 3 * dt;
            b.vy -= 30 * dt;
            b.y += b.vy * dt;
            if (b.y < 0.6) {
              b.state = 'done';
              if (!b.tall) stats.smallOk++; else stats.wrong++;
            }
          }
        }
        boxes = boxes.filter((b) => {
          if (b.state === 'done') {
            b.ttl = (b.ttl ?? 2) - dt;
            if (b.ttl <= 0) { s.remove(b.mesh); return false; }
          }
          return true;
        });
        io.set('PE_Tall', pTall);
        io.set('PE_Pusher', pPush);
        io.set('PE_End', pEnd);
        io.set('Pusher_Home', ext < 0.02);
        io.set('Pusher_Out', ext > 0.98);
        sim._pe = [pTall, pPush, pEnd];
        sim._plateFront = plateFront;
      },
      render() {
        const pf = sim._plateFront ?? -2.2;
        plate.position.set(4, BELT_Y, pf - 0.5);
        rod.scale.y = Math.max(0.01, pf - 0.5 - -4.1);
        rod.position.set(4, BELT_Y + 0.8, (pf - 0.5 + -4.1) / 2);
        cleats.forEach((c, i) => { c.position.x = X0 + ((i * 2 + cleatOff) % (X1 - X0)); });
        for (const b of boxes) b.mesh.position.set(b.x, b.y, b.z);
        const [a, bb, c] = sim._pe || [];
        peTall.userData.set(a);
        pePush.userData.set(bb);
        peEnd.userData.set(c);
        lRun.userData.set(io.out('Lamp_Run'));
      },
      status() {
        return [
          ['Tall → chute', String(stats.tallOk)],
          ['Small → end bin', String(stats.smallOk)],
          ['Mis-sorted', stats.wrong ? `⚠ ${stats.wrong}` : '0'],
          ['Pusher stroke', `${(ext * 100).toFixed(0)} %`],
        ];
      },
    };
    return sim;
  },
};
