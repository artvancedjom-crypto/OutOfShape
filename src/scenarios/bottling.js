import { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, wireButton, controlDesk, onDesk, addScenery, photoEye, plastic, figure } from './common.js';

const SOLUTION = `PROGRAM BottlingLine
(* Indexing bottling machine: index -> fill & cap in parallel -> index.
   Filler and capper are exactly one bottle pitch apart. *)
VAR
  Step      : INT := 0;
  Running   : BOOL;
  FillDone  : BOOL;
  CapDone   : BOOL;
  CapTimer  : TON;
  Settle    : TON;
  ArriveEdge: R_TRIG;
  Bottles   : CTU;
  BatchSize : INT := 12;
END_VAR

Running := (Start OR Running) AND Stop AND NOT Bottles.Q;
IF Reset_Count THEN Running := FALSE; END_IF;
Bottles(CU := Step = 3 AND FillDone AND CapDone, R := Reset_Count, PV := BatchSize);

ArriveEdge(CLK := PE_Fill);

CASE Step OF
  0: (* idle *)
     Conveyor := FALSE; Fill_Valve := FALSE; Capper := FALSE;
     IF Running THEN Step := 1; END_IF;
  1: (* indexing: run belt until next bottle reaches the filler *)
     Conveyor := Running;
     IF ArriveEdge.Q THEN Conveyor := FALSE; Step := 2; END_IF;
     IF NOT Running THEN Step := 0; END_IF;
  2: (* let the bottle settle *)
     Settle(IN := TRUE, PT := T#300ms);
     IF Settle.Q THEN Settle(IN := FALSE); FillDone := FALSE; CapDone := NOT PE_Cap; Step := 3; END_IF;
  3: (* fill and cap in parallel *)
     Fill_Valve := PE_Fill AND NOT Level_Full AND NOT FillDone;
     IF Level_Full OR NOT PE_Fill THEN FillDone := TRUE; END_IF;
     CapTimer(IN := PE_Cap AND NOT CapDone, PT := SP_CapTime);
     Capper := PE_Cap AND NOT CapDone;
     IF CapTimer.Q THEN CapDone := TRUE; CapTimer(IN := FALSE); END_IF;
     IF FillDone AND CapDone THEN
       Fill_Valve := FALSE; Capper := FALSE; Step := 1;
       IF NOT Running THEN Step := 0; END_IF;
     END_IF;
END_CASE;

Lamp_Run := Running;
Lamp_Done := Bottles.Q;
END_PROGRAM
`;

const STARTER = `(* Bottling line exercise
   Index the conveyor until PE_Fill sees a bottle, then
   - open Fill_Valve until Level_Full,
   - meanwhile press the Capper for SP_CapTime if PE_Cap sees a bottle,
   then index again. Count bottles and stop after a batch. *)
VAR
  Running : BOOL;
END_VAR

Running := (Start OR Running) AND Stop;
Conveyor := Running AND NOT PE_Fill;
Lamp_Run := Running;
`;

