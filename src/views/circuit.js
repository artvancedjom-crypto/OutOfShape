import { h, clear, fmt } from '../core/dom.js';
import { getCircuit, CIRCUITS } from '../circuits/library.js';
import { Circuit } from '../circuits/mna.js';
import { renderSchematic } from '../circuits/schematic.js';
import { getDoc } from '../docs/store.js';
import { parseLaunch } from './launch.js';

// log-scale slider helpers
const toSlider = (p, v) => (p.log ? (Math.log10(v) - Math.log10(p.min)) / (Math.log10(p.max) - Math.log10(p.min)) * 1000 : v);
const fromSlider = (p, s) => {
  if (!p.log) return +s;
  const v = 10 ** (Math.log10(p.min) + (s / 1000) * (Math.log10(p.max) - Math.log10(p.min)));
  // snap to E12 series for resistor-like values
  const e12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2, 10];
  const dec = 10 ** Math.floor(Math.log10(v));
  const m = v / dec;
  const best = e12.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a));
  return +(best * dec).toPrecision(3);
};

export async function circuitView(root, id, q = {}) {
  const def = getCircuit(id);
  clear(root);
  if (!def) { root.append(h('div', { class: 'page' }, 'Unknown circuit')); return; }
  document.getElementById('crumb').textContent = `Lab › ${def.name}`;
  const launch = parseLaunch(q);
  const doc = launch.docId ? await getDoc(launch.docId) : null;
  const circuit = new Circuit(def.components);
  const fromDoc = new Set();
  // apply defaults + document parameters
  for (const p of def.params) {
    let v = p.default;
    if (launch.params && p.key in launch.params) { v = launch.params[p.key]; fromDoc.add(p.key); }
    circuit.set(p.comp, p.field, v);
  }

  const schHost = h('div', { class: 'sch-host' });
  const readHost = h('div', { class: 'readouts' });
  const paramHost = h('div', { class: 'params-pane' });
  const scopeCanvas = def.transient ? h('canvas', { class: 'scope', width: 900, height: 260 }) : null;
  const playBtn = def.transient ? h('button', { class: 'btn small' }, '⏸ Pause') : null;
  const tbSel = def.transient ? h('select', { class: 'input slim', title: 'Time base' }, [['auto', 'Time base: auto (5τ ≈ 4 s)'], ['real', 'Real time'], ['slow', 'Slow motion ×0.1']].map(([v, l]) => h('option', { value: v }, l))) : null;

  root.append(h('div', { class: 'page circuit-view' },
    h('div', { class: 'toolbar flat' },
      doc ? h('a', { class: 'btn ghost', href: `#/doc/${doc.id}${launch.page != null ? '?page=' + launch.page : ''}` }, `← ${doc.name}`) : h('a', { class: 'btn ghost', href: '#/lab?tab=circuits' }, '← Circuits'),
      h('div', { class: 'tb-title' }, h('span', { class: 'tb-icon' }, def.icon), h('b', {}, def.name), h('span', { class: `badge diff-${def.difficulty.toLowerCase()}` }, def.difficulty)),
      h('div', { class: 'spacer' }),
      h('select', { class: 'input slim', onchange: (e) => { location.hash = '/circuit/' + e.target.value; } }, CIRCUITS.map((c) => h('option', { value: c.id, selected: c.id === def.id }, c.name)))),
    h('div', { class: 'circuit-grid' },
      h('div', { class: 'card sch-card' },
        h('div', { class: 'card-h' }, h('b', {}, 'Schematic'), h('span', { class: 'small muted' }, 'Click switches to operate them · moving dashes show conventional current')),
        schHost,
        scopeCanvas ? h('div', { class: 'scope-wrap' }, h('div', { class: 'card-h' }, h('b', {}, 'Oscilloscope'), h('div', { class: 'row gap' }, tbSel, playBtn, h('button', { class: 'btn small', onclick: () => { trace.length = 0; } }, 'Clear'))), scopeCanvas, h('div', { class: 'legend' }, def.scope.map((s) => h('span', {}, h('i', { style: { background: s.color } }), s.label)))) : null),
      h('div', { class: 'side-col' },
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', {}, 'Live readouts')), readHost),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('b', {}, 'Component values')), paramHost),
        h('div', { class: 'card theory' }, h('div', { class: 'card-h' }, h('b', {}, 'Theory')), h('div', { html: def.theory }))))));

  // parameters
  if (doc && fromDoc.size) paramHost.append(h('div', { class: 'note' }, `📄 ${fromDoc.size} value(s) taken from “${doc.name}”.`));
  for (const p of def.params) {
    const comp = circuit.get(p.comp);
    const val = h('span', { class: 'pval' });
    let ctl;
    const show = () => { val.textContent = p.type === 'select' ? '' : fmt(comp[p.field], p.unit); };
    if (p.type === 'select') {
      ctl = h('select', { class: 'input' }, p.options.map((o) => h('option', { value: o, selected: comp[p.field] === o }, o)));
      ctl.addEventListener('change', () => { circuit.set(p.comp, p.field, ctl.value); solve(); });
    } else {
      ctl = h('input', { type: 'range', min: p.log ? 0 : p.min, max: p.log ? 1000 : p.max, step: p.log ? 1 : p.step, value: toSlider(p, comp[p.field]) });
      ctl.addEventListener('input', () => { circuit.set(p.comp, p.field, fromSlider(p, +ctl.value)); show(); solve(); });
    }
    show();
    paramHost.append(h('div', { class: 'param' }, h('div', { class: 'row between' }, h('label', {}, p.label, fromDoc.has(p.key) ? h('span', { class: 'chip tiny' }, 'from doc') : null), val), ctl));
  }

  const onSwitch = (c, v) => {
    if (c.radio) {
      for (const o of circuit.components) if (o.radio === c.radio) o.closed = o.id === c.id;
    } else circuit.set(c.id, 'closed', v);
    // keep def components in sync for the renderer (it reads c.closed)
    for (const d of def.components) { const cc = circuit.get(d.id); if (cc && 'closed' in cc) d.closed = cc.closed; }
    solve();
  };
  // renderer reads values from the circuit copies
  const view = renderSchematic(schHost, { ...def, components: circuit.components }, circuit, { onSwitch: (c, v) => onSwitch(c, v) });

  const readRows = def.readouts.map((r) => {
    const v = h('b', {});
    readHost.append(h('div', { class: 'readout' }, h('span', {}, r.label), v));
    return { r, v };
  });

  let result = null;
  function solve() {
    if (!def.transient) {
      result = circuit.step();
      renderReadouts();
    }
  }
  function renderReadouts() {
    if (!result) return;
    if (result.error) { readHost.querySelectorAll('b').forEach((b) => { b.textContent = '—'; }); return; }
    for (const { r, v } of readRows) {
      let val;
      if (r.calc) val = r.calc(result, circuit);
      else if (r.node) val = result.nodeV[r.node];
      else {
        const cr = result.comp[r.comp];
        val = cr ? cr[r.q] : undefined;
      }
      if (r.map) v.textContent = r.map(val);
      else if (typeof val === 'string') v.textContent = val;
      else if (r.raw) v.textContent = isNaN(val) ? '—' : `${(+val).toFixed(1)} ${r.unit}`;
      else v.textContent = fmt(r.q === 'i' || r.q === 'ib' ? Math.abs(val) : val, r.unit);
      const cr = r.comp && result.comp[r.comp];
      v.classList.toggle('warn', !!(cr && cr.overcurrent));
    }
  }

  // transient + scope
  const trace = [];
  let running = true;
  if (playBtn) playBtn.addEventListener('click', () => { running = !running; playBtn.textContent = running ? '⏸ Pause' : '▶ Play'; });
  let raf = 0;
  let last = performance.now();
  const tau = () => {
    const R = circuit.get('R1') ? circuit.get('R1').R : 1000;
    const C = circuit.get('C1') ? circuit.get('C1').C : 1e-6;
    return R * C;
  };
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dtReal = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (def.transient && running) {
      const T = tau();
      const rate = tbSel.value === 'real' ? 1 : tbSel.value === 'slow' ? 0.1 : (5 * T) / 4; // sim seconds per real second
      const simDt = dtReal * rate;
      const h0 = T / 200;
      const steps = Math.max(1, Math.min(400, Math.ceil(simDt / h0)));
      for (let i = 0; i < steps; i++) result = circuit.step(simDt / steps);
      const vals = def.scope.map((s) => (s.node ? result.nodeV[s.node] || 0 : (result.comp[s.comp][s.q] || 0) * (s.scale || 1)));
      trace.push({ t: circuit.time, vals });
      const window = (tbSel.value === 'auto' ? 10 * T : tbSel.value === 'real' ? Math.max(10 * T, 2) : Math.max(10 * T, 0.2));
      while (trace.length && trace[0].t < circuit.time - window) trace.shift();
      drawScope(window, T);
      renderReadouts();
    }
    view.update(result, dtReal);
  }

  function drawScope(windowS, T) {
    const c = scopeCanvas;
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--scope-bg') || '#0b1220';
    g.fillRect(0, 0, W, H);
    const vmax = Math.max(1, circuit.get('V1').V) * 1.1;
    const vmin = -vmax * 0.15;
    const y = (v) => H - 20 - ((v - vmin) / (vmax - vmin)) * (H - 30);
    g.strokeStyle = 'rgba(120,160,255,0.15)';
    g.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { const x = (i / 10) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let v = 0; v <= vmax; v += Math.max(0.5, Math.round(vmax / 6))) { g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillStyle = 'rgba(200,210,255,0.6)'; g.font = '11px monospace'; g.fillText(v.toFixed(1) + 'V', 4, y(v) - 2); }
    g.fillStyle = 'rgba(200,210,255,0.7)';
    g.fillText(`${fmt(windowS / 10, 's')}/div · τ = ${fmt(T, 's')}`, W - 190, 14);
    if (!trace.length) return;
    const t0 = circuit.time - windowS;
    def.scope.forEach((s, k) => {
      g.strokeStyle = s.color;
      g.lineWidth = 2;
      g.beginPath();
      trace.forEach((p, i) => {
        const x = ((p.t - t0) / windowS) * W;
        if (i) g.lineTo(x, y(p.vals[k])); else g.moveTo(x, y(p.vals[k]));
      });
      g.stroke();
    });
    // 63% marker
    const v63 = circuit.get('V1').V * 0.632;
    g.setLineDash([4, 4]);
    g.strokeStyle = 'rgba(255,159,28,0.5)';
    g.beginPath(); g.moveTo(0, y(v63)); g.lineTo(W, y(v63)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,159,28,0.8)';
    g.fillText('63 %', W - 40, y(v63) - 3);
  }

  solve();
  raf = requestAnimationFrame(frame);
  return { destroy() { cancelAnimationFrame(raf); } };
}
