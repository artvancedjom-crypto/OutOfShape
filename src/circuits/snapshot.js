// Standalone picture of a circuit (no editor needed): used for snapshots that are
// embedded in documents. Always drawn in "paper" colours, independent of the app theme.
import { PARTS, U, pinPositions, partBBox } from './parts.js';
import { formatSI } from './units.js';
import { Simulation } from './sim.js';

const INK = '#1d2533';
const STYLE = `
  .p line,.p path,.p circle,.p rect,.p polyline{stroke:${INK};stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
  .p .thick{stroke-width:3.2}.p .thin{stroke-width:1.5}.p .f{fill:${INK}}.p .bg{fill:#fff}.p .on{fill:#b7ebc9}
  .p .warn{stroke:#e0393e}.p .glow{stroke:none;opacity:.8}
  .p text{fill:${INK};stroke:none;font:600 10px monospace;text-anchor:middle}.p text.sym-big{font:700 15px sans-serif}
  .w{fill:none;stroke:${INK};stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
  .j{fill:${INK}} .n{font:700 12px sans-serif;fill:${INK}} .v{font:11px monospace;fill:#667085}
  .lb path{fill:#fff3cf;stroke:#ffb400;stroke-width:1.5}.lb text{font:700 12px monospace;fill:${INK}}
  .pr text{font:700 11px monospace;fill:#10151f;text-anchor:middle}`;
const COLORS = ['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5', '#00bbf9', '#f15bb5', '#8ac926', '#ffca3a'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** @returns {{svg:string, width:number, height:number}} */
export function circuitSVG(doc, sim) {
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  const add = (x, y) => { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); };
  for (const p of doc.parts) { const b = partBBox(p); add(b.x1, b.y1); add(b.x2, b.y2); }
  for (const w of doc.wires) for (const pt of w.pts) add(pt[0], pt[1]);
  for (const l of doc.labels) add(l.x, l.y);
  if (x1 === Infinity) { x1 = 0; y1 = 0; x2 = 12; y2 = 6; }
  x1 -= 3; y1 -= 3; x2 += 5; y2 += 3;
  let s = '';
  for (const w of doc.wires) s += `<polyline class="w" points="${w.pts.map((p) => `${p[0] * U},${p[1] * U}`).join(' ')}"/>`;
  for (const j of sim && sim.net ? sim.net.junctions : []) s += `<circle class="j" cx="${j[0] * U}" cy="${j[1] * U}" r="4"/>`;
  for (const part of doc.parts) {
    const def = PARTS[part.type];
    if (!def) continue;
    const live = sim ? sim.partResult(part) : null;
    const rot = (part.rot || 0) * 90;
    // keep symbol texts upright, as the editor does
    const sym = def.symbol(part.params, live).replace(/<text x="([-\d.]+)" y="([-\d.]+)"/g, (m, tx, ty) => `<text x="${tx}" y="${ty}" transform="translate(${tx},${ty}) scale(${part.mirror ? -1 : 1},1) rotate(${-rot}) translate(${-tx},${-ty})"`);
    s += `<g class="p" transform="translate(${part.x * U},${part.y * U}) rotate(${rot}) scale(${part.mirror ? -1 : 1},1)">${sym}</g>`;
    const b = partBBox(part);
    const vertical = (part.rot || 0) % 2 === 1 || !!def.labelRight;
    const val = def.value ? def.value(part.params) : null;
    const texts = [part.name, val ? formatSI(val[0], val[1]) : ''].filter(Boolean);
    const tx = vertical ? (b.x2 + 0.5) * U : ((b.x1 + b.x2) / 2) * U;
    const ty = vertical ? ((b.y1 + b.y2) / 2) * U - (texts.length - 1) * 7 : (b.y1 - 0.3) * U - (texts.length - 1) * 14;
    texts.forEach((t, i) => { s += `<text class="${i === 0 && part.name ? 'n' : 'v'}" x="${tx}" y="${ty + i * 14}" text-anchor="${vertical ? 'start' : 'middle'}">${esc(t)}</text>`; });
    void pinPositions;
  }
  for (const l of doc.labels) {
    const w = 14 + String(l.text).length * 7.5;
    s += `<g class="lb" transform="translate(${l.x * U},${l.y * U})"><path d="M0,0 L8,-9 L${w + 8},-9 L${w + 8},-25 L8,-25 L8,-9"/><text x="14" y="-13">${esc(l.text)}</text></g>`;
  }
  doc.probes.forEach((p, k) => {
    const col = COLORS[k % COLORS.length];
    const v = sim ? sim.probeValue(p) : null;
    const txt = v == null ? '—' : formatSI(v, { V: 'V', A: 'A', R: 'Ω' }[p.kind]);
    if (p.kind === 'A') {
      const part = doc.parts.find((q) => q.id === p.part);
      if (!part) return;
      const b = partBBox(part);
      const up = (part.rot || 0) % 2 === 1 || !!(PARTS[part.type] && PARTS[part.type].labelRight);
      const x = up ? (b.x1 - 0.4) * U - 68 : ((b.x1 + b.x2) / 2) * U - 34;
      const y = up ? ((b.y1 + b.y2) / 2) * U - 8 : (b.y2 + 0.4) * U;
      s += `<g class="pr" transform="translate(${x},${y})"><rect width="68" height="17" rx="8.5" fill="${col}"/><text x="34" y="12.5">${esc(txt)}</text></g>`;
    } else {
      const x = p.at[0] * U; const y = p.at[1] * U;
      if (p.ref) s += `<line x1="${x}" y1="${y}" x2="${p.ref[0] * U}" y2="${p.ref[1] * U}" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 4"/>`;
      s += `<g class="pr" transform="translate(${x},${y})"><circle r="4.5" fill="${col}"/><path d="M0,0 L10,-12" stroke="${col}" stroke-width="2"/><rect x="8" y="-29" width="74" height="17" rx="8.5" fill="${col}"/><text x="45" y="-16.5">${esc(txt)}</text></g>`;
    }
  });
  const width = (x2 - x1) * U;
  const height = (y2 - y1) * U;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x1 * U} ${y1 * U} ${width} ${height}"><style>${STYLE}</style><rect x="${x1 * U}" y="${y1 * U}" width="${width}" height="${height}" fill="#fdfdfb"/>${s}</svg>`;
  return { svg, width, height };
}

/** Rasterise to a PNG data URL (about `target` px wide). */
export async function circuitSnapshot(doc, sim, target = 1100) {
  const { svg, width, height } = circuitSVG(doc, sim);
  const scale = Math.max(1, Math.min(3, target / width));
  const img = new Image();
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Snapshot could not be drawn')); img.src = url; });
  const c = document.createElement('canvas');
  c.width = Math.round(width * scale);
  c.height = Math.round(height * scale);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
}

/** Key values shown next to an embedded circuit: every probe with its current reading. */
export function circuitTable(doc, sim) {
  return doc.probes.map((p) => {
    const v = sim.probeValue(p);
    return { label: sim.probeLabel(p), value: v == null ? '—' : formatSI(v, { V: 'V', A: 'A', R: 'Ω' }[p.kind]) };
  });
}

/** Snapshot + table for a circuit that is not open in an editor (settled DC state). */
export async function snapshotOf(doc) {
  const sim = new Simulation();
  sim.rebuild(doc);
  if (sim.circuit && sim.circuit.dynamic) sim.settle();
  const snap = await circuitSnapshot(doc, sim);
  return { ...snap, table: circuitTable(doc, sim) };
}
