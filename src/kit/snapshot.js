// Picture + key values of a plant without opening the workbench
// (used when a plant is embedded in a document).
import { PlcRuntime } from '../plc/runtime.js';
import { KitSim } from './sim.js';
import { Stage } from './stage.js';
import { plcIo, loadScene } from './model.js';
import { registerSceneDefs } from './catalog.js';

export const sceneTable = (sim) => sim.summary().slice(0, 8).map(([label, value]) => ({ label, value: String(value).replace(/[⚠💥]\s*/g, '') }));

/**
 * @param {object} state a plant document
 * @param {number} seconds simulated time to run before the picture is taken
 */
export async function sceneSnapshotOf(state, seconds = 6) {
  registerSceneDefs(state);
  const doc = loadScene(state);
  const host = document.createElement('div');
  Object.assign(host.style, { position: 'fixed', left: '-2000px', top: '0', width: '880px', height: '520px' });
  document.body.append(host);
  const rt = new PlcRuntime(plcIo(doc));
  const sim = new KitSim(doc, { out: (t) => rt.getOutput(t), set: (t, v) => rt.setInput(t, v) });
  const stage = new Stage(host, { doc, getSim: () => sim, theme: 'light' });
  try {
    if (rt.load(doc.program.lang, JSON.parse(JSON.stringify(doc.program.source))).ok) rt.running = true;
    for (let t = 0; t < seconds; t += 0.02) { sim.step(0.02); rt.scan(20); }
    stage.showNames = false;
    stage.setMode('operate');
    stage.world.resize();
    const snap = stage.snapshot();
    return { ...snap, table: sceneTable(sim) };
  } finally {
    stage.destroy();
    host.remove();
  }
}
