// Part definitions: everything the editor, the netlist builder and (later) the
// catalog need to know about a component type.
//
//   pins     local pin positions in grid units (before rotate/mirror); part origin = (0,0)
//   params   editable values with unit, default and limits
//   symbol   (params, live) → SVG markup in px (1 grid unit = U px)
//   model    (part, nodes[]) → solver components (see mna.js)
//   visual   (result) → small string; the symbol is redrawn only when it changes
//
// The registry is open: registerPart() adds user-defined types (catalog, phase 3).
export const U = 20;

const l = (x1, y1, x2, y2, cls = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${cls ? ` class="${cls}"` : ''}/>`;
const p = (d, cls = '') => `<path d="${d}"${cls ? ` class="${cls}"` : ''}/>`;
const c = (cx, cy, r, cls = '') => `<circle cx="${cx}" cy="${cy}" r="${r}"${cls ? ` class="${cls}"` : ''}/>`;
const rect = (x, y, w, h, cls = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${cls ? ` class="${cls}"` : ''}/>`;
const t = (x, y, s, cls = 'sym-t') => `<text x="${x}" y="${y}" class="${cls}">${s}</text>`;
const glow = (cx, cy, color, b) => (b > 0.02 ? `<circle cx="${cx}" cy="${cy}" r="${10 + b * 16}" fill="${color}" opacity="${Math.min(0.9, b * 0.85).toFixed(2)}" class="glow"/>` : '');
const leads = (a = 14) => l(-40, 0, -a, 0) + l(a, 0, 40, 0);
const two = [{ name: '1', x: -2, y: 0 }, { name: '2', x: 2, y: 0 }];

export const LED_COLORS = { red: '#ff3b30', yellow: '#ffd60a', green: '#34c759', blue: '#3a7bff', white: '#f5f5f5' };
const q = (v, n = 8) => Math.round(Math.max(0, Math.min(1.5, v || 0)) * n);

const switchSym = (closed, extra = '') => l(-40, 0, -14, 0) + l(14, 0, 40, 0) + c(-14, 0, 3, 'bg') + c(14, 0, 3, 'bg')
  + (closed ? l(-14, 0, 14, 0, 'thick') : l(-14, 0, 12, -13, 'thick')) + extra;

const bjt = (pnp) => c(4, 0, 30, 'bg') + l(-40, 0, -8, 0) + l(-8, -16, -8, 16, 'thick')
  + p('M-8,-7 L20,-26 L20,-40') + p('M-8,7 L20,26 L20,40')
  + (pnp ? p('M-8,7 L4,9 L-1,19 Z', 'f') : p('M20,26 L8,24 L13,14 Z', 'f'));

const mos = (pch) => c(4, 0, 30, 'bg') + l(-40, 0, -12, 0) + l(-12, -14, -12, 14, 'thick')
  + l(-5, -18, -5, -8, 'thick') + l(-5, -5, -5, 5, 'thick') + l(-5, 8, -5, 18, 'thick')
  + p('M-5,-13 L20,-13 L20,-40') + p('M-5,13 L20,13 L20,40') + p('M-5,0 L20,0 L20,13')
  + (pch ? p('M12,0 L4,-5 L4,5 Z', 'f') : p('M-3,0 L6,-5 L6,5 Z', 'f'));

const contact = (kind) => (pr, live) => {
  const on = !!(live && live.on);
  const closed = kind === 'NC' ? !on : on;
  return switchSym(closed, kind === 'NC' && !closed ? '' : '') + (kind === 'NC' ? l(6, -16, 6, 2) : '') + t(0, 22, `${pr.relay || '?'} ${kind}`);
};

/** @type {Record<string, any>} */
export const PARTS = {
  GND: {
    name: 'Ground', category: 'Sources', prefix: 'GND', pins: [{ name: 'gnd', x: 0, y: 0 }], params: [],
    bbox: [-0.8, 0, 0.8, 1.2], noName: true,
    symbol: () => l(0, 0, 0, 10) + l(-14, 10, 14, 10, 'thick') + l(-9, 16, 9, 16, 'thick') + l(-4, 22, 4, 22, 'thick'),
    model: () => [],
  },
  R: {
    name: 'Resistor', category: 'Passive', prefix: 'R', pins: two,
    params: [
      { key: 'R', label: 'Resistance', unit: 'Ω', def: 1000, min: 1e-3 },
      { key: 'Pmax', label: 'Power rating', unit: 'W', def: 0.25, min: 0, limit: true },
    ],
    value: (pr) => [pr.R, 'Ω'],
    symbol: () => leads(24) + p('M-24,0 L-20,-8 L-12,8 L-4,-8 L4,8 L12,-8 L20,8 L24,0'),
    model: (pt, n) => [{ id: pt.id, type: 'R', nodes: n, R: pt.params.R, Pmax: pt.params.Pmax }],
  },
  C: {
    name: 'Capacitor', category: 'Passive', prefix: 'C', pins: two,
    params: [
      { key: 'C', label: 'Capacitance', unit: 'F', def: 100e-6, min: 1e-15 },
      { key: 'v0', label: 'Initial voltage', unit: 'V', def: 0 },
      { key: 'Vmax', label: 'Voltage rating', unit: 'V', def: 50, min: 0, limit: true },
    ],
    value: (pr) => [pr.C, 'F'],
    symbol: () => leads(5) + l(-5, -14, -5, 14, 'thick') + l(5, -14, 5, 14, 'thick'),
    model: (pt, n) => [{ id: pt.id, type: 'C', nodes: n, C: pt.params.C, v0: pt.params.v0, Vmax: pt.params.Vmax }],
  },
  L: {
    name: 'Inductor', category: 'Passive', prefix: 'L', pins: two,
    params: [{ key: 'L', label: 'Inductance', unit: 'H', def: 10e-3, min: 1e-12 }],
    value: (pr) => [pr.L, 'H'],
    symbol: () => leads(24) + p('M-24,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0 a6,7 0 0 1 12,0'),
    model: (pt, n) => [{ id: pt.id, type: 'L', nodes: n, L: pt.params.L }],
  },
  POT: {
    name: 'Potentiometer', category: 'Passive', prefix: 'RV',
    pins: [{ name: 'a', x: -2, y: 0 }, { name: 'w', x: 0, y: -2 }, { name: 'b', x: 2, y: 0 }],
    params: [
      { key: 'R', label: 'Total resistance', unit: 'Ω', def: 10000, min: 1e-3 },
      { key: 'pos', label: 'Wiper position', unit: '', def: 0.5, min: 0, max: 1, slider: true },
    ],
    value: (pr) => [pr.R, 'Ω'], bbox: [-2, -2, 2, 0.7],
    symbol: (pr) => leads(24) + p('M-24,0 L-20,-8 L-12,8 L-4,-8 L4,8 L12,-8 L20,8 L24,0') + l(0, -40, 0, -14)
      + p('M0,-9 L-5,-18 L5,-18 Z', 'f') + c(-22 + 44 * (pr.pos ?? 0.5), 13, 2.5, 'f'),
    model: (pt, n) => [{ id: pt.id, type: 'POT', nodes: n, R: pt.params.R, pos: pt.params.pos }],
  },
  V: {
    name: 'Voltage source', category: 'Sources', prefix: 'V', pins: [{ name: '+', x: -2, y: 0 }, { name: '-', x: 2, y: 0 }],
    params: [
      { key: 'V', label: 'Voltage / amplitude', unit: 'V', def: 9 },
      { key: 'wave', label: 'Waveform', type: 'select', options: ['dc', 'sine', 'square'], def: 'dc' },
      { key: 'freq', label: 'Frequency', unit: 'Hz', def: 50, min: 1e-6, when: (pr) => pr.wave !== 'dc' },
      { key: 'offset', label: 'Offset', unit: 'V', def: 0, when: (pr) => pr.wave !== 'dc' },
      { key: 'Imax', label: 'Current limit warning', unit: 'A', def: 5, min: 0, limit: true },
    ],
    value: (pr) => [pr.V, 'V'],
    symbol: (pr) => (pr.wave && pr.wave !== 'dc'
      ? l(-40, 0, -16, 0) + l(16, 0, 40, 0) + c(0, 0, 16, 'bg') + (pr.wave === 'sine' ? p('M-9,0 q4.5,-11 9,0 t9,0') : p('M-9,5 L-9,-5 L0,-5 L0,5 L9,5 L9,-5')) + t(-24, -8, '+')
      : leads(5) + l(-5, -16, -5, 16, 'thick') + l(5, -8, 5, 8, 'thick') + t(-17, -9, '+')),
    model: (pt, n) => [{ id: pt.id, type: 'V', nodes: n, ...pick(pt.params, ['V', 'wave', 'freq', 'offset', 'Imax']) }],
  },
  I: {
    name: 'Current source', category: 'Sources', prefix: 'I', pins: two,
    params: [{ key: 'I', label: 'Current', unit: 'A', def: 0.01 }],
    value: (pr) => [pr.I, 'A'],
    symbol: () => l(-40, 0, -16, 0) + l(16, 0, 40, 0) + c(0, 0, 16, 'bg') + p('M-9,0 L8,0 M3,-5 L9,0 L3,5'),
    model: (pt, n) => [{ id: pt.id, type: 'I', nodes: n, I: pt.params.I }],
  },
  D: {
    name: 'Diode', category: 'Semiconductors', prefix: 'D', pins: [{ name: 'A', x: -2, y: 0 }, { name: 'K', x: 2, y: 0 }],
    params: [
      { key: 'model', label: 'Type', type: 'select', options: ['si', 'schottky'], def: 'si' },
      { key: 'Is', label: 'Saturation current Is (0 = from type)', unit: 'A', def: 0, min: 0 },
      { key: 'n', label: 'Emission coefficient n (0 = from type)', unit: '', def: 0, min: 0 },
      { key: 'Imax', label: 'Max. forward current', unit: 'A', def: 1, min: 0, limit: true },
    ],
    symbol: () => leads(10) + p('M-10,-11 L-10,11 L10,0 Z', 'f') + l(10, -11, 10, 11, 'thick'),
    model: (pt, n) => [{ id: pt.id, type: 'D', nodes: n, ...pick(pt.params, ['model', 'Is', 'n', 'Imax']) }],
  },
  LED: {
    name: 'LED', category: 'Semiconductors', prefix: 'D', pins: [{ name: 'A', x: -2, y: 0 }, { name: 'K', x: 2, y: 0 }],
    params: [
      { key: 'model', label: 'Colour', type: 'select', options: Object.keys(LED_COLORS), def: 'red' },
      { key: 'Is', label: 'Saturation current Is (0 = from colour)', unit: 'A', def: 0, min: 0 },
      { key: 'n', label: 'Emission coefficient n (0 = from colour)', unit: '', def: 0, min: 0 },
      { key: 'Irated', label: 'Rated current', unit: 'A', def: 0.02, min: 1e-6 },
      { key: 'Imax', label: 'Max. current', unit: 'A', def: 0.03, min: 0, limit: true },
    ],
    visual: (r) => `${q(r.brightness)}${r.overcurrent ? '!' : ''}`, bbox: [-2, -1.3, 2, 0.8],
    symbol: (pr, live) => glow(0, 0, live && live.overcurrent ? '#ff00ff' : LED_COLORS[pr.model] || '#ff3b30', live ? live.brightness || 0 : 0)
      + leads(10) + p('M-10,-11 L-10,11 L10,0 Z', 'f') + l(10, -11, 10, 11, 'thick')
      + p('M-2,-15 l7,-9 m-5,0 l5,0 l0,5', 'thin') + p('M7,-15 l7,-9 m-5,0 l5,0 l0,5', 'thin'),
    model: (pt, n) => [{ id: pt.id, type: 'LED', nodes: n, ...pick(pt.params, ['model', 'Is', 'n', 'Irated', 'Imax']) }],
  },
  NPN: {
    name: 'NPN transistor', category: 'Semiconductors', prefix: 'Q',
    pins: [{ name: 'C', x: 1, y: -2 }, { name: 'B', x: -2, y: 0 }, { name: 'E', x: 1, y: 2 }],
    params: [
      { key: 'beta', label: 'Current gain β (hFE)', unit: '', def: 100, min: 1 },
      { key: 'Is', label: 'Saturation current Is', unit: 'A', def: 1e-14, min: 1e-20 },
      { key: 'Icmax', label: 'Max. collector current', unit: 'A', def: 0.5, min: 0, limit: true },
    ],
    bbox: [-2, -2, 1.8, 2], labelRight: true, value: (pr) => [pr.beta, 'β'],
    symbol: () => bjt(false),
    model: (pt, n) => [{ id: pt.id, type: 'NPN', nodes: n, ...pick(pt.params, ['beta', 'Is', 'Icmax']) }],
  },
  PNP: {
    name: 'PNP transistor', category: 'Semiconductors', prefix: 'Q',
    pins: [{ name: 'C', x: 1, y: 2 }, { name: 'B', x: -2, y: 0 }, { name: 'E', x: 1, y: -2 }],
    params: [
      { key: 'beta', label: 'Current gain β (hFE)', unit: '', def: 100, min: 1 },
      { key: 'Is', label: 'Saturation current Is', unit: 'A', def: 1e-14, min: 1e-20 },
      { key: 'Icmax', label: 'Max. collector current', unit: 'A', def: 0.5, min: 0, limit: true },
    ],
    bbox: [-2, -2, 1.8, 2], labelRight: true, value: (pr) => [pr.beta, 'β'],
    // emitter on top: draw the NPN shape flipped vertically, arrow pointing at the base
    symbol: () => c(4, 0, 30, 'bg') + l(-40, 0, -8, 0) + l(-8, -16, -8, 16, 'thick') + p('M-8,-7 L20,-26 L20,-40') + p('M-8,7 L20,26 L20,40') + p('M-8,-7 L4,-9 L-1,-19 Z', 'f'),
    model: (pt, n) => [{ id: pt.id, type: 'PNP', nodes: n, ...pick(pt.params, ['beta', 'Is', 'Icmax']) }],
  },
  NMOS: {
    name: 'N-channel MOSFET', category: 'Semiconductors', prefix: 'M',
    pins: [{ name: 'D', x: 1, y: -2 }, { name: 'G', x: -2, y: 0 }, { name: 'S', x: 1, y: 2 }],
    params: [
      { key: 'Vt', label: 'Threshold voltage', unit: 'V', def: 2, min: 0.01 },
      { key: 'K', label: 'Transconductance K', unit: 'A/V²', def: 0.5, min: 1e-9 },
      { key: 'lambda', label: 'Channel-length modulation λ', unit: '1/V', def: 0, min: 0 },
      { key: 'Idmax', label: 'Max. drain current', unit: 'A', def: 5, min: 0, limit: true },
    ],
    bbox: [-2, -2, 1.8, 2], labelRight: true, value: (pr) => [pr.Vt, 'V'],
    symbol: () => mos(false),
    model: (pt, n) => [{ id: pt.id, type: 'NMOS', nodes: n, ...pick(pt.params, ['Vt', 'K', 'lambda', 'Idmax']) }],
  },
  PMOS: {
    name: 'P-channel MOSFET', category: 'Semiconductors', prefix: 'M',
    pins: [{ name: 'D', x: 1, y: 2 }, { name: 'G', x: -2, y: 0 }, { name: 'S', x: 1, y: -2 }],
    params: [
      { key: 'Vt', label: 'Threshold voltage (magnitude)', unit: 'V', def: 2, min: 0.01 },
      { key: 'K', label: 'Transconductance K', unit: 'A/V²', def: 0.5, min: 1e-9 },
      { key: 'lambda', label: 'Channel-length modulation λ', unit: '1/V', def: 0, min: 0 },
      { key: 'Idmax', label: 'Max. drain current', unit: 'A', def: 5, min: 0, limit: true },
    ],
    bbox: [-2, -2, 1.8, 2], labelRight: true, value: (pr) => [pr.Vt, 'V'],
    symbol: () => mos(true),
    model: (pt, n) => [{ id: pt.id, type: 'PMOS', nodes: n, ...pick(pt.params, ['Vt', 'K', 'lambda', 'Idmax']) }],
  },
  SW: {
    name: 'Switch', category: 'Switches & relays', prefix: 'S', pins: two, interactive: 'toggle',
    params: [{ key: 'closed', label: 'Closed', type: 'bool', def: false }],
    visual: () => '', bbox: [-2, -1, 2, 0.6],
    symbol: (pr) => switchSym(pr.closed),
    model: (pt, n) => [{ id: pt.id, type: 'SW', nodes: n, closed: !!pt.params.closed }],
  },
  PB: {
    name: 'Push button (NO)', category: 'Switches & relays', prefix: 'S', pins: two, interactive: 'momentary',
    params: [{ key: 'closed', label: 'Pressed', type: 'bool', def: false, transient: true }],
    bbox: [-2, -1.2, 2, 0.6],
    symbol: (pr) => switchSym(pr.closed, pr.closed ? l(0, 0, 0, -12, 'thin') + l(-8, -12, 8, -12) : l(0, -7, 0, -18, 'thin') + l(-8, -18, 8, -18)),
    model: (pt, n) => [{ id: pt.id, type: 'SW', nodes: n, closed: !!pt.params.closed }],
  },
  PBNC: {
    name: 'Push button (NC)', category: 'Switches & relays', prefix: 'S', pins: two, interactive: 'momentary',
    params: [{ key: 'closed', label: 'Pressed', type: 'bool', def: false, transient: true }],
    bbox: [-2, -1.2, 2, 0.6],
    // "closed" means pressed; an NC button conducts while NOT pressed
    symbol: (pr) => switchSym(!pr.closed, pr.closed ? l(0, -7, 0, -20, 'thin') + l(-8, -20, 8, -20) : l(0, 0, 0, -12, 'thin') + l(-8, -12, 8, -12)),
    model: (pt, n) => [{ id: pt.id, type: 'SW', nodes: n, closed: !pt.params.closed }],
  },
  SPDT: {
    name: 'Changeover switch', category: 'Switches & relays', prefix: 'S', interactive: 'toggle',
    pins: [{ name: 'com', x: -2, y: 0 }, { name: 'a', x: 2, y: -1 }, { name: 'b', x: 2, y: 1 }],
    params: [{ key: 'closed', label: 'Position b (lower contact)', type: 'bool', def: false }],
    bbox: [-2, -1.4, 2, 1.4],
    symbol: (pr) => l(-40, 0, -14, 0) + l(14, -20, 40, -20) + l(14, 20, 40, 20) + c(-14, 0, 3, 'bg') + c(14, -20, 3, 'bg') + c(14, 20, 3, 'bg')
      + (pr.closed ? l(-14, 0, 13, 18, 'thick') : l(-14, 0, 13, -18, 'thick')),
    model: (pt, n) => [
      { id: pt.id, type: 'SW', nodes: [n[0], n[1]], closed: !pt.params.closed },
      { id: pt.id + '#b', type: 'SW', nodes: [n[0], n[2]], closed: !!pt.params.closed },
    ],
    pinCurrents: (res, pt) => { const a = res.comp[pt.id]; const b = res.comp[pt.id + '#b']; return a && b ? [a.i + b.i, -a.i, -b.i] : null; },
  },
  RELAY: {
    name: 'Relay coil', category: 'Switches & relays', prefix: 'K', pins: two,
    params: [
      { key: 'Rcoil', label: 'Coil resistance', unit: 'Ω', def: 400, min: 0.1 },
      { key: 'Vrated', label: 'Rated coil voltage', unit: 'V', def: 12, min: 0.1 },
      { key: 'Vpull', label: 'Pull-in voltage (0 = 75 %)', unit: 'V', def: 0, min: 0 },
      { key: 'Vdrop', label: 'Drop-out voltage (0 = 30 %)', unit: 'V', def: 0, min: 0 },
    ],
    visual: (r) => (r.on ? '1' : '0'), bbox: [-2, -0.8, 2, 0.8],
    symbol: (pr, live) => leads(18) + rect(-18, -11, 36, 22, live && live.on ? 'on' : 'bg') + l(-18, 11, 18, -11, 'thin'),
    model: (pt, n) => [{ id: pt.id, type: 'RELAY', nodes: n, ...pick(pt.params, ['Rcoil', 'Vrated', 'Vpull', 'Vdrop']), poles: [] }],
  },
  CONTACT_NO: {
    name: 'Relay contact (NO)', category: 'Switches & relays', prefix: 'K', pins: two, relayContact: 'NO', noName: true,
    params: [{ key: 'relay', label: 'Belongs to relay', type: 'text', def: 'K1' }],
    visual: (r) => (r.on ? '1' : '0'), bbox: [-2, -1, 2, 1.3],
    symbol: contact('NO'),
    model: () => [],
  },
  CONTACT_NC: {
    name: 'Relay contact (NC)', category: 'Switches & relays', prefix: 'K', pins: two, relayContact: 'NC', noName: true,
    params: [{ key: 'relay', label: 'Belongs to relay', type: 'text', def: 'K1' }],
    visual: (r) => (r.on ? '1' : '0'), bbox: [-2, -1, 2, 1.3],
    symbol: contact('NC'),
    model: () => [],
  },
  LAMP: {
    name: 'Lamp', category: 'Displays & lamps', prefix: 'H', pins: two,
    params: [
      { key: 'R', label: 'Resistance (hot)', unit: 'Ω', def: 48, min: 1e-3 },
      { key: 'Prated', label: 'Rated power', unit: 'W', def: 3, min: 1e-6, limit: true },
      { key: 'color', label: 'Colour', type: 'select', options: ['warm', 'red', 'green', 'blue'], def: 'warm' },
      { key: 'thermal', label: 'Cold filament has 1/10 resistance', type: 'bool', def: false },
    ],
    visual: (r) => `${q(r.brightness)}${r.overload ? '!' : ''}`, bbox: [-2, -0.9, 2, 0.9],
    symbol: (pr, live) => glow(0, 0, { warm: '#ffd23f', red: '#ff4040', green: '#3dff6e', blue: '#4f8dff' }[pr.color] || '#ffd23f', live ? live.brightness || 0 : 0)
      + leads(13) + c(0, 0, 13, 'bg') + p('M-9,-9 L9,9 M-9,9 L9,-9', 'thin'),
    model: (pt, n) => [{ id: pt.id, type: 'LAMP', nodes: n, ...pick(pt.params, ['R', 'Prated', 'thermal']) }],
  },
  FUSE: {
    name: 'Fuse', category: 'Protection', prefix: 'F', pins: two,
    params: [
      { key: 'Irated', label: 'Rated current', unit: 'A', def: 0.5, min: 1e-6, limit: true },
      { key: 'R', label: 'Resistance', unit: 'Ω', def: 0.05, min: 1e-6 },
    ],
    value: (pr) => [pr.Irated, 'A'],
    visual: (r) => (r.blown ? 'x' : ''), bbox: [-2, -0.6, 2, 0.6],
    actions: [{ label: 'Replace blown fuse', run: (sim, pt) => sim.resetPartState(pt.id) }],
    symbol: (pr, live) => (live && live.blown
      ? leads(18) + rect(-18, -7, 36, 14, 'bg') + p('M-18,0 L-6,0 M6,0 L18,0', 'thin') + p('M-4,-5 L4,5 M-4,5 L4,-5', 'warn')
      : leads(18) + rect(-18, -7, 36, 14, 'bg') + l(-18, 0, 18, 0, 'thin')),
    model: (pt, n) => [{ id: pt.id, type: 'FUSE', nodes: n, ...pick(pt.params, ['Irated', 'R']) }],
  },
  MOTOR: {
    name: 'DC motor', category: 'Motors', prefix: 'M', pins: [{ name: '+', x: -2, y: 0 }, { name: '-', x: 2, y: 0 }],
    params: [
      { key: 'R', label: 'Armature resistance', unit: 'Ω', def: 4, min: 1e-3 },
      { key: 'Ke', label: 'Back-EMF constant', unit: 'V·s/rad', def: 0.03, min: 1e-6 },
      { key: 'J', label: 'Rotor inertia', unit: 'kg·m²', def: 2e-5, min: 1e-9 },
      { key: 'friction', label: 'Friction', unit: 'N·m·s', def: 2e-5, min: 0 },
      { key: 'load', label: 'Load torque', unit: 'N·m', def: 0, min: 0 },
    ],
    visual: (r) => String(Math.round((r.rpm || 0) / 50)), bbox: [-2, -0.9, 2, 0.9],
    symbol: (pr, live) => leads(16) + c(0, 0, 16, 'bg') + t(0, 5, 'M', 'sym-big') + t(-24, -8, '+')
      + (live && Math.abs(live.rpm) > 20 ? t(0, 30, `${Math.round(live.rpm)} rpm`) : ''),
    model: (pt, n) => [{ id: pt.id, type: 'MOTOR', nodes: n, ...pick(pt.params, ['R', 'Ke', 'J', 'friction', 'load']) }],
  },
  AMMETER: {
    name: 'Ammeter', category: 'Instruments', prefix: 'A', pins: two, params: [],
    visual: (r) => (r.reading || 0).toPrecision(3), bbox: [-2, -0.9, 2, 0.9],
    symbol: () => leads(16) + c(0, 0, 16, 'bg') + t(0, 5, 'A', 'sym-big'),
    reading: (r) => [r.reading, 'A'],
    model: (pt, n) => [{ id: pt.id, type: 'AMMETER', nodes: n }],
  },
  VOLTMETER: {
    name: 'Voltmeter', category: 'Instruments', prefix: 'P', pins: [{ name: '+', x: -2, y: 0 }, { name: '-', x: 2, y: 0 }], params: [],
    visual: (r) => (r.reading || 0).toPrecision(3), bbox: [-2, -0.9, 2, 0.9],
    symbol: () => leads(16) + c(0, 0, 16, 'bg') + t(0, 5, 'V', 'sym-big') + t(-24, -8, '+'),
    reading: (r) => [r.reading, 'V'],
    model: (pt, n) => [{ id: pt.id, type: 'VOLTMETER', nodes: n }],
  },
};

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export const CATEGORY_ORDER = ['Sources', 'Passive', 'Semiconductors', 'Switches & relays', 'Displays & lamps', 'Motors', 'Protection', 'Instruments'];

export function partDef(type) {
  return PARTS[type];
}

export function registerPart(type, def) {
  PARTS[type] = def;
}

export function defaultParams(type) {
  const out = {};
  for (const prm of PARTS[type].params) out[prm.key] = prm.def;
  return out;
}

/** Local → world transform for a part: mirror (x), rotate by 90°·rot, translate. */
export function toWorld(part, x, y) {
  if (part.mirror) x = -x;
  for (let i = 0; i < (part.rot || 0); i++) [x, y] = [-y, x];
  return [part.x + x, part.y + y];
}

export function pinPositions(part) {
  const def = PARTS[part.type];
  return def ? def.pins.map((pn) => toWorld(part, pn.x, pn.y)) : [];
}

export function partBBox(part) {
  const def = PARTS[part.type];
  const b = (def && def.bbox) || [-2, -0.8, 2, 0.8];
  const [x1, y1] = toWorld(part, b[0], b[1]);
  const [x2, y2] = toWorld(part, b[2], b[3]);
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}
