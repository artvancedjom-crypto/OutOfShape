import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, addScenery, strip, figure } from './common.js';

const SOLUTION = `PROGRAM TrafficLights
(* Two-phase intersection with yellow & all-red clearance,
   car-actuated green extension, pedestrian request and night flash. *)
VAR
  State     : INT := 0;
  StepTimer : TON;      (* phase timer *)
  Flasher   : TON;      (* night-mode blink generator *)
  BlinkOn   : BOOL;
  PedLatch  : BOOL;     (* remembers a pedestrian request *)
  AllRed    : TIME := T#1500ms;
END_VAR

IF Ped_Button THEN PedLatch := TRUE; END_IF;

(* 1 Hz flasher *)
Flasher(IN := NOT Flasher.Q, PT := T#500ms);
IF Flasher.Q THEN BlinkOn := NOT BlinkOn; END_IF;

IF Night_Mode THEN
  State := 0;
  StepTimer(IN := FALSE);
  NS_Red := FALSE; NS_Green := FALSE;
  EW_Red := FALSE; EW_Green := FALSE;
  NS_Yellow := BlinkOn; EW_Yellow := BlinkOn;
  Walk := FALSE;
  RETURN;
END_IF;

CASE State OF
  0: (* North-South green *)
     StepTimer(IN := TRUE, PT := SP_Green);
     IF StepTimer.Q AND (Car_EW OR PedLatch OR NOT Car_NS) THEN
       State := 1; StepTimer(IN := FALSE);
     END_IF;
  1: (* North-South yellow *)
     StepTimer(IN := TRUE, PT := SP_Yellow);
     IF StepTimer.Q THEN State := 2; StepTimer(IN := FALSE); END_IF;
  2: (* all red *)
     StepTimer(IN := TRUE, PT := AllRed);
     IF StepTimer.Q THEN State := 3; StepTimer(IN := FALSE); END_IF;
  3: (* East-West green + pedestrians *)
     StepTimer(IN := TRUE, PT := SP_Green);
     IF StepTimer.Q AND (Car_NS OR NOT Car_EW) THEN
       State := 4; StepTimer(IN := FALSE); PedLatch := FALSE;
     END_IF;
  4: (* East-West yellow *)
     StepTimer(IN := TRUE, PT := SP_Yellow);
     IF StepTimer.Q THEN State := 5; StepTimer(IN := FALSE); END_IF;
  5: (* all red *)
     StepTimer(IN := TRUE, PT := AllRed);
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
`;

const STARTER = `(* Traffic light exercise
   Outputs: NS_Red/NS_Yellow/NS_Green, EW_Red/EW_Yellow/EW_Green, Walk
   Inputs : Car_NS, Car_EW (induction loops), Ped_Button, Night_Mode,
            SP_Green, SP_Yellow (HMI setpoints, TIME)
   Tip: build a CASE state machine and use one TON as step timer. *)
VAR
  State : INT;
  T : TON;
END_VAR

NS_Red := TRUE;
EW_Red := TRUE;
`;

// lane geometry -------------------------------------------------------------
const LANES = [
  { axis: 'NS', pos: (u) => [2.5, -u], dir: [0, -1] },
  { axis: 'NS', pos: (u) => [-2.5, u], dir: [0, 1], stop: -11.8 }, // stops before the zebra crossing
  { axis: 'EW', pos: (u) => [u, 2.5], dir: [1, 0] },
  { axis: 'EW', pos: (u) => [-u, -2.5], dir: [-1, 0] },
];
const STOP_DEFAULT = -6.2; // front bumper stop position
const START_U = -30;
const END_U = 31;
const CAR_LEN = 4;

function makeCar(color) {
  const g = new THREE.Group();
  const body = brick(2, 4, 2, color, { studs: false });
  body.position.y = 0.45;
  g.add(body);
  const cab = brick(2, 2, 3, COLORS.white, { studs: true });
  cab.position.set(0, 0.45 + 0.8, -0.3);
  g.add(cab);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 0.1), new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1 }));
  glass.position.set(0, 1.8, 0.72);
  g.add(glass);
  const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const wm = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
  for (const [x, z] of [[-1, 1.2], [1, 1.2], [-1, -1.2], [1, -1.2]]) {
    const w = new THREE.Mesh(wheelGeo, wm);
    w.position.set(x, 0.45, z);
    g.add(w);
  }
  return g;
}

function signalHead(facing) {
  // facing: rotation.y so that lamps look toward approaching cars
  const g = new THREE.Group();
  const pole = brick(1, 1, 18, COLORS.dark, { studs: false });
  g.add(pole);
  const head = brick(2, 1, 9, COLORS.black, { studs: false });
  head.position.set(0, 6.6, 0);
  g.add(head);
  const mk = (c, y) => {
    const l = lamp(c, { r: 0.42, h: 0.3 });
    l.rotation.x = Math.PI / 2;
    l.position.set(0, y, 0.55);
    g.add(l);
    return l;
  };
  const r = mk(0xff2020, 9.4);
  const y = mk(0xffb000, 8.3);
  const gr = mk(0x20ff60, 7.2);
  g.rotation.y = facing;
  return { group: g, r, y, g: gr };
}

