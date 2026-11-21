// Picture + key values of a PLC scenario without opening the workbench
// (used when a scene is embedded in a document).
import { World } from '../three/world.js';
import { PlcRuntime } from '../plc/runtime.js';
import { getScenario } from './index.js';

/** Render the WebGL canvas of a running world to a PNG (must happen right after a render call). */
export function worldSnapshot(world) {
  world.renderer.render(world.scene, world.camera);
  const c = world.renderer.domElement;
  return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
}

export const plcTable = (sim) => (sim.status ? sim.status().map(([label, value]) => ({ label, value: String(value).replace(/[⚠💥]\s*/g, '') })) : []);

/**
 * @param {{scenarioId:string, params:object, program:{lang:string, source:any}}} state
 * @param {number} seconds simulated time to run before the picture is taken
 */
export async function plcSnapshotOf(state, seconds = 6) {
  const scn = getScenario(state.scenarioId);
  if (!scn) throw new Error('Unknown scenario ' + state.scenarioId);
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', left: '-2000px', top: '0', width: '880px', height: '520px' });
  document.body.append(host);
  const world = new World(host, { theme: 'light' });
  try {
    const rt = new PlcRuntime(scn.io);
    const params = { ...Object.fromEntries(scn.params.map((p) => [p.key, p.default])), ...(state.params || {}) };
    const io = { get: (n) => rt.inputs[n], set: (n, v) => rt.setInput(n, v), out: (n) => rt.getOutput(n) };
    const sim = scn.build(world, io, params);
    sim.reset();
    for (const p of scn.params) if (p.input) rt.setInput(p.input, params[p.key] * (p.scale || 1));
    const prog = state.program || scn.programs.solution;
    if (rt.load(prog.lang, JSON.parse(JSON.stringify(prog.source))).ok) rt.running = true;
    for (let t = 0; t < seconds; t += 0.02) { sim.update(0.02); rt.scan(20); }
    sim.render(0.02);
    world.resize();
    const snap = worldSnapshot(world);
    return { ...snap, table: plcTable(sim) };
  } finally {
    world.dispose();
    host.remove();
  }
}
