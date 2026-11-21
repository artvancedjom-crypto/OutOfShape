// Kit elements for the PLC construction kit: what each element IS (parameters,
// I/O points) and how it BEHAVES (act / sense). No 3D code in here: the look of
// each element lives in meshes.js, so the behaviour can be unit-tested in Node.
//
// Coordinates: studs on the baseplate. An element sits at (x, z) with rotation
// rot (0..3, quarter turns); its local +x axis is "forward". y is the height of
// its base in studs (0 = on the plate, more when stacked on bricks).
//
// I/O direction is seen from the PLC: 'in' = sensor/operator → PLC input (%I, %IW),
// 'out' = PLC output (%Q, %QW) → actuator. Analog values use the 0..27648 raw range.
export const RAW = 27648;
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const ITEM_COLORS = { red: 0xd01712, blue: 0x0055bf, green: 0x237841, yellow: 0xf2cd37, white: 0xf4f4f4, orange: 0xfe8a18 };
const COLOR_NAMES = Object.keys(ITEM_COLORS);

const B = (key, dir, label, suffix = '') => ({ key, dir, type: 'BOOL', label, suffix });
const A = (key, dir, label, suffix = '') => ({ key, dir, type: 'INT', label, suffix });
const num = (key, label, def, min, max, unit = '', step) => ({ key, label, def, min, max, unit, step });
const sel = (key, label, options, def) => ({ key, label, type: 'select', options, def: def ?? options[0] });
const bool = (key, label, def = false) => ({ key, label, type: 'bool', def });
const signal = sel('signal', 'Signal', ['4-20 mA', '0-10 V']);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/** Mechanical travel 0..1 toward a target with a stroke time; respects "jammed" and "slow" faults. */
function travel(W, el, pos, target, time, dt) {
  if (W.jammed(el)) return pos;
  const d = (dt / Math.max(0.05, time)) * W.rate(el);
  return target > pos ? Math.min(target, pos + d) : Math.max(target, pos - d);
}

const analogIn = (W, el, key, value, lo, hi) => W.in(el, key, Math.round(clamp((value - lo) / (hi - lo), 0, 1) * RAW));