export default {
  id: 'bottling',
  name: 'Bottling Line (Fill & Cap)',
  difficulty: 'Advanced',
  minutes: 35,
  icon: '🍾',
  summary: 'An indexing bottling machine: bottles stop under the filler and capper, which work in parallel. Sequence control with a step chain, timers, level sensing and batch counting.',
  objectives: [
    'Index the conveyor until a bottle reaches PE_Fill, then stop.',
    'Open Fill_Valve until Level_Full; never spill (the sim counts overfilled bottles).',
    'At the same time cap the bottle under PE_Cap for SP_CapTime.',
    'Only index again when both stations are finished. Never move while the capper is down!',
    'Count good bottles and stop after a batch (12); Reset_Count restarts.',
  ],
  io: {
    inputs: [
      { name: 'Start', addr: '%I0.0', desc: 'Start button', ui: 'momentary' },
      { name: 'Stop', addr: '%I0.1', desc: 'Stop button (NC)', ui: 'nc-momentary' },
      { name: 'Reset_Count', addr: '%I0.2', desc: 'Batch counter reset', ui: 'momentary' },
      { name: 'PE_Fill', addr: '%I0.3', desc: 'Bottle under filler', ui: 'sensor' },
      { name: 'PE_Cap', addr: '%I0.4', desc: 'Bottle under capper', ui: 'sensor' },
      { name: 'Level_Full', addr: '%I0.5', desc: 'Fill level sensor (bottle full)', ui: 'sensor' },
      { name: 'SP_CapTime', type: 'TIME', addr: '%MD30', desc: 'HMI setpoint: capping time', ui: 'setpoint' },
    ],
    outputs: [
      { name: 'Conveyor', addr: '%Q0.0' },
      { name: 'Fill_Valve', addr: '%Q0.1' },
      { name: 'Capper', addr: '%Q0.2', desc: 'Capper press down' },
      { name: 'Lamp_Run', addr: '%Q0.3' },
      { name: 'Lamp_Done', addr: '%Q0.4', desc: 'Batch complete' },
    ],
  },
  params: [
    { key: 'fillRate', label: 'Fill rate', min: 5, max: 60, step: 5, default: 25, unit: '%/s' },
    { key: 'capTime', label: 'Capping time (SP_CapTime)', min: 0.3, max: 3, step: 0.1, default: 1.0, unit: 's', input: 'SP_CapTime', scale: 1000 },
    { key: 'speed', label: 'Conveyor speed', min: 1, max: 8, step: 0.5, default: 4, unit: 'studs/s' },
  ],
  programs: { solution: { lang: 'ST', source: SOLUTION }, starter: { lang: 'ST', source: STARTER } },
  match: {
    keywords: [['bottle', 4], ['bottling', 5], ['filling', 3], ['filler', 3], ['capping', 4], ['capper', 4], ['cap', 1], ['indexing', 2], ['batch', 2], ['fill level', 2], ['sequence', 1], ['step chain', 2], ['grafcet', 2], ['sfc', 1]],
    params: [
      { key: 'capTime', re: /cap\w*[^.\d]{0,30}?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i },
    ],
  },

  build(world, io, params) {
    const s = world.scene;
    world.spawn = new THREE.Vector3(0, 0, 22);
    addScenery(world, [[-26, -24], [26, -24], [-26, 24], [27, 22]]);
    s.add(at(tile(48, 20, COLORS.white, 1), 0, 0, 0));
    const BY = 3.2;
    const PITCH = 6;
    const FILL_X = -3;
    const CAP_X = FILL_X + PITCH;
    const X0 = -21;
    const X1 = 19;
    const belt = tile(X1 - X0 + 2, 3, COLORS.dark, 1);
    belt.position.set((X0 + X1) / 2, BY - 0.4, 0);
    s.add(belt);
    world.addCollider(belt, 0.8);
    for (let x = X0; x <= X1; x += 5) {
      s.add(at(brick(1, 1, 7, COLORS.gray), x, 0.4, -1.8));
      s.add(at(brick(1, 1, 7, COLORS.gray), x, 0.4, 1.8));
    }
    const rollers = [];
    for (let x = X0; x <= X1; x += 1.5) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 2.8), plastic(COLORS.black));
      r.position.set(x, BY + 0.01, 0);
      s.add(r);
      rollers.push(r);
    }
    // filler station
    const filler = new THREE.Group();
    filler.position.set(FILL_X, 0.4, -4);
    filler.add(brick(2, 2, 27, COLORS.blue, { studs: false }));
    const arm = brick(2, 5, 3, COLORS.blue);
    arm.position.set(0, 10.4, 2.5);
    filler.add(arm);
    const hopper = new THREE.Mesh(new THREE.CylinderGeometry(2, 1, 3, 16), plastic(COLORS.azure, { transparent: true, opacity: 0.6 }));
    hopper.position.set(0, 13.4, 4);
    filler.add(hopper);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.15, 1.6, 10), plastic(COLORS.gray));
    nozzle.position.set(0, 9.8, 4);
    filler.add(nozzle);
    const flow = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 6), new THREE.MeshStandardMaterial({ color: 0xffa61e, transparent: true, opacity: 0.85 }));
    filler.add(flow);
    const fl = label('FILLER', { size: 0.6 });
    fl.position.set(0, 16, 4);
    filler.add(fl);
    s.add(filler);
    // capper station
    const capper = new THREE.Group();
    capper.position.set(CAP_X, 0.4, -4);
    capper.add(brick(2, 2, 27, COLORS.red, { studs: false }));
    const carm = brick(2, 5, 3, COLORS.red);
    carm.position.set(0, 10.4, 2.5);
    capper.add(carm);
    const head = brick(2, 2, 4, COLORS.yellow, { studs: false });
    capper.add(head);
    const cl = label('CAPPER', { size: 0.6 });
    cl.position.set(0, 13.4, 4);
    capper.add(cl);
    s.add(capper);
    // sensors
    const pe1 = photoEye(4.2);
    pe1.position.set(FILL_X, BY - 0.4, 0);
    s.add(pe1);
    const pe2 = photoEye(4.2);
    pe2.position.set(CAP_X, BY - 0.4, 0);
    s.add(pe2);
    // crate at end
    const crate = new THREE.Group();
    crate.add(at(brick(6, 1, 4, COLORS.yellow), 0, 0, -2.5), at(brick(6, 1, 4, COLORS.yellow), 0, 0, 2.5), at(brick(1, 4, 4, COLORS.yellow), -2.5, 0, 0), at(brick(1, 4, 4, COLORS.yellow), 2.5, 0, 0));
    crate.position.set(X1 + 4, 0.4, 0);
    s.add(crate);
    // desk
    const desk = controlDesk(12, 4, COLORS.gray);
    desk.position.set(-10, 0, 10);
    s.add(desk);
    world.addCollider(desk);
    const bStart = onDesk(desk, pushButton(0x1fbf3a), -4, 0, 'START');
    const bStop = onDesk(desk, pushButton(0xe02020), -1.5, 0, 'STOP');
    const bRes = onDesk(desk, pushButton(0x2266ff), 1, 0, 'RESET CNT');
    const lRun = onDesk(desk, lamp(0x22ff55), 3.4, -0.6, 'RUN');
    const lDone = onDesk(desk, lamp(0xffcc00), 5, -0.6, 'BATCH');
    wireButton(world, io, bStart, 'Start', 'momentary');
    wireButton(world, io, bStop, 'Stop', 'nc-momentary', 'STOP (NC)');
    wireButton(world, io, bRes, 'Reset_Count', 'momentary', 'Reset batch counter');
    const counter = label('Good: 0  Spilled: 0', { size: 0.8, bg: 'rgba(20,80,40,0.9)' });
    counter.position.set(0, 18, -4);
    s.add(counter);
    s.add(figure(-18, 9, COLORS.purple, 0.5));

    const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fe3b0, transparent: true, opacity: 0.35, roughness: 0.05, depthWrite: false });
    const liquidMat = new THREE.MeshStandardMaterial({ color: 0xffa61e, roughness: 0.2 });
    const mkBottle = () => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 3, 18), glassMat);
      body.position.y = 1.5;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.7, 1.2, 14), glassMat);
      neck.position.y = 3.6;
      const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1, 16), liquidMat);
      liquid.visible = false;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.35, 14), plastic(COLORS.red));
      cap.position.y = 4.35;
      cap.visible = false;
      g.add(body, neck, liquid, cap);
      g.userData = { liquid, cap };
      return g;
    };

    let bottles = [];
    let capperY = 0;
    let offset = 0;
    let good = 0;
    let spilled = 0;
    let crashed = 0;
    const sim = {
      reset() {
        for (const b of bottles) s.remove(b.mesh);
        bottles = [];
        good = spilled = crashed = 0;
        // pre-load bottles at pitch spacing so they align with stations
        for (let x = FILL_X - PITCH * 3 + 1.5; x < FILL_X - 0.5; x += PITCH) addBottle(x);
        io.set('Stop', true);
      },
      update(dt) {
        const v = io.out('Conveyor') ? params.speed : 0;
        const dx = v * dt;
        offset = (offset + dx) % 1.5;
        if (v > 0 && capperY > 0.15) crashed++;
        // keep an exact pitch so bottles line up with both stations
        const last = bottles.filter((b) => b.state === 'belt').reduce((m, b) => Math.min(m, b.x), Infinity);
        if (last === Infinity) addBottle(FILL_X - PITCH * 3);
        else if (last - PITCH >= X0) addBottle(last - PITCH);
        // capper motion
        capperY += ((io.out('Capper') ? 1 : 0) - capperY) * Math.min(1, dt * 10);
        let pf = false;
        let pc = false;
        let full = false;
        for (const b of bottles) {
          if (b.state === 'belt') {
            b.x += dx;
            if (b.x > X1 + 1) b.state = 'drop';
            if (Math.abs(b.x - FILL_X) < 0.6) {
              pf = true;
              if (io.out('Fill_Valve')) {
                b.level += params.fillRate * dt;
                if (b.level > 100) { b.spill = true; b.level = 100; }
              }
              if (b.level >= 92) full = true;
            }
            if (Math.abs(b.x - CAP_X) < 0.9) {
              pc = true;
              if (capperY > 0.85) { b.capT = (b.capT || 0) + dt; if (b.capT > 0.25) b.capped = true; }
            }
          } else if (b.state === 'drop') {
            b.x += 3 * dt;
            b.y -= 10 * dt;
            if (b.y < 0.6) {
              b.state = 'done';
              const ok = b.level >= 85 && b.capped && !b.spill;
              if (ok) good++;
              if (b.spill) spilled++;
              s.remove(b.mesh);
            }
          }
        }
        bottles = bottles.filter((b) => b.state !== 'done');
        io.set('PE_Fill', pf);
        io.set('PE_Cap', pc);
        io.set('Level_Full', full);
      },
      render() {
        rollers.forEach((r, i) => { r.position.x = X0 + ((i * 1.5 + offset) % (X1 - X0)); });
        for (const b of bottles) {
          b.mesh.position.set(b.x, b.y, 0);
          const L = b.mesh.userData.liquid;
          L.visible = b.level > 1;
          const h = (b.level / 100) * 2.9;
          L.scale.y = Math.max(0.01, h);
          L.position.y = 0.05 + h / 2;
          b.mesh.userData.cap.visible = !!b.capped;
        }
        head.position.set(0, 9.2 - capperY * 1.6 - 0.4, 4);
        flow.visible = !!io.out('Fill_Valve');
        flow.scale.y = 4.6;
        flow.position.set(0, 9 - 2.3, 4);
        pe1.userData.set(io.get('PE_Fill'));
        pe2.userData.set(io.get('PE_Cap'));
        lRun.userData.set(io.out('Lamp_Run'));
        lDone.userData.set(io.out('Lamp_Done'));
        counter.userData.setText(`Good: ${good}  Spilled: ${spilled}${crashed ? '  ⚠ capper hit!' : ''}`);
      },
      status() {
        return [
          ['Good bottles', String(good)],
          ['Spilled', spilled ? `⚠ ${spilled}` : '0'],
          ['Moved with capper down', crashed ? `⚠ ${crashed} scans` : '0'],
          ['Bottles on line', String(bottles.length)],
        ];
      },
    };
    function addBottle(x) {
      const mesh = mkBottle();
      s.add(mesh);
      bottles.push({ x, y: BY, level: 0, capped: false, mesh, state: 'belt' });
    }
    return sim;
  },
};
