// Shared scene-building helpers for scenarios.
import * as THREE from 'three';
import { brick, tile, at, label, lamp, pushButton, COLORS, PLATE, plastic, tree, figure } from '../three/bricks.js';

export { THREE, brick, tile, at, label, lamp, pushButton, COLORS, PLATE, plastic, tree, figure };

/**
 * Wire a 3D push button to a PLC input.
 * mode: 'momentary' (true while held) | 'toggle' (latching) | 'nc-momentary' (true unless held)
 */
export function wireButton(world, io, obj, input, mode = 'momentary', tip) {
  const press = obj.userData.press || (() => {});
  world.addInteractable(obj, {
    tip: tip || input,
    onDown() {
      if (mode === 'toggle') {
        const v = !io.get(input);
        io.set(input, v);
        press(v);
      } else {
        io.set(input, mode !== 'nc-momentary');
        press(true);
      }
    },
    onUp() {
      if (mode === 'momentary') { io.set(input, false); press(false); }
      if (mode === 'nc-momentary') { io.set(input, true); press(false); }
    },
  });
  obj.userData.hover = obj.userData.hover || (() => {});
  return obj;
}

/** Control desk: a slanted panel on a brick stand that holds buttons & lamps. */
export function controlDesk(w = 8, d = 4, color = COLORS.gray) {
  const g = new THREE.Group();
  g.add(brick(w, d, 9, color, { studs: false }));
  const top = tile(w, d, COLORS.dark, 1);
  top.position.y = 9 * PLATE;
  g.add(top);
  return g;
}

/** Add a labelled element on a desk at local (x,z) */
export function onDesk(desk, obj, x, z, text) {
  obj.position.set(x, 9 * PLATE + PLATE, z);
  desk.add(obj);
  if (text) {
    const l = label(text, { size: 0.55 });
    l.position.set(x, 9 * PLATE + 2.1, z);
    desk.add(l);
  }
  return obj;
}

/** Flat road / floor strip */
export function strip(w, d, color, y = 0.01) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), plastic(color));
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

/** Photo-eye: emitter + reflector pair, with visible beam when blocked/free. */
export function photoEye(length, color = COLORS.yellow) {
  const g = new THREE.Group();
  const a = brick(1, 1, 3, COLORS.black);
  const b = brick(1, 1, 3, COLORS.black);
  a.position.z = -length / 2;
  b.position.z = length / 2;
  g.add(a, b);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.55 });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, length, 6), beamMat);
  beam.rotation.x = Math.PI / 2;
  beam.position.y = 0.9;
  g.add(beam);
  const ind = lamp(color, { r: 0.25, h: 0.3 });
  ind.position.set(0, 3 * PLATE + 0.2, -length / 2);
  g.add(ind);
  g.userData.set = (blocked) => {
    beamMat.color.set(blocked ? 0x33ff66 : 0xff3030);
    ind.userData.set(blocked);
  };
  return g;
}

/** Spinning fan / flywheel used for motors (rotates around its local Z axis). */
export function flywheel(r = 2, color = COLORS.yellow) {
  const g = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 16), plastic(COLORS.gray));
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.9, r, 0.2), plastic(color));
    blade.geometry.translate(0, r / 2, 0);
    blade.rotation.z = (i * Math.PI * 2) / 3;
    blade.castShadow = true;
    g.add(blade);
  }
  return g;
}

export function addScenery(world, spots) {
  for (const [x, z, s] of spots) world.scene.add(tree(x, z, s || 1));
}