/** @type {Record<string, any>} */
export const KIT = {
  // ================================================================= material flow
  conveyor: {
    name: 'Conveyor belt', cat: 'Actuators', tag: 'Conv', h: 1,
    size: (el) => [el.params.length, 2],
    params: [num('length', 'Length', 6, 2, 16, 'studs', 1), num('speed', 'Speed', 3, 0.5, 10, 'studs/s', 0.5), sel('control', 'Speed control', ['fixed', 'analog (%QW)']), bool('reversible', 'Reverse output')],
    io: (el) => [B('run', 'out', 'Belt motor', '_Run'), ...(el.params.reversible ? [B('rev', 'out', 'Reverse', '_Rev')] : []), ...(el.params.control !== 'fixed' ? [A('spd', 'out', 'Speed setpoint 0..27648', '_Speed')] : [])],
    init: () => ({ v: 0, dist: 0 }),
    act(el, st, W, dt) {
      let target = W.out(el, 'run') ? el.params.speed : 0;
      if (el.params.control !== 'fixed') target *= clamp((W.out(el, 'spd') || 0) / RAW, 0, 1);
      if (el.params.reversible && W.out(el, 'rev')) target = -target;
      if (W.jammed(el)) target = 0;
      target *= W.rate(el);
      st.v += clamp(target - st.v, -30 * dt, 30 * dt);
      st.dist += st.v * dt;
      const [fx, fz] = W.fwd(el);
      W.carrier(el, st.v * fx, st.v * fz);
    },
    status: (el, st) => `${st.v.toFixed(1)} studs/s`,
  },
  road: {
    name: 'Road (vehicles drive by themselves)', cat: 'Material flow', tag: 'Road', h: 0.1,
    size: (el) => [el.params.length, 3],
    params: [num('length', 'Length', 8, 2, 30, 'studs', 1), num('speed', 'Vehicle speed', 6, 1, 12, 'studs/s', 0.5)],
    io: () => [],
    init: () => ({}),
    act(el, st, W) { const [fx, fz] = W.fwd(el); W.carrier(el, el.params.speed * fx, el.params.speed * fz); },
  },
  crossing: {
    name: 'Road crossing', cat: 'Material flow', tag: 'Cross', h: 0.1, size: () => [3, 3],
    params: [], io: () => [], init: () => ({}),
    act(el, st, W) { W.carrier(el, 0, 0, true); }, // vehicles keep their heading
  },
  spawner: {
    name: 'Workpiece source', cat: 'Material flow', tag: 'Src', h: 3, size: () => [2, 2],
    params: [num('cycle', 'Cycle time', 4, 0.5, 60, 's', 0.5), sel('kind', 'Produces', ['box', 'bottle', 'car']), sel('size', 'Size', ['small', 'large', 'mixed']), sel('material', 'Material', ['plastic', 'metal', 'mixed']),
      sel('color', 'Colour', [...COLOR_NAMES, 'mixed'], 'mixed'), bool('enableInput', 'Controlled by a PLC output'), bool('random', 'Irregular timing')],
    io: (el) => (el.params.enableInput ? [B('enable', 'out', 'Release workpieces', '_On')] : []),
    init: () => ({ t: 1, made: 0 }),
    act(el, st, W, dt) {
      if (el.params.enableInput && !W.out(el, 'enable')) return;
      if (W.jammed(el)) return;
      st.t -= dt * W.rate(el);
      if (st.t > 0) return;
      const p = el.params;
      const kind = p.kind;
      const size = p.size === 'mixed' ? pick(['small', 'large']) : p.size;
      const material = kind === 'car' ? 'metal' : p.material === 'mixed' ? pick(['plastic', 'metal']) : p.material;
      const color = p.color === 'mixed' ? pick(COLOR_NAMES) : p.color;
      const dims = kind === 'car' ? [3, 1.8, 1.3] : kind === 'bottle' ? [1.1, 1.1, 2.2] : size === 'large' ? [1.6, 1.6, 2] : [1.4, 1.4, 1];
      const r = W.front(el, 0.2, dims[0], dims[1]);
      if (W.itemsIn({ x1: r.x1 - 0.3, z1: r.z1 - 0.3, x2: r.x2 + 0.3, z2: r.z2 + 0.3 }, null).length) return; // outlet still occupied
      const [fx, fz] = W.fwd(el);
      W.spawn({ x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2, len: dims[0], wid: dims[1], h: dims[2], kind, size, material, color, hx: fx, hz: fz,
        mass: (kind === 'car' ? 900 : size === 'large' ? 250 : 100) * (material === 'metal' && kind !== 'car' ? 3 : 1), fill: 0, capped: false });
      st.made++;
      st.t = p.cycle * (p.random ? 0.5 + Math.random() : 1);
    },
    status: (el, st) => `${st.made} produced`,
  },
  sink: {
    name: 'Bin / exit (removes workpieces)', cat: 'Material flow', tag: 'Bin', h: 1.2, size: () => [3, 3],
    params: [sel('expects', 'Counts as correct', ['anything', 'small', 'large', 'metal', 'plastic', 'filled + capped', ...COLOR_NAMES])],
    io: () => [], init: () => ({ n: 0, ok: 0, wrong: 0 }),
    act(el, st, W) {
      for (const it of W.itemsIn(W.rect(el), null)) {
        const cx = it.x; const cz = it.z; const r = W.rect(el);
        if (cx < r.x1 || cx > r.x2 || cz < r.z1 || cz > r.z2) continue;
        const e = el.params.expects;
        const good = e === 'anything' || it.size === e || it.material === e || it.color === e || (e === 'filled + capped' && it.fill >= 85 && it.capped && !it.spilled);
        st.n++;
        if (good) st.ok++; else st.wrong++;
        W.remove(it);
      }
    },
    status: (el, st) => (el.params.expects === 'anything' ? `${st.n} received` : `${st.ok} correct, ${st.wrong} wrong`),
  },
  tank: {
    name: 'Tank', cat: 'Material flow', tag: 'Tank', h: 6, size: () => [4, 4],
    params: [num('capacity', 'Capacity', 1000, 50, 20000, 'L', 50), num('initial', 'Start level', 20, 0, 100, '%', 5), num('height', 'Liquid height when full', 2, 0.2, 10, 'm', 0.1)],
    io: () => [], isTank: true,
    init: (el) => ({ vol: (el.params.capacity * el.params.initial) / 100, temp: 20, mix: 0, overflow: 0, qin: 0, qout: 0 }),
    act(el, st, W, dt) {
      st.temp += (20 - st.temp) * 0.004 * dt; // slow cooling toward ambient
      st.mix = Math.max(0, st.mix - 2 * dt);
      st.qin = 0; st.qout = 0;
    },
    status: (el, st) => `${((st.vol / el.params.capacity) * 100).toFixed(1)} % (${st.vol.toFixed(0)} L), ${st.temp.toFixed(1)} °C${st.overflow > 0.5 ? `, overflowed ${st.overflow.toFixed(0)} L` : ''}`,
  },
  reservoir: {
    name: 'Reservoir (never empty)', cat: 'Material flow', tag: 'Res', h: 1.2, size: () => [4, 4],
    params: [], io: () => [], isTank: true, infinite: true,
    init: () => ({ vol: 1e12, temp: 15, mix: 0, overflow: 0, qin: 0, qout: 0 }),
    act() {},
  },
  drain: {
    name: 'Drain / consumer', cat: 'Material flow', tag: 'Drain', h: 0.8, size: () => [2, 2],
    params: [], io: () => [], isTank: true, infinite: true, isDrain: true,
    init: () => ({ vol: 0, temp: 20, mix: 0, overflow: 0, qin: 0, qout: 0, total: 0 }),
    act() {},
    status: (el, st) => `${st.total.toFixed(0)} L delivered`,
  },
  pipe: {
    name: 'Pipe', cat: 'Material flow', tag: 'Pipe', h: 1, size: (el) => [el.params.length, 1],
    params: [num('length', 'Length', 3, 1, 20, 'studs', 1)], io: () => [], init: () => ({ flow: 0 }),
    ends: (el) => [[el.params.length / 2, 0], [-el.params.length / 2, 0]], act(el, st) { st.flow *= 0.5; },
  },
  elbow: {
    name: 'Pipe elbow', cat: 'Material flow', tag: 'Elb', h: 1, size: () => [1, 1],
    params: [], io: () => [], init: () => ({ flow: 0 }), ends: () => [[0.5, 0], [0, 0.5]], act(el, st) { st.flow *= 0.5; },
  },

  // ================================================================= actuators
  motor: {
    name: 'Motor', cat: 'Actuators', tag: 'Mot', h: 3, size: () => [3, 3],
    params: [num('load', 'Mechanical load', 60, 0, 150, '%', 5), num('trip', 'Overload trip temperature', 100, 60, 140, '°C', 5)],
    io: () => [B('run', 'out', 'Contactor', '_Run'), B('ok', 'in', 'Thermal contact (TRUE = OK)', '_OK')],
    init: () => ({ speed: 0, temp: 20, tripped: false, angle: 0 }),
    act(el, st, W, dt) {
      const run = W.out(el, 'run') && !W.jammed(el);
      const acc = (run ? 1.4 / (0.6 + el.params.load / 100) : 0.7) * W.rate(el);
      st.speed += clamp((run ? 1 : 0) - st.speed, -acc * dt, acc * dt);
      const stalled = W.out(el, 'run') && W.jammed(el);
      st.temp += ((W.out(el, 'run') ? (el.params.load / 100) ** 2 * 18 * (stalled ? 4 : 1) : 0) - (st.temp - 20) * 0.08) * dt;
      if (st.temp >= el.params.trip) st.tripped = true;
      else if (st.tripped && st.temp < el.params.trip * 0.6) st.tripped = false; // automatic reset when cooled
      st.angle += st.speed * dt * 18;
    },
    sense(el, st, W) { W.in(el, 'ok', !st.tripped); },
    status: (el, st) => `${(st.speed * 1450).toFixed(0)} rpm, ${st.temp.toFixed(0)} °C${st.tripped ? ', OVERLOAD' : ''}`,
  },
  pump: {
    name: 'Pump', cat: 'Actuators', tag: 'Pump', h: 2.4, size: () => [2, 1],
    params: [num('rate', 'Flow rate', 60, 1, 500, 'L/s', 1)],
    io: () => [B('run', 'out', 'Pump motor', '_Run')], init: () => ({ q: 0, angle: 0 }),
    ends: () => [[1, 0], [-1, 0]], // outlet in front, inlet behind
    act(el, st, W, dt) {
      st.q = W.out(el, 'run') && !W.jammed(el) ? W.flow(el, el.params.rate * W.rate(el), dt, false) : 0;
      st.angle += (st.q > 0 ? 20 : W.out(el, 'run') ? 6 : 0) * dt;
    },
    status: (el, st) => `${st.q.toFixed(0)} L/s`,
  },
  valve: {
    name: 'Valve', cat: 'Actuators', tag: 'Valve', h: 1.6, size: () => [2, 1],
    params: [num('rate', 'Flow when the tank is full', 35, 1, 500, 'L/s', 1), num('time', 'Travel time', 0.5, 0.1, 10, 's', 0.1)],
    io: () => [B('open', 'out', 'Open', '_Open')], init: () => ({ pos: 0, q: 0 }),
    ends: () => [[1, 0], [-1, 0]],
    act(el, st, W, dt) {
      st.pos = travel(W, el, st.pos, W.out(el, 'open') ? 1 : 0, el.params.time, dt);
      st.q = st.pos > 0.02 ? W.flow(el, el.params.rate * st.pos, dt, true) : 0;
    },
    status: (el, st) => `${(st.pos * 100).toFixed(0)} % open, ${st.q.toFixed(1)} L/s`,
  },
  cylinder1: {
    name: 'Cylinder, single-acting (spring return)', cat: 'Actuators', tag: 'Cyl', h: 2, size: () => [2, 2],
    params: [num('stroke', 'Stroke', 3, 1, 8, 'studs', 0.5), num('time', 'Stroke time', 0.6, 0.1, 5, 's', 0.1)],
    io: () => [B('extend', 'out', 'Extend valve', '_Ext'), B('home', 'in', 'Retracted', '_Home'), B('out', 'in', 'Extended', '_Out')],
    init: () => ({ pos: 0 }),
    act(el, st, W, dt) { st.pos = travel(W, el, st.pos, W.out(el, 'extend') ? 1 : 0, el.params.time, dt); W.push(el, st.pos * el.params.stroke); },
    sense(el, st, W) { W.in(el, 'home', st.pos < 0.02); W.in(el, 'out', st.pos > 0.98); },
    status: (el, st) => `${(st.pos * 100).toFixed(0)} % extended`,
  },
  cylinder2: {
    name: 'Cylinder, double-acting', cat: 'Actuators', tag: 'Cyl', h: 2, size: () => [2, 2],
    params: [num('stroke', 'Stroke', 3, 1, 8, 'studs', 0.5), num('time', 'Stroke time', 0.6, 0.1, 5, 's', 0.1)],
    io: () => [B('extend', 'out', 'Extend valve', '_Ext'), B('retract', 'out', 'Retract valve', '_Ret'), B('home', 'in', 'Retracted', '_Home'), B('out', 'in', 'Extended', '_Out')],
    init: () => ({ pos: 0 }),
    act(el, st, W, dt) {
      const e = W.out(el, 'extend'); const r = W.out(el, 'retract');
      if (e !== r) st.pos = travel(W, el, st.pos, e ? 1 : 0, el.params.time, dt); // both or neither: holds position
      W.push(el, st.pos * el.params.stroke);
    },
    sense(el, st, W) { W.in(el, 'home', st.pos < 0.02); W.in(el, 'out', st.pos > 0.98); },
    status: (el, st) => `${(st.pos * 100).toFixed(0)} % extended`,
  },
  gate: {
    name: 'Gate / barrier', cat: 'Actuators', tag: 'Gate', h: 2.4, size: () => [1, 1],
    params: [num('reach', 'Arm length', 3, 1, 8, 'studs', 0.5), num('time', 'Travel time', 0.8, 0.1, 10, 's', 0.1)],
    io: () => [B('open', 'out', 'Open', '_Open'), B('opened', 'in', 'Fully open', '_IsOpen'), B('closed', 'in', 'Fully closed', '_IsClosed')],
    init: () => ({ pos: 0 }),
    act(el, st, W, dt) {
      st.pos = travel(W, el, st.pos, W.out(el, 'open') ? 1 : 0, el.params.time, dt);
      if (st.pos < 0.9) W.blocker(W.front(el, 0, el.params.reach, 0.3), el);
    },
    sense(el, st, W) { W.in(el, 'opened', st.pos > 0.98); W.in(el, 'closed', st.pos < 0.02); },
    status: (el, st) => (st.pos > 0.98 ? 'open' : st.pos < 0.02 ? 'closed' : 'moving'),
  },
  lamp: {
    name: 'Indicator light', cat: 'Actuators', tag: 'Lamp', h: 2, size: () => [1, 1],
    params: [sel('color', 'Colour', ['green', 'red', 'yellow', 'blue', 'white', 'orange'])],
    io: () => [B('on', 'out', 'Lamp')], init: () => ({ on: false }),
    act(el, st, W) { st.on = !!W.out(el, 'on') && !W.jammed(el); },
    status: (el, st) => (st.on ? 'on' : 'off'),
  },
  horn: {
    name: 'Horn', cat: 'Actuators', tag: 'Horn', h: 2, size: () => [1, 1],
    params: [], io: () => [B('on', 'out', 'Horn')], init: () => ({ on: false, t: 0 }),
    act(el, st, W, dt) { st.on = !!W.out(el, 'on') && !W.jammed(el); st.t = st.on ? st.t + dt : 0; },
    status: (el, st) => (st.on ? 'sounding' : 'silent'),
  },
  trafficlight: {
    name: 'Traffic light', cat: 'Actuators', tag: 'TL', h: 6, size: () => [1, 1],
    params: [num('reach', 'Stop line width', 4, 1, 10, 'studs', 0.5)],
    io: () => [B('red', 'out', 'Red', '_Red'), B('yellow', 'out', 'Yellow', '_Yellow'), B('green', 'out', 'Green', '_Green')],
    init: () => ({ r: false, y: false, g: false }),
    act(el, st, W) {
      st.r = !!W.out(el, 'red'); st.y = !!W.out(el, 'yellow'); st.g = !!W.out(el, 'green');
      // the stop line lies across the lane to the right of the post; vehicles wait unless it shows green only
      if (!(st.g && !st.r)) W.blocker(W.side(el, 0.5, el.params.reach, 0.4), el, 'car');
    },
    status: (el, st) => [st.r && 'red', st.y && 'yellow', st.g && 'green'].filter(Boolean).join(' + ') || 'dark',
  },
  elevator: {
    name: 'Elevator (car with shaft)', cat: 'Actuators', tag: 'Lift', size: () => [4, 4],
    h: (el) => el.params.floors * el.params.floorHeight + 1,
    params: [num('floors', 'Floors', 3, 2, 5, '', 1), num('floorHeight', 'Floor height', 5, 3, 10, 'studs', 0.5), num('speed', 'Car speed', 2.5, 0.5, 8, 'studs/s', 0.5), num('doorTime', 'Door travel time', 1, 0.2, 5, 's', 0.1)],
    io: (el) => [B('up', 'out', 'Motor up', '_Up'), B('down', 'out', 'Motor down', '_Down'), B('door', 'out', 'Open door', '_Door'),
      ...Array.from({ length: el.params.floors }, (_, k) => B(`floor${k + 1}`, 'in', `Car at floor ${k + 1}`, `_F${k + 1}`)),
      B('doorClosed', 'in', 'Door closed', '_DoorClosed'), B('doorOpen', 'in', 'Door open', '_DoorOpen'), B('limTop', 'in', 'Overtravel top', '_LimTop'), B('limBottom', 'in', 'Overtravel bottom', '_LimBot')],
    init: () => ({ pos: 0, door: 0, stops: 0, violations: 0, overtravel: 0, moving: false }),
    act(el, st, W, dt) {
      const p = el.params;
      const top = (p.floors - 1) * p.floorHeight;
      const dir = W.jammed(el) ? 0 : (W.out(el, 'up') ? 1 : 0) - (W.out(el, 'down') ? 1 : 0);
      if (dir !== 0 && st.door > 0.02) st.violations++;
      st.pos += dir * p.speed * W.rate(el) * dt;
      if (st.pos > top + 0.6) { st.pos = top + 0.6; st.overtravel++; }
      if (st.pos < -0.6) { st.pos = -0.6; st.overtravel++; }
      if (st.moving && dir === 0) st.stops++;
      st.moving = dir !== 0;
      st.door = travel(W, el, st.door, W.out(el, 'door') ? 1 : 0, p.doorTime, dt);
    },
    sense(el, st, W) {
      const p = el.params;
      for (let k = 0; k < p.floors; k++) W.in(el, `floor${k + 1}`, Math.abs(st.pos - k * p.floorHeight) < 0.12);
      W.in(el, 'doorClosed', st.door < 0.01); W.in(el, 'doorOpen', st.door > 0.99);
      W.in(el, 'limTop', st.pos > (p.floors - 1) * p.floorHeight + 0.4); W.in(el, 'limBottom', st.pos < -0.4);
    },
    status: (el, st) => `floor ${(st.pos / el.params.floorHeight + 1).toFixed(2)}, door ${st.door < 0.01 ? 'closed' : st.door > 0.99 ? 'open' : 'moving'}${st.violations ? `, moved with open door ×${st.violations}` : ''}`,
  },
  mixer: {
    name: 'Mixer (next to a tank)', cat: 'Actuators', tag: 'Mix', h: 7, size: () => [1, 1],
    params: [], io: () => [B('run', 'out', 'Mixer motor', '_Run')], init: () => ({ angle: 0, on: false }),
    act(el, st, W, dt) {
      st.on = !!W.out(el, 'run') && !W.jammed(el);
      const t = W.tankNear(el);
      if (st.on) { st.angle += 9 * dt * W.rate(el); if (t && t.st.vol > 1) t.st.mix = Math.min(100, t.st.mix + 12 * dt * W.rate(el)); }
    },
    status: (el, st, W) => { const t = W.tankNear(el); return t ? `mixed ${t.st.mix.toFixed(0)} %` : 'no tank next to it'; },
  },
  heater: {
    name: 'Heater (next to a tank)', cat: 'Actuators', tag: 'Heat', h: 2, size: () => [1, 1],
    params: [num('power', 'Heating power', 200, 1, 5000, 'kW', 1)], io: () => [B('on', 'out', 'Heater', '_On')], init: () => ({ on: false }),
    act(el, st, W, dt) {
      st.on = !!W.out(el, 'on') && !W.jammed(el);
      const t = W.tankNear(el);
      // water: 4.19 kJ/(kg·K); heats the liquid that is in the tank
      if (st.on && t && !t.def.infinite) t.st.temp = Math.min(130, t.st.temp + ((el.params.power * W.rate(el)) / (Math.max(t.st.vol, 5) * 4.19)) * dt);
    },
    status: (el, st, W) => { const t = W.tankNear(el); return t ? `${st.on ? 'heating' : 'off'}, tank ${t.st.temp.toFixed(1)} °C` : 'no tank next to it'; },
  },
  filler: {
    name: 'Filling station', cat: 'Actuators', tag: 'Fill', h: 6, size: () => [2, 2],
    params: [num('rate', 'Fill rate', 25, 1, 200, '%/s', 1)],
    io: () => [B('valve', 'out', 'Fill valve', '_Valve'), B('full', 'in', 'Bottle full', '_Full'), B('present', 'in', 'Bottle under the nozzle', '_Bottle')],
    init: () => ({ on: false, spilled: 0 }),
    act(el, st, W, dt) {
      st.on = !!W.out(el, 'valve') && !W.jammed(el);
      const b = W.itemsIn(W.front(el, 0.5, 1, 1), null).find((i) => i.kind === 'bottle');
      st.bottle = b || null;
      if (!st.on) return;
      if (!b) { st.spilled += dt; return; }
      b.fill += el.params.rate * W.rate(el) * dt;
      if (b.fill > 100) { b.fill = 100; b.spilled = true; st.spilled += dt; }
    },
    sense(el, st, W) { W.in(el, 'present', !!st.bottle); W.in(el, 'full', !!st.bottle && st.bottle.fill >= 92); },
    status: (el, st) => (st.bottle ? `bottle ${st.bottle.fill.toFixed(0)} %` : 'no bottle') + (st.spilled > 0.05 ? `, spilled for ${st.spilled.toFixed(1)} s` : ''),
  },
  capper: {
    name: 'Capping press', cat: 'Actuators', tag: 'Cap', h: 6, size: () => [2, 2],
    params: [num('time', 'Stroke time', 0.3, 0.1, 3, 's', 0.1)],
    io: () => [B('press', 'out', 'Press down', '_Press'), B('down', 'in', 'Press is down', '_Down'), B('present', 'in', 'Bottle under the press', '_Bottle')],
    init: () => ({ pos: 0, hits: 0 }),
    act(el, st, W, dt) {
      st.pos = travel(W, el, st.pos, W.out(el, 'press') ? 1 : 0, el.params.time, dt);
      const b = W.itemsIn(W.front(el, 0.5, 1, 1), null).find((i) => i.kind === 'bottle');
      st.bottle = b || null;
      if (b && st.pos > 0.9) b.capped = true;
      if (b && st.pos > 0.2 && Math.hypot(b.vx || 0, b.vz || 0) > 0.2) st.hits++; // belt moved under the lowered press
    },
    sense(el, st, W) { W.in(el, 'down', st.pos > 0.98); W.in(el, 'present', !!st.bottle); },
    status: (el, st) => `${(st.pos * 100).toFixed(0)} % down${st.hits ? `, belt moved while down ×${st.hits}` : ''}`,
  },

  // ================================================================= sensors
  lightbarrier: {
    name: 'Light barrier', cat: 'Sensors', tag: 'LB', h: 2.4, size: () => [1, 1],
    params: [num('range', 'Range', 3, 0.5, 12, 'studs', 0.5), sel('height', 'Beam height', ['low (every workpiece)', 'high (tall workpieces only)'])],
    io: () => [B('s', 'in', 'Beam interrupted')], init: () => ({ on: false }),
    sense(el, st, W) {
      const high = el.params.height.startsWith('high');
      st.on = W.itemsIn(W.front(el, 0, el.params.range, 0.3), el.y).some((i) => !high || i.h >= 1.5);
      W.in(el, 's', st.on);
    },
    status: (el, st) => (st.on ? 'interrupted' : 'free'),
  },
  inductive: {
    name: 'Proximity switch, inductive (metal)', cat: 'Sensors', tag: 'Ind', h: 1.6, size: () => [1, 1],
    params: [num('range', 'Range', 1.5, 0.3, 4, 'studs', 0.1)], io: () => [B('s', 'in', 'Metal detected')], init: () => ({ on: false }),
    sense(el, st, W) { st.on = W.itemsIn(W.front(el, 0, el.params.range, 0.8), el.y).some((i) => i.material === 'metal'); W.in(el, 's', st.on); },
    status: (el, st) => (st.on ? 'metal detected' : 'nothing'),
  },
  capacitive: {
    name: 'Proximity switch, capacitive (any material)', cat: 'Sensors', tag: 'Capa', h: 1.6, size: () => [1, 1],
    params: [num('range', 'Range', 1.5, 0.3, 4, 'studs', 0.1)], io: () => [B('s', 'in', 'Object detected')], init: () => ({ on: false }),
    sense(el, st, W) { st.on = W.itemsIn(W.front(el, 0, el.params.range, 0.8), el.y).length > 0; W.in(el, 's', st.on); },
    status: (el, st) => (st.on ? 'object detected' : 'nothing'),
  },
  coloursensor: {
    name: 'Colour sensor', cat: 'Sensors', tag: 'Col', h: 2, size: () => [1, 1],
    params: [sel('color', 'Detects', COLOR_NAMES), num('range', 'Range', 2, 0.5, 6, 'studs', 0.5)], io: () => [B('s', 'in', 'Colour seen')], init: () => ({ on: false }),
    sense(el, st, W) { st.on = W.itemsIn(W.front(el, 0, el.params.range, 0.4), el.y).some((i) => i.color === el.params.color); W.in(el, 's', st.on); },
    status: (el, st) => (st.on ? `${el.params.color} seen` : 'nothing'),
  },
  limitswitch: {
    name: 'Limit switch (mechanical)', cat: 'Sensors', tag: 'LS', h: 1.2, size: () => [1, 1],
    params: [sel('contact', 'Contact', ['NO', 'NC'])], io: () => [B('s', 'in', 'Actuated')], init: () => ({ on: false }),
    sense(el, st, W) {
      st.on = W.itemsIn(W.front(el, 0, 0.8, 0.8), el.y).length > 0 || W.pushedAt(W.front(el, 0, 0.8, 0.8));
      W.in(el, 's', el.params.contact === 'NC' ? !st.on : st.on);
    },
    status: (el, st) => (st.on ? 'actuated' : 'free'),
  },
  levelswitch: {
    name: 'Level switch (digital, next to a tank)', cat: 'Sensors', tag: 'LSL', h: 3, size: () => [1, 1],
    params: [num('level', 'Switching level', 50, 0, 100, '%', 1)], io: () => [B('s', 'in', 'Level reached')], init: () => ({ on: false }),
    sense(el, st, W) { const t = W.tankNear(el); st.on = !!t && (t.st.vol / t.el.params.capacity) * 100 >= el.params.level; W.in(el, 's', st.on); },
    status: (el, st, W) => (W.tankNear(el) ? (st.on ? 'covered' : 'dry') : 'no tank next to it'),
  },
  leveltx: {
    name: 'Level transmitter (analog, next to a tank)', cat: 'Sensors', tag: 'LT', h: 3, size: () => [1, 1],
    params: [signal, num('noise', 'Noise', 0, 0, 5, '%', 0.1)], io: () => [A('v', 'in', 'Level 0..100 % → 0..27648')], init: () => ({ v: 0, n: 0 }),
    sense(el, st, W) {
      const t = W.tankNear(el);
      st.n += ((Math.random() - 0.5) * 2 * el.params.noise - st.n) * 0.5;
      st.v = t && !t.def.infinite ? clamp((t.st.vol / t.el.params.capacity) * 100 + st.n, 0, 100) : 0;
      analogIn(W, el, 'v', st.v, 0, 100);
    },
    status: (el, st, W) => (W.tankNear(el) ? `${st.v.toFixed(1)} %` : 'no tank next to it'),
  },
  pressure: {
    name: 'Pressure sensor (analog, next to a tank)', cat: 'Sensors', tag: 'PT', h: 2, size: () => [1, 1],
    params: [signal, num('max', 'Measuring range', 1, 0.1, 16, 'bar', 0.1)], io: () => [A('v', 'in', 'Pressure 0..range → 0..27648')], init: () => ({ v: 0 }),
    sense(el, st, W) {
      const t = W.tankNear(el);
      // hydrostatic pressure at the tank bottom: ρ·g·h, water, in bar
      st.v = t && !t.def.infinite ? (t.st.vol / t.el.params.capacity) * t.el.params.height * 0.0981 : 0;
      analogIn(W, el, 'v', st.v, 0, el.params.max);
    },
    status: (el, st) => `${st.v.toFixed(3)} bar`,
  },
  temperature: {
    name: 'Temperature sensor (analog)', cat: 'Sensors', tag: 'TT', h: 2, size: () => [1, 1],
    params: [signal, num('min', 'Range start', 0, -50, 100, '°C', 1), num('max', 'Range end', 100, 0, 500, '°C', 1)], io: () => [A('v', 'in', 'Temperature → 0..27648')], init: () => ({ v: 20 }),
    sense(el, st, W) { const t = W.tankNear(el); st.v = t ? t.st.temp : 20; analogIn(W, el, 'v', st.v, el.params.min, el.params.max); },
    status: (el, st) => `${st.v.toFixed(1)} °C`,
  },
  encoder: {
    name: 'Encoder (next to a conveyor)', cat: 'Sensors', tag: 'Enc', h: 1.2, size: () => [1, 1],
    params: [num('ppr', 'Pulses per stud', 10, 1, 100, '', 1)], io: () => [A('v', 'in', 'Count 0..32767 (wraps)')], init: () => ({ pulses: 0, last: null }),
    sense(el, st, W) {
      const c = W.near(el, (o) => o.type === 'conveyor');
      if (c) { if (st.last == null) st.last = c.st.dist; st.pulses += Math.abs(c.st.dist - st.last) * el.params.ppr; st.last = c.st.dist; }
      W.in(el, 'v', Math.floor(st.pulses) % 32768);
    },
    status: (el, st, W) => (W.near(el, (o) => o.type === 'conveyor') ? `${Math.floor(st.pulses) % 32768} pulses` : 'no conveyor next to it'),
  },
  scale: {
    name: 'Scale (weighing platform)', cat: 'Sensors', tag: 'WT', h: 0.6, size: () => [2, 2],
    params: [signal, num('max', 'Measuring range', 2000, 100, 50000, 'g', 100)], io: () => [A('v', 'in', 'Weight 0..range → 0..27648')], init: () => ({ v: 0 }),
    sense(el, st, W) {
      const r = W.rect(el);
      st.v = W.itemsIn(r, null).filter((i) => i.x >= r.x1 && i.x <= r.x2 && i.z >= r.z1 && i.z <= r.z2).reduce((s, i) => s + i.mass, 0);
      analogIn(W, el, 'v', st.v, 0, el.params.max);
    },
    status: (el, st) => `${st.v.toFixed(0)} g`,
  },

  // ================================================================= operating elements
  button: {
    name: 'Push button', cat: 'Operating', tag: 'Btn', h: 1.6, size: () => [1, 1], operate: 'momentary',
    params: [sel('contact', 'Contact', ['NO', 'NC']), sel('color', 'Colour', ['green', 'red', 'yellow', 'blue', 'white'])],
    io: () => [B('s', 'in', 'Button')], init: () => ({ pressed: false }),
    sense(el, st, W) { W.in(el, 's', el.params.contact === 'NC' ? !st.pressed : st.pressed); },
    status: (el, st) => `${el.params.contact}, ${st.pressed ? 'pressed' : 'released'}`,
  },
  switch: {
    name: 'Switch (stays in position)', cat: 'Operating', tag: 'Sw', h: 1.6, size: () => [1, 1], operate: 'toggle',
    params: [bool('start', 'On at start')], io: () => [B('s', 'in', 'Switch')], init: (el) => ({ pressed: !!el.params.start }),
    sense(el, st, W) { W.in(el, 's', st.pressed); },
    status: (el, st) => (st.pressed ? 'on' : 'off'),
  },
  estop: {
    name: 'Emergency stop (latching, NC)', cat: 'Operating', tag: 'EStop', h: 2, size: () => [2, 2], operate: 'toggle',
    params: [], io: () => [B('s', 'in', 'E-stop chain (TRUE = released)')], init: () => ({ pressed: false }),
    sense(el, st, W) { W.in(el, 's', !st.pressed); },
    status: (el, st) => (st.pressed ? 'PRESSED (latched)' : 'released'),
  },
  selector: {
    name: 'Selector switch (3 positions)', cat: 'Operating', tag: 'Sel', h: 1.6, size: () => [1, 1], operate: 'cycle3',
    params: [num('start', 'Position at start', 1, 0, 2, '', 1)], io: () => [B('a', 'in', 'Position left', '_L'), B('b', 'in', 'Position right', '_R')],
    init: (el) => ({ position: el.params.start }),
    sense(el, st, W) { W.in(el, 'a', st.position === 0); W.in(el, 'b', st.position === 2); },
    status: (el, st) => ['left', 'middle', 'right'][st.position],
  },
  potentiometer: {
    name: 'Potentiometer', cat: 'Operating', tag: 'Pot', h: 1.6, size: () => [1, 1], operate: 'step10',
    params: [num('value', 'Position', 50, 0, 100, '%', 1)], io: () => [A('v', 'in', 'Position 0..100 % → 0..27648')], init: (el) => ({ value: el.params.value }),
    sense(el, st, W) { analogIn(W, el, 'v', st.value, 0, 100); },
    status: (el, st) => `${st.value.toFixed(0)} %`,
  },
  setpoint: {
    name: 'HMI setpoint (number for the program)', cat: 'Operating', tag: 'SP', h: 2.4, size: () => [2, 1],
    params: [num('value', 'Value', 10, -32768, 32767, '', 1), { key: 'unit', label: 'Unit shown on the display', type: 'text', def: '' }],
    io: () => [A('v', 'in', 'Value (as entered)')], init: () => ({}),
    sense(el, st, W) { W.in(el, 'v', Math.round(el.params.value)); },
    status: (el) => `${el.params.value} ${el.params.unit || ''}`,
  },

  // ================================================================= structure
  brick: {
    name: 'Brick', cat: 'Structure', tag: 'Brick', size: (el) => [el.params.w, el.params.d], h: (el) => el.params.h * 0.4, stackable: true,
    params: [num('w', 'Width', 2, 1, 16, 'studs', 1), num('d', 'Depth', 4, 1, 16, 'studs', 1), num('h', 'Height', 3, 1, 30, 'plates', 1), sel('color', 'Colour', ['gray', 'red', 'blue', 'yellow', 'green', 'white', 'black', 'tan', 'orange'])],
    io: () => [], init: () => ({}),
  },
};

export const KIT_CATEGORIES = ['Actuators', 'Sensors', 'Operating', 'Material flow', 'Structure'];
export const kitDef = (type) => KIT[type];
export const defaultKitParams = (type) => Object.fromEntries(KIT[type].params.map((p) => [p.key, p.def]));
export const sizeOf = (el) => KIT[el.type].size(el);
export const heightOf = (el) => { const h = KIT[el.type].h; return typeof h === 'function' ? h(el) : h; };
export function registerKitType(type, def) { KIT[type] = def; }

export const FAULTS = {
  sensor: [['', 'none'], ['stuck0', 'stuck at 0'], ['stuck1', 'stuck at 1'], ['break', 'wire break']],
  actuator: [['', 'none'], ['jam', 'jammed (does not move)'], ['slow', 'reacts slowly'], ['break', 'wire break (output never arrives)']],
};
/** Which fault list applies: elements with PLC outputs are actuators, the rest sensors/operators. */
export const faultClass = (el) => (KIT[el.type].io(el).some((p) => p.dir === 'out') ? 'actuator' : KIT[el.type].io(el).length ? 'sensor' : null);
