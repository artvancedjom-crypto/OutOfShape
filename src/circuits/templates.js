// The built-in circuits as editable documents. Opening one gives the user a copy;
// "Reset to template" rebuilds it from here. Part names match the ids used by the
// PDF matcher (library.js), so values extracted from a document land on the right part.
import { builder } from './model.js';

function divider() {
  const b = builder('Series–Parallel Resistor Network', 'divider');
  b.part('V', 'V1', 4, 9, { rot: 1, params: { V: 12 } })
    .part('R', 'R1', 10, 4, { params: { R: 1000 } })
    .part('R', 'R2', 16, 9, { rot: 1, params: { R: 2200 } })
    .part('SW', 'S1', 21, 4, { params: { closed: false } })
    .part('R', 'R3', 25, 9, { rot: 1, params: { R: 4700 } })
    .gnd(4, 14)
    .wire('V1.+', 'R1.1', 'vh')
    .wire('R1.2', 'S1.1')
    .wire('R2.1', [16, 4])
    .wire('S1.2', 'R3.1', 'hv')
    .wire('V1.-', 'GND1.gnd')
    .wire([4, 13], [25, 13], 'R3.2')
    .wire('R2.2', [16, 13])
    .probe('V', [16, 4], { name: 'V(m)' })
    .probe('A', 'R1').probe('A', 'R2').probe('A', 'R3');
  return b.doc;
}

function led() {
  const b = builder('LED with Series Resistor', 'led');
  b.part('V', 'V1', 4, 9, { rot: 1, params: { V: 9 } })
    .part('SW', 'S1', 9, 4, { params: { closed: true } })
    .part('R', 'R1', 15, 4, { params: { R: 390 } })
    .part('LED', 'D1', 21, 9, { rot: 1, params: { model: 'red' } })
    .gnd(4, 14)
    .wire('V1.+', 'S1.1', 'vh')
    .wire('S1.2', 'R1.1')
    .wire('R1.2', 'D1.A', 'hv')
    .wire('V1.-', 'GND1.gnd')
    .wire([4, 13], [21, 13], 'D1.K')
    .probe('A', 'D1', { name: 'LED current' })
    .probe('V', 'D1.A', { name: 'LED forward voltage' });
  return b.doc;
}

function rc() {
  const b = builder('RC Charging & Discharging', 'rc');
  b.part('V', 'V1', 4, 9, { rot: 1, params: { V: 5 } })
    .part('SPDT', 'S1', 11, 5, { mirror: true, params: { closed: true } })
    .part('R', 'R1', 17, 5, { params: { R: 10000 } })
    .part('C', 'C1', 23, 9, { rot: 1, params: { C: 100e-6 } })
    .gnd(4, 14)
    .wire('V1.+', [4, 4], 'S1.a')
    .wire('S1.b', [8, 6], [8, 13])
    .wire('S1.com', 'R1.1')
    .wire('R1.2', 'C1.1', 'hv')
    .wire('V1.-', 'GND1.gnd')
    .wire([4, 13], [23, 13], 'C1.2')
    .probe('V', 'C1.1', { name: 'V_C', scope: true })
    .probe('V', 'R1.1', { name: 'V_in', scope: true })
    .probe('A', 'R1', { name: 'I', scope: true });
  return b.doc;
}

function npn() {
  const b = builder('NPN Transistor as a Switch', 'npn');
  b.part('V', 'V1', 4, 10, { rot: 1, params: { V: 9 } })
    .part('R', 'RC', 23, 5, { rot: 1, params: { R: 330 } })
    .part('LED', 'D1', 23, 10, { rot: 1, params: { model: 'green' } })
    .part('NPN', 'Q1', 22, 15, { params: { beta: 120 } })
    .part('V', 'V2', 10, 18, { rot: 1, params: { V: 3.3 } })
    .part('R', 'RB', 16, 15, { params: { R: 10000 } })
    .gnd(4, 21)
    .wire('V1.+', [4, 2], [23, 2], 'RC.1')
    .wire('RC.2', 'D1.A')
    .wire('D1.K', 'Q1.C')
    .wire('V2.+', [10, 15], 'RB.1')
    .wire('RB.2', 'Q1.B')
    .wire('V1.-', 'GND1.gnd')
    .wire([4, 20], [23, 20], 'Q1.E')
    .wire('V2.-', [10, 20])
    .probe('A', 'Q1', { name: 'I_C' })
    .probe('V', 'Q1.C', { name: 'V_CE' })
    .probe('V', 'Q1.B', { name: 'V_BE' })
    .probe('A', 'RB', { name: 'I_B' });
  return b.doc;
}

function relay() {
  const b = builder('Relay Self-Holding Circuit', 'relay');
  b.part('V', 'V1', 3, 10, { rot: 1, params: { V: 12 } })
    .part('PBNC', 'S2', 8, 5, { rot: 1 })
    .part('PB', 'S1', 8, 10, { rot: 1 })
    .part('CONTACT_NO', 'K1a', 13, 10, { rot: 1, params: { relay: 'K1' } })
    .part('RELAY', 'K1', 8, 16, { rot: 1, params: { Rcoil: 400, Vrated: 12 } })
    .part('D', 'D1', 13, 16, { rot: 3 })
    .part('CONTACT_NO', 'K1b', 20, 6, { rot: 1, params: { relay: 'K1' } })
    .part('LAMP', 'L1', 20, 14, { rot: 1, params: { color: 'green' } })
    .part('CONTACT_NC', 'K1c', 26, 6, { rot: 1, params: { relay: 'K1' } })
    .part('LAMP', 'L2', 26, 14, { rot: 1, params: { color: 'red' } })
    .gnd(3, 21)
    .wire('V1.+', [3, 2], [26, 2], 'K1c.1')
    .wire([8, 2], 'S2.1')
    .wire([20, 2], 'K1b.1')
    .wire('S2.2', 'S1.1')
    .wire([8, 7.5], [13, 7.5], 'K1a.1')
    .wire('S1.2', 'K1.1')
    .wire('K1a.2', [13, 13], [8, 13])
    .wire([8, 13.5], [13, 13.5], 'D1.K')
    .wire('K1b.2', 'L1.1')
    .wire('K1c.2', 'L2.1')
    .wire('V1.-', 'GND1.gnd')
    .wire([3, 20], [26, 20], 'L2.2')
    .wire('K1.2', [8, 20])
    .wire('D1.A', [13, 20])
    .wire('L1.2', [20, 20])
    .probe('V', 'K1.1', { name: 'Coil voltage' })
    .probe('A', 'L1', { name: 'Green lamp' })
    .probe('A', 'L2', { name: 'Red lamp' });
  return b.doc;
}

const BUILDERS = { divider, led, rc, npn, relay };

export const TEMPLATE_IDS = Object.keys(BUILDERS);

/** Fresh copy of a template document. */
export function templateDoc(id) {
  return BUILDERS[id] ? BUILDERS[id]() : null;
}