export default {
  id: 'traffic',
  name: 'Traffic Light Intersection',
  difficulty: 'Intermediate',
  minutes: 25,
  icon: '🚦',
  summary: 'A four-way intersection with car-detection loops, a pedestrian push button and night-mode flashing. Program the phase sequence with timers and a state machine.',
  objectives: [
    'Never show green/yellow to North-South and East-West at the same time (the sim counts conflicts and crashes).',
    'Sequence: green → yellow → all-red → other direction, using SP_Green / SP_Yellow from the HMI.',
    'Extend green while nobody waits on the cross street (Car_NS / Car_EW induction loops).',
    'Latch Ped_Button and give Walk during the East-West green.',
    'Night_Mode: flash both yellows at 1 Hz.',
  ],
  io: {
    inputs: [
      { name: 'Car_NS', addr: '%I0.0', desc: 'Induction loop: car waiting on North-South', ui: 'sensor' },
      { name: 'Car_EW', addr: '%I0.1', desc: 'Induction loop: car waiting on East-West', ui: 'sensor' },
      { name: 'Ped_Button', addr: '%I0.2', desc: 'Pedestrian push button', ui: 'momentary' },
      { name: 'Night_Mode', addr: '%I0.3', desc: 'Night mode selector switch', ui: 'toggle' },
      { name: 'SP_Green', type: 'TIME', addr: '%MD10', desc: 'HMI setpoint: green time', ui: 'setpoint' },
      { name: 'SP_Yellow', type: 'TIME', addr: '%MD14', desc: 'HMI setpoint: yellow time', ui: 'setpoint' },
    ],
    outputs: [
      { name: 'NS_Red', addr: '%Q0.0' }, { name: 'NS_Yellow', addr: '%Q0.1' }, { name: 'NS_Green', addr: '%Q0.2' },
      { name: 'EW_Red', addr: '%Q0.3' }, { name: 'EW_Yellow', addr: '%Q0.4' }, { name: 'EW_Green', addr: '%Q0.5' },
      { name: 'Walk', addr: '%Q0.6', desc: 'Pedestrian walk signal' },
    ],
  },
  params: [
    { key: 'green', label: 'Green time (SP_Green)', min: 3, max: 30, step: 1, default: 8, unit: 's', input: 'SP_Green', scale: 1000 },
    { key: 'yellow', label: 'Yellow time (SP_Yellow)', min: 1, max: 6, step: 0.5, default: 3, unit: 's', input: 'SP_Yellow', scale: 1000 },
    { key: 'densityNS', label: 'Traffic North-South', min: 0, max: 30, step: 1, default: 10, unit: 'cars/min' },
    { key: 'densityEW', label: 'Traffic East-West', min: 0, max: 30, step: 1, default: 8, unit: 'cars/min' },
  ],
  programs: { solution: { lang: 'ST', source: SOLUTION }, starter: { lang: 'ST', source: STARTER } },
  match: {
    keywords: [['traffic light', 5], ['traffic signal', 5], ['intersection', 3], ['junction', 2], ['pedestrian', 2], ['crosswalk', 2], ['amber', 2], ['yellow', 1], ['red', 0.5], ['green', 0.5], ['phase', 1], ['night mode', 2], ['flashing', 1], ['vehicle detection', 2], ['induction loop', 3], ['crossing', 1]],
    params: [
      { key: 'green', re: /green[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
      { key: 'yellow', re: /(?:yellow|amber)[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
    ],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(10, 0, 18);
    // roads
    s.add(at(strip(64, 10, COLORS.road), 0, 0, 0));
    s.add(at(strip(10, 64, COLORS.road), 0, 0, 0));
    const dash = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    for (let u = -30; u <= 30; u += 4) {
      if (Math.abs(u) < 7) continue;
      const a = new THREE.Mesh(new THREE.BoxGeometry(2, 0.1, 0.3), dash);
      a.position.set(u, 0.06, 0);
      const b = a.clone();
      b.rotation.y = Math.PI / 2;
      b.position.set(0, 0.06, u);
      s.add(a, b);
    }
    // stop lines
    for (const [x, z, w, d] of [[2.5, 6, 5, 0.5], [-2.5, -11.6, 5, 0.5], [-6, 2.5, 0.5, 5], [6, -2.5, 0.5, 5]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), dash);
      m.position.set(x, 0.07, z);
      s.add(m);
    }
    // zebra crossing on the north arm (across the NS road)
    for (let i = -4; i <= 4; i += 1.6) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 3), dash);
      m.position.set(i, 0.07, -9.5);
      s.add(m);
    }
    // sidewalks / corner blocks
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const blk = tile(26, 26, COLORS.tan, 1);
      blk.position.set(x * 19, 0, z * 19);
      s.add(blk);
    }
    // buildings
    const bcol = [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.white];
    [[-20, -20], [20, -22], [-22, 20], [22, 20]].forEach(([x, z], i) => {
      const b = brick(10, 10, 18 + i * 3, bcol[i]);
      b.position.set(x, 0.4, z);
      s.add(b);
      world.addCollider(b);
      for (let k = 0; k < 3; k++) {
        const w = tile(6, 0.4, 0x88ccff, 2);
        w.position.set(x, 2 + k * 2.2, z + (z > 0 ? -5.1 : 5.1));
        s.add(w);
      }
    });
    addScenery(world, [[-10, -27], [12, 28], [28, -10], [-28, 10]]);

    // signal heads: one per approach
    const heads = [
      { ...signalHead(0), axis: 'NS', p: [6.5, 8.5] }, // for lane 0 (coming from +z)
      { ...signalHead(Math.PI), axis: 'NS', p: [-6.5, -8.5] },
      { ...signalHead(-Math.PI / 2), axis: 'EW', p: [-8.5, 6.5] },
      { ...signalHead(Math.PI / 2), axis: 'EW', p: [8.5, -6.5] },
    ];
    for (const h of heads) {
      h.group.position.set(h.p[0], 0.4, h.p[1]);
      s.add(h.group);
    }
    // ped button + walk signal on the NE corner of the crosswalk
    const pb = pushButton(0xffd500, { housing: COLORS.dark });
    pb.position.set(7, 3.6, -11);
    const pbPole = brick(1, 1, 9, COLORS.dark, { studs: false });
    pbPole.position.set(7, 0.4, -11);
    s.add(pbPole, pb);
    const pbl = label('PUSH TO CROSS', { size: 0.5 });
    pbl.position.set(7, 5.8, -11);
    s.add(pbl);
    wireButton(world, io, pb, 'Ped_Button', 'momentary', 'Pedestrian button');
    const walk = lamp(0xffffff, { r: 0.5, h: 0.3 });
    walk.rotation.x = Math.PI / 2;
    walk.rotation.z = Math.PI / 2;
    walk.position.set(7, 5, -11);
    s.add(walk);
    // night mode switch box
    const nbox = brick(2, 2, 6, COLORS.gray);
    nbox.position.set(-9, 0.4, 9);
    s.add(nbox);
    const nsw = pushButton(0x3355ff);
    nsw.position.set(-9, 2.8, 9);
    s.add(nsw);
    const nl = label('NIGHT MODE', { size: 0.5 });
    nl.position.set(-9, 4.8, 9);
    s.add(nl);
    wireButton(world, io, nsw, 'Night_Mode', 'toggle', 'Night mode switch (toggle)');

    // dynamic objects
    const cars = [[], [], [], []];
    const carColors = [COLORS.red, COLORS.blue, COLORS.yellow, COLORS.lime, COLORS.orange, COLORS.azure, COLORS.white, COLORS.pink];
    const spawnT = [0, 0, 0, 0];
    let passed = 0;
    let crashes = 0;
    let conflicts = 0;
    let conflictActive = false;
    let peds = [];
    let crossed = 0;
    let flash = 0;

    const light = (axis) => {
      const p = axis === 'NS' ? 'NS_' : 'EW_';
      return { r: io.out(p + 'Red'), y: io.out(p + 'Yellow'), g: io.out(p + 'Green') };
    };

    function spawnCar(li) {
      const lane = cars[li];
      if (lane.length && lane[lane.length - 1].u < START_U + CAR_LEN + 2) return;
      const mesh = makeCar(carColors[(Math.random() * carColors.length) | 0]);
      const [dx, dz] = LANES[li].dir;
      mesh.rotation.y = Math.atan2(dx, dz);
      s.add(mesh);
      lane.push({ u: START_U, v: 7, mesh, crossedRed: false });
    }

    const sim = {
      reset() {
        for (const lane of cars) { for (const c of lane) s.remove(c.mesh); lane.length = 0; }
        for (const p of peds) s.remove(p.mesh);
        peds = [];
        passed = crashes = conflicts = crossed = 0;
        io.set('Ped_Button', false);
        io.set('Night_Mode', false);
        nsw.userData.press(false);
      },
      update(dt) {
        // spawning
        LANES.forEach((ln, li) => {
          const rate = (ln.axis === 'NS' ? params.densityNS : params.densityEW) / 60 / 2;
          spawnT[li] -= dt;
          if (rate > 0 && spawnT[li] <= 0) {
            spawnCar(li);
            spawnT[li] = -Math.log(1 - Math.random()) / rate + 0.8;
          }
        });
        const waiting = { NS: false, EW: false };
        LANES.forEach((ln, li) => {
          const lane = cars[li];
          const L = light(ln.axis);
          const STOP_U = ln.stop ?? STOP_DEFAULT;
          for (let i = 0; i < lane.length; i++) {
            const c = lane[i];
            const front = c.u + CAR_LEN / 2;
            let limit = Infinity;
            if (i > 0) limit = lane[i - 1].u - CAR_LEN - 1.6;
            const beforeLine = front <= STOP_U + 0.05;
            const mayGo = L.g || (L.y && front > STOP_U - 2.5 && c.v > 3);
            if (beforeLine && !mayGo) limit = Math.min(limit, STOP_U - CAR_LEN / 2);
            const desired = Math.min(9, Math.sqrt(Math.max(0, 2 * 14 * (limit - c.u - 0.05))));
            if (desired > c.v) c.v = Math.min(desired, c.v + 7 * dt);
            else c.v = desired;
            const prevFront = front;
            c.u = Math.min(c.u + c.v * dt, limit);
            const nf = c.u + CAR_LEN / 2;
            if (prevFront <= STOP_U && nf > STOP_U && L.r && !L.g && !L.y) c.crossedRed = true;
            if (beforeLine && front > STOP_U - 12 && c.v < 1.5) waiting[ln.axis] = true;
          }
          // remove cars leaving
          while (lane.length && lane[0].u > END_U) {
            s.remove(lane[0].mesh);
            lane.shift();
            passed++;
          }
        });
        io.set('Car_NS', waiting.NS);
        io.set('Car_EW', waiting.EW);

        // signal conflict monitor
        const ns = light('NS');
        const ew = light('EW');
        const conflict = (ns.g || ns.y) && (ew.g || ew.y);
        if (conflict && !conflictActive) conflicts++;
        conflictActive = conflict;

        // collision detection in the box
        const inBox = [];
        LANES.forEach((ln, li) => {
          for (const c of cars[li]) {
            if (c.crashed) continue;
            const [x, z] = ln.pos(c.u);
            if (Math.abs(x) < 6 && Math.abs(z) < 6) inBox.push({ c, x, z, axis: ln.axis });
          }
        });
        for (let i = 0; i < inBox.length; i++) {
          for (let j = i + 1; j < inBox.length; j++) {
            const a = inBox[i];
            const b = inBox[j];
            if (a.axis !== b.axis && Math.hypot(a.x - b.x, a.z - b.z) < 2.6) {
              crashes++;
              a.c.crashed = b.c.crashed = true;
            }
          }
        }

        // pedestrians
        if (io.get('Ped_Button') && peds.filter((p) => p.state === 'wait').length < 3) {
          if (!peds.some((p) => p.state === 'wait' && p.fresh > 0)) {
            const m = figure(7.5, -10 + (Math.random() - 0.5) * 1.5, carColors[(Math.random() * 8) | 0], -Math.PI / 2);
            s.add(m);
            peds.push({ mesh: m, state: 'wait', fresh: 1.0 });
          }
        }
        for (const p of peds) {
          p.fresh -= dt;
          if (p.state === 'wait' && io.out('Walk')) p.state = 'walk';
          if (p.state === 'walk') {
            p.mesh.position.x -= 3.2 * dt;
            p.mesh.position.y = Math.abs(Math.sin(p.mesh.position.x * 3)) * 0.2;
            if (p.mesh.position.x < -9) { p.state = 'done'; crossed++; }
          }
        }
        peds = peds.filter((p) => {
          if (p.state === 'done') { s.remove(p.mesh); return false; }
          return true;
        });
      },
      render(dt) {
        flash += dt;
        LANES.forEach((ln, li) => {
          for (const c of cars[li]) {
            const [x, z] = ln.pos(c.u);
            c.mesh.position.set(x, 0, z);
            if (c.crashed) c.mesh.rotation.z = 0.25;
          }
        });
        for (const h of heads) {
          const L = light(h.axis);
          h.r.userData.set(L.r);
          h.y.userData.set(L.y);
          h.g.userData.set(L.g);
        }
        walk.userData.set(io.out('Walk'));
      },
      status() {
        return [
          ['Cars through', String(passed)],
          ['Signal conflicts', conflicts ? `⚠ ${conflicts}` : '0'],
          ['Crashes', crashes ? `💥 ${crashes}` : '0'],
          ['Waiting NS / EW', `${cars[0].concat(cars[1]).filter((c) => c.v < 1).length} / ${cars[2].concat(cars[3]).filter((c) => c.v < 1).length}`],
          ['Pedestrians crossed', String(crossed)],
        ];
      },
    };
    return sim;
  },
};
