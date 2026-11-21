// Circuit workbench: the schematic editor plus palette, inspector, measurements,
// problems list and oscilloscope. Works the same for templates and user circuits.
import { h, clear, toast, modal, prompt } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { CircuitEditor, probeColor } from '../circuits/editor.js';
import { Simulation, SPEEDS } from '../circuits/sim.js';
import { PARTS, CATEGORY_ORDER } from '../circuits/parts.js';
import { newCircuit } from '../circuits/model.js';
import { openCircuit, saveCircuit, saveCircuitAs, resetTemplate, isTemplateId, deleteCircuit } from '../circuits/store.js';
import { getCircuit as libraryEntry } from '../circuits/library.js';
import { parseSI, editSI, formatSI } from '../circuits/units.js';
import { getDoc } from '../docs/store.js';
import { parseLaunch } from './launch.js';
import { buildFlowGraph, solveFlow } from '../circuits/flow.js';
import { FlowRenderer, FLOW_DEFAULTS } from '../circuits/particles.js';

const FLOW_KEY = 'oos-flow';
function loadFlowSettings() {
  try { return { ...FLOW_DEFAULTS, ...JSON.parse(localStorage.getItem(FLOW_KEY) || '{}') }; } catch { return { ...FLOW_DEFAULTS }; }
}

/** Build an editing form for a part. Returns {el, valid(), apply()}. */
function partForm(doc, part, { live } = {}) {
  const def = PARTS[part.type];
  const draft = { name: part.name, params: { ...part.params } };
  const errors = new Map();
  const rows = [];
  const el = h('div', { class: 'part-form' });
  const stop = (inp) => inp.addEventListener('keydown', (e) => e.stopPropagation());
  const changed = () => { if (live) live(draft); redrawWhen(); };

  if (!def.noName) {
    const inp = h('input', { class: 'input slim', value: part.name, spellcheck: false });
    stop(inp);
    const msg = h('div', { class: 'field-err' });
    inp.addEventListener('input', () => {
      const v = inp.value.trim();
      const clash = doc.parts.some((p) => p !== part && p.name === v);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) errors.set('name', 'Use letters, digits and _ (e.g. R1).');
      else if (clash) errors.set('name', `"${v}" is already used.`);
      else { errors.delete('name'); draft.name = v; changed(); }
      msg.textContent = errors.get('name') || '';
      inp.classList.toggle('bad', errors.has('name'));
    });
    el.append(h('label', { class: 'field' }, h('span', {}, 'Name'), inp, msg));
  }
  for (const prm of def.params) {
    let inp;
    const msg = h('div', { class: 'field-err' });
    const hint = h('span', { class: 'field-hint' });
    if (prm.type === 'select') {
      inp = h('select', { class: 'input slim' }, prm.options.map((o) => h('option', { value: o, selected: draft.params[prm.key] === o }, o)));
      inp.addEventListener('change', () => { draft.params[prm.key] = inp.value; changed(); });
    } else if (prm.type === 'bool') {
      inp = h('input', { type: 'checkbox', checked: !!draft.params[prm.key] });
      inp.addEventListener('change', () => { draft.params[prm.key] = inp.checked; changed(); });
    } else if (prm.type === 'text') {
      inp = h('input', { class: 'input slim', value: draft.params[prm.key] ?? '', spellcheck: false });
      stop(inp);
      inp.addEventListener('input', () => { draft.params[prm.key] = inp.value.trim(); changed(); });
    } else {
      inp = h('input', { class: 'input slim', value: editSI(draft.params[prm.key]), spellcheck: false, title: 'Engineering notation: 4k7, 100n, 2.2u, 1M, 10m …' });
      stop(inp);
      const show = () => { hint.textContent = errors.has(prm.key) ? '' : `= ${formatSI(draft.params[prm.key], prm.unit)}`; };
      const check = () => {
        const v = parseSI(inp.value);
        if (Number.isNaN(v)) errors.set(prm.key, 'Not a number. Examples: 470, 4k7, 100n, 2.2u, 1e-3');
        else if (prm.min !== undefined && v < prm.min) errors.set(prm.key, `Must be at least ${formatSI(prm.min, prm.unit)}.`);
        else if (prm.max !== undefined && v > prm.max) errors.set(prm.key, `Must be at most ${formatSI(prm.max, prm.unit)}.`);
        else { errors.delete(prm.key); draft.params[prm.key] = v; }
        msg.textContent = errors.get(prm.key) || '';
        inp.classList.toggle('bad', errors.has(prm.key));
        show();
        if (!errors.has(prm.key)) changed();
      };
      inp.addEventListener('input', check);
      show();
      if (prm.slider) {
        const sl = h('input', { type: 'range', min: prm.min, max: prm.max, step: (prm.max - prm.min) / 200, value: draft.params[prm.key] });
        sl.addEventListener('input', () => { inp.value = editSI(+sl.value); check(); });
        rows.push({ prm, row: null, extra: sl });
      }
    }
    const row = h('label', { class: 'field' + (prm.type === 'bool' ? ' inline' : '') }, h('span', {}, prm.label, prm.unit && prm.type !== 'bool' ? h('i', {}, ` [${prm.unit}]`) : null, prm.limit ? h('em', { title: 'Rated limit: exceeding it is shown as an overload' }, ' limit') : null), inp, hint, msg);
    const r = rows.find((x) => x.prm === prm);
    if (r && r.extra) row.append(r.extra);
    rows.push({ prm, row });
    el.append(row);
  }
  function redrawWhen() {
    for (const { prm, row } of rows) if (row && prm.when) row.style.display = prm.when(draft.params) ? '' : 'none';
  }
  redrawWhen();
  return {
    el,
    valid: () => errors.size === 0,
    apply() { if (!def.noName) part.name = draft.name; Object.assign(part.params, draft.params); },
  };
}

export async function circuitView(root, id, q = {}) {
  clear(root);
  const launch = parseLaunch(q);
  const fromDoc = launch.docId ? await getDoc(launch.docId) : null;

  let opened;
  if (id === 'new') {
    const doc = newCircuit('Untitled circuit');
    await saveCircuit(doc);
    navigate('/circuit/' + doc.id);
    return null;
  }
  opened = await openCircuit(id);
  if (!opened) { root.append(h('div', { class: 'page' }, h('h2', {}, 'Circuit not found'), h('a', { href: '#/lab?tab=circuits' }, 'Back to circuits'))); return null; }
  let doc = opened.doc;
  const templateId = isTemplateId(id) ? id : null;
  const lib = templateId ? libraryEntry(templateId) : null;

  // values extracted from a document land on the matching template parts
  const applied = [];
  if (lib && launch.params) {
    for (const prm of lib.params) {
      if (!(prm.key in launch.params)) continue;
      const part = doc.parts.find((p) => p.name === prm.comp);
      if (part && prm.field in part.params) { part.params[prm.field] = launch.params[prm.key]; applied.push(`${prm.comp}.${prm.field}`); }
    }
  }

  document.getElementById('crumb').textContent = `Lab › ${doc.name}`;
  const sim = new Simulation();

  // ---- layout -------------------------------------------------------------------
  const canvasHost = h('div', { class: 'ce-canvas' });
  const statusText = h('span');
  const statusEl = h('div', { class: 'ce-status' }, statusText);
  const palette = h('div', { class: 'ce-palette' });
  const side = h('div', { class: 'ce-side' });
  const scopeCanvas = h('canvas', { class: 'scope', width: 1200, height: 220 });
  const scopeLegend = h('div', { class: 'legend' });
  const scopeWrap = h('div', { class: 'ce-scope' });
  const nameEl = h('input', { class: 'doc-name', value: doc.name, title: 'Circuit name' });
  nameEl.addEventListener('keydown', (e) => e.stopPropagation());
  nameEl.addEventListener('change', () => { doc.name = nameEl.value.trim() || doc.name; editor.commit('rename'); });

  const toolBtns = {};
  const tool = (key, icon, title, arg) => (toolBtns[key] = h('button', { class: 'tool', title, onclick: () => editor.setTool(key, arg) }, icon));
  const undoBtn = h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: () => editor.undo() }, '↶');
  const redoBtn = h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', onclick: () => editor.redo() }, '↷');
  const autoBtn = h('button', { class: 'btn small', title: 'Wire routing: manual corner points, or automatic right-angle legs between clicks' }, 'Routing: manual');
  autoBtn.addEventListener('click', () => { editor.autoRoute = !editor.autoRoute; autoBtn.textContent = editor.autoRoute ? 'Routing: right-angle' : 'Routing: manual'; autoBtn.classList.toggle('active', editor.autoRoute); });
  const runBtn = h('button', { class: 'btn small', title: 'Pause / continue the simulation' }, '⏸ Pause');
  runBtn.addEventListener('click', () => { sim.running = !sim.running; runBtn.textContent = sim.running ? '⏸ Pause' : '▶ Run'; });
  const speedSel = h('select', { class: 'input slim', title: 'Simulated time per real second' }, SPEEDS.map(([v, l]) => h('option', { value: v }, l)));
  speedSel.addEventListener('change', () => { sim.speed = speedSel.value; sim.samples = []; });
  const fileBtn = h('button', { class: 'btn small' }, 'File ▾');
  const flowBtn = h('button', { class: 'btn small', title: 'Current flow animation and overlays' }, '⚡ Flow ▾');
  const legend = h('span', { class: 'ce-legend' });
  const flow = loadFlowSettings();
  const saveFlow = () => { try { localStorage.setItem(FLOW_KEY, JSON.stringify(flow)); } catch { /* ignore */ } };
  const badge = h('span', { class: 'badge' });

  const toolbar = h('div', { class: 'toolbar editor-tb' },
    fromDoc ? h('a', { class: 'btn ghost', href: `#/doc/${fromDoc.id}${launch.page != null ? '?page=' + launch.page : ''}` }, `← ${fromDoc.name}`) : h('a', { class: 'btn ghost', href: '#/lab?tab=circuits' }, '← Circuits'),
    nameEl, badge,
    h('div', { class: 'sep' }),
    h('div', { class: 'tool-group' },
      tool('select', '🖐', 'Select / move (V). Drag a box to select several, Shift adds.'),
      tool('wire', '✏️', 'Draw wire (W)'),
      tool('label', '🏷', 'Net label (L)'),
      tool('probeV', 'V', 'Voltmeter probe'),
      tool('probeA', 'A', 'Ammeter probe'),
      tool('probeR', 'Ω', 'Ohmmeter probe')),
    h('div', { class: 'sep' }),
    h('button', { class: 'icon-btn', title: 'Rotate (R)', onclick: () => editor.rotateSel() }, '⟳'),
    h('button', { class: 'icon-btn', title: 'Mirror (X)', onclick: () => editor.mirrorSel() }, '⇋'),
    h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl+D)', onclick: () => editor.duplicate() }, '⧉'),
    h('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => editor.deleteSel() }, '🗑'),
    undoBtn, redoBtn, autoBtn,
    h('div', { class: 'spacer' }),
    flowBtn, runBtn, speedSel,
    h('button', { class: 'btn small', title: 'Jump to the steady state (capacitors charged)', onclick: () => { sim.settle(); toast('Jumped to the DC operating point'); } }, 'Settle'),
    h('button', { class: 'btn small', title: 'Discharge capacitors, replace fuses, restart time', onclick: () => { sim.restart(); editor.renderAll(); } }, '⟲ Restart'),
    h('button', { class: 'icon-btn', title: 'Zoom out (−)', onclick: () => editor.zoomAt(1 / 1.2) }, '−'),
    h('button', { class: 'icon-btn', title: 'Zoom in (+)', onclick: () => editor.zoomAt(1.2) }, '+'),
    h('button', { class: 'btn small', title: 'Fit to window (F)', onclick: () => editor.fit() }, 'Fit'),
    fileBtn);

  root.append(h('div', { class: 'ce-view' }, toolbar,
    h('div', { class: 'ce-body' }, palette, h('div', { class: 'ce-main' }, canvasHost, statusEl, scopeWrap), side)));

  // ---- palette --------------------------------------------------------------------
  function drawPalette() {
    clear(palette);
    const search = h('input', { class: 'input slim', placeholder: 'Search parts…' });
    search.addEventListener('keydown', (e) => e.stopPropagation());
    const list = h('div', { class: 'ce-pal-list' });
    const fill = () => {
      clear(list);
      const term = search.value.trim().toLowerCase();
      for (const cat of CATEGORY_ORDER) {
        const items = Object.entries(PARTS).filter(([, d]) => d.category === cat && (!term || d.name.toLowerCase().includes(term)));
        if (!items.length) continue;
        list.append(h('div', { class: 'menu-h' }, cat));
        for (const [type, d] of items) {
          const b = h('button', { class: 'ce-pal-item', title: `Place ${d.name}`, onclick: () => editor.setTool('place', type) },
            h('span', { class: 'ce-pal-sym', html: `<svg viewBox="-46 -34 92 68"><g class="ce-part">${d.symbol(Object.fromEntries(d.params.map((p) => [p.key, p.def])), null)}</g></svg>` }),
            h('span', {}, d.name));
          list.append(b);
        }
      }
    };
    search.addEventListener('input', fill);
    palette.append(search, list);
    fill();
  }

  // ---- side panel -------------------------------------------------------------------
  const inspector = h('div', { class: 'card ce-card' });
  const measure = h('div', { class: 'card ce-card' });
  const problems = h('div', { class: 'card ce-card' });
  const info = h('div', { class: 'card ce-card theory' });
  side.append(inspector, problems, measure, info);

  function drawInspector() {
    clear(inspector);
    const sel = [...editor.sel].map((sid) => editor.item(sid)).filter(Boolean);
    if (sel.length === 1 && sel[0].kind === 'part') {
      const part = sel[0].o;
      const def = PARTS[part.type];
      inspector.append(h('div', { class: 'card-h' }, h('b', {}, def.name), h('span', { class: 'small muted' }, 'double-click the part for a dialog')));
      const form = partForm(doc, part, { live: () => { if (form.valid()) { form.apply(); keepInspector = true; editor.commit('value'); keepInspector = false; } } });
      inspector.append(form.el);
      for (const a of def.actions || []) inspector.append(h('button', { class: 'btn small', onclick: () => { a.run(sim, part); editor.renderAll(); } }, a.label));
      if (sim.burned.has(part.id)) inspector.append(h('button', { class: 'btn small primary', onclick: () => { sim.resetPartState(part.id); editor.renderAll(); drawInspector(); } }, 'Replace burned part'));
      return;
    }
    if (sel.length === 1 && sel[0].kind === 'label') {
      const l = sel[0].o;
      const inp = h('input', { class: 'input slim', value: l.text });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => { if (inp.value.trim()) { l.text = inp.value.trim(); editor.commit('label'); } });
      inspector.append(h('div', { class: 'card-h' }, h('b', {}, 'Net label')), h('label', { class: 'field' }, h('span', {}, 'Net name'), inp), h('p', { class: 'small muted' }, 'All wire ends carrying the same name are connected. "GND" or "0" makes the net ground.'));
      return;
    }
    if (sel.length === 1 && sel[0].kind === 'wire') {
      const w = sel[0].o;
      inspector.append(h('div', { class: 'card-h' }, h('b', {}, 'Wire')), h('p', { class: 'small' }, `${w.pts.length} points. Drag the square handles to move corner points, drag a segment to shift it. Double-click a segment to add a corner, double-click a corner to remove it.`));
      return;
    }
    if (sel.length === 1 && sel[0].kind === 'probe') {
      const p = sel[0].o;
      const inp = h('input', { class: 'input slim', value: p.name || '', placeholder: sim.probeLabel(p) });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => { p.name = inp.value.trim(); editor.commit('probe'); });
      inspector.append(h('div', { class: 'card-h' }, h('b', {}, 'Probe')), h('label', { class: 'field' }, h('span', {}, 'Name'), inp));
      return;
    }
    if (sel.length > 1) {
      inspector.append(h('div', { class: 'card-h' }, h('b', {}, `${sel.length} items selected`)), h('p', { class: 'small muted' }, 'Drag to move, R rotates, X mirrors, Del deletes, Ctrl+C / Ctrl+V copies, Ctrl+D duplicates.'));
      return;
    }
    inspector.append(h('div', { class: 'card-h' }, h('b', {}, 'Circuit')),
      h('p', { class: 'small' }, `${doc.parts.filter((p) => p.type !== 'GND').length} parts · ${doc.wires.length} wires · ${doc.probes.length} probes`),
      h('p', { class: 'small muted' }, 'Pick a part on the left and click to place it. Drag from a pin to draw a wire. Hover anything for live values. Hold Alt for free placement off the grid.'));
  }

  function drawProblems() {
    clear(problems);
    const list = sim.diagnostics;
    problems.append(h('div', { class: 'card-h' }, h('b', {}, list.length ? `Problems (${list.length})` : 'Problems'), list.length ? null : h('span', { class: 'small ok-text' }, '✓ none')));
    for (const d of list) {
      problems.append(h('button', { class: `ce-problem ${d.level}`, title: 'Click to select the affected parts', onclick: () => { if (d.parts && d.parts.length) editor.select(d.parts); } },
        h('b', {}, d.level === 'error' ? '⛔ ' : '⚠ '), d.message));
    }
    problems.dataset.sig = sigOf(list);
  }
  const sigOf = (list) => list.map((d) => d.code + (d.parts || []).join(',')).join('|');

  const measureRows = new Map();
  function drawMeasure() {
    clear(measure);
    measureRows.clear();
    measure.append(h('div', { class: 'card-h' }, h('b', {}, 'Measurements'),
      h('div', { class: 'row gap' },
        h('button', { class: 'btn tiny', title: 'Add voltmeter probe', onclick: () => editor.setTool('probeV') }, '+ V'),
        h('button', { class: 'btn tiny', title: 'Add ammeter probe', onclick: () => editor.setTool('probeA') }, '+ A'),
        h('button', { class: 'btn tiny', title: 'Add ohmmeter probe', onclick: () => editor.setTool('probeR') }, '+ Ω'))));
    if (!doc.probes.length) measure.append(h('p', { class: 'small muted' }, 'No probes yet. Add a V, A or Ω probe, or simply hover over the schematic.'));
    for (const p of doc.probes) {
      const val = h('b', {});
      const sc = h('input', { type: 'checkbox', checked: !!p.scope, disabled: p.kind === 'R', title: p.kind === 'R' ? 'Resistance is not shown on the oscilloscope' : 'Show on the oscilloscope (up to 4 channels)' });
      sc.addEventListener('change', () => {
        if (sc.checked && doc.probes.filter((x) => x.scope).length >= 4) { sc.checked = false; toast('The oscilloscope has 4 channels. Untick another probe first.', 'err'); return; }
        p.scope = sc.checked;
        editor.commit('probe');
      });
      measure.append(h('div', { class: 'ce-meas' + (editor.sel.has(p.id) ? ' sel' : ''), onclick: (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') editor.select([p.id]); } },
        h('i', { style: { background: probeColor(doc, p) } }), h('span', { class: 'grow' }, sim.probeLabel(p)), val, sc,
        h('button', { class: 'btn tiny', title: 'Remove probe', onclick: () => { doc.probes = doc.probes.filter((x) => x !== p); editor.commit('probe'); } }, '✕')));
      measureRows.set(p.id, { p, val });
    }
    if (doc.probes.some((p) => p.kind === 'R')) measure.append(h('p', { class: 'small muted' }, 'Ω is measured like a multimeter on a switched-off circuit: sources off, capacitors open, semiconductors not conducting.'));
  }

  function drawInfo() {
    clear(info);
    if (lib) {
      info.append(h('div', { class: 'card-h' }, h('b', {}, 'About this template')), h('p', { class: 'small' }, lib.summary), h('div', { html: lib.theory }));
      if (applied.length && fromDoc) info.append(h('div', { class: 'note' }, `📄 ${applied.length} value(s) taken from “${fromDoc.name}”: ${applied.join(', ')}`));
    } else info.append(h('div', { class: 'card-h' }, h('b', {}, 'Shortcuts')), h('p', { class: 'small' }, 'V select · W wire · L label · R rotate · X mirror · Del delete · Ctrl+C/V/D copy, paste, duplicate · Ctrl+Z/Y undo, redo · F fit · mouse wheel zooms · right or middle drag pans · Alt = off-grid'));
  }

  function drawBadge() {
    badge.textContent = templateId ? (modified ? 'Template · edited copy' : 'Template') : 'My circuit';
    badge.className = 'badge ' + (templateId ? 'diff-intermediate' : 'diff-beginner');
  }

  // ---- part dialog (double-click) ------------------------------------------------------
  async function editPartDialog(part) {
    const def = PARTS[part.type];
    if (!def.params.length && def.noName) return;
    const form = partForm(doc, part);
    const ok = await new Promise((resolve) => {
      const back = h('div', { class: 'modal-back' });
      const close = (v) => { back.remove(); resolve(v); };
      const okBtn = h('button', { class: 'btn primary', onclick: () => { if (form.valid()) close(true); else toast('Fix the fields marked in red first.', 'err'); } }, 'OK');
      back.append(h('div', { class: 'modal' },
        h('div', { class: 'modal-head' }, h('h3', {}, `${def.name}${part.name ? ' ' + part.name : ''}`), h('button', { class: 'icon-btn', onclick: () => close(false) }, '✕')),
        h('div', { class: 'modal-body' }, form.el, h('p', { class: 'small muted' }, 'Values accept SI prefixes: 4k7 = 4.7 kΩ, 100n = 100 nF, 2.2u, 1M, 10m.')),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), okBtn)));
      back.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') okBtn.click(); if (e.key === 'Escape') close(false); e.stopPropagation(); });
      document.body.append(back);
      const first = back.querySelector('input, select');
      if (first) { first.focus(); if (first.select) first.select(); }
    });
    if (ok) { form.apply(); editor.commit('value'); }
  }

  // ---- editor ------------------------------------------------------------------------------
  let modified = opened.modified || applied.length > 0;
  let keepInspector = false; // true while the inspector itself commits a value (keeps focus in the field)
  let saveT = 0;
  const editor = new CircuitEditor(canvasHost, {
    doc, sim,
    onChange: () => {
      modified = true;
      drawBadge();
      clearTimeout(saveT);
      saveT = setTimeout(() => saveCircuit(doc), 400);
      drawMeasure();
      drawProblems();
      document.getElementById('crumb').textContent = `Lab › ${doc.name}`;
    },
    onSelect: () => {
      for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === editor.tool);
      undoBtn.disabled = !editor.undoStack.length;
      redoBtn.disabled = !editor.redoStack.length;
      if (!keepInspector) drawInspector();
      for (const [pid, r] of measureRows) r.val.parentElement.classList.toggle('sel', editor.sel.has(pid));
    },
    onStatus: (t) => { statusText.textContent = t; },
    onEditPart: editPartDialog,
  });
  if (applied.length) saveCircuit(doc);

  // ---- current flow animation --------------------------------------------------------------
  const particles = new FlowRenderer(canvasHost);
  let flowGraph = null;
  let flowNet = null;
  const applyFlow = () => {
    editor.overlay.potential = flow.potential;
    editor.overlay.power = flow.power;
    sim.burnOut = flow.burnOut !== false;
    flowBtn.classList.toggle('active', flow.on);
    saveFlow();
  };
  applyFlow();
  flowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.flow-menu').forEach((m) => m.remove());
    const menu = h('div', { class: 'menu flow-menu' });
    const check = (key, label, hint) => {
      const inp = h('input', { type: 'checkbox', checked: key === 'burnOut' ? flow.burnOut !== false : !!flow[key] });
      inp.addEventListener('change', () => { flow[key] = inp.checked; applyFlow(); });
      return h('label', { class: 'inline' }, inp, h('span', {}, label, hint ? h('div', { class: 'small muted' }, hint) : null));
    };
    const dirSel = h('select', { class: 'input slim' }, h('option', { value: '0', selected: !flow.electron }, 'Conventional current (+ → −)'), h('option', { value: '1', selected: !!flow.electron }, 'Electron flow (− → +)'));
    dirSel.addEventListener('change', () => { flow.electron = dirSel.value === '1'; applyFlow(); });
    const sensLbl = h('span', { class: 'small muted' });
    const sens = h('input', { type: 'range', min: 2, max: 9, step: 0.5, value: flow.sensitivity });
    const showSens = () => { sensLbl.textContent = ` visible from ${formatSI(10 ** -flow.sensitivity, 'A')}`; };
    sens.addEventListener('input', () => { flow.sensitivity = +sens.value; showSens(); applyFlow(); });
    showSens();
    const spd = h('input', { type: 'range', min: 0.2, max: 3, step: 0.1, value: flow.speed });
    spd.addEventListener('input', () => { flow.speed = +spd.value; applyFlow(); });
    menu.append(
      check('on', 'Show moving charges', 'Density and speed grow with the logarithm of the current, so µA and A are both visible.'),
      h('label', {}, 'Direction', dirSel),
      h('label', {}, h('span', {}, 'Sensitivity', sensLbl), sens),
      h('label', {}, 'Animation speed', spd),
      check('potential', 'Colour wires by voltage', 'Blue = lowest, red = highest potential.'),
      check('power', 'Heat glow by power', 'Parts glow from 1 mW (faint) to 10 W (red).'),
      check('burnOut', 'Overloaded parts burn out', 'A part at twice its rating for about a second is destroyed until you replace it.'));
    const r = flowBtn.getBoundingClientRect();
    Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(8, r.left - 80) + 'px' });
    document.body.append(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  });

  // ---- file menu ------------------------------------------------------------------------------
  fileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.ce-file').forEach((m) => m.remove());
    const menu = h('div', { class: 'menu ce-file' });
    const item = (label, fn) => menu.append(h('button', { onclick: () => { menu.remove(); fn(); } }, label));
    item('📄 New empty circuit', () => navigate('/circuit/new'));
    item('💾 Save as…', async () => {
      const name = await prompt('Save circuit as', templateId ? `${doc.name} (my version)` : `${doc.name} copy`);
      if (!name) return;
      const copy = await saveCircuitAs(doc, name);
      toast('Saved as a new circuit', 'ok');
      navigate('/circuit/' + copy.id);
    });
    if (templateId) {
      item('↺ Reset to template', async () => {
        const ok = await modal('Reset to template?', h('p', {}, 'Your changes to this template copy are discarded and the original circuit is restored. Use “Save as…” first if you want to keep them.'), [{ label: 'Cancel', value: null }, { label: 'Reset', value: 'ok', primary: true }]);
        if (!ok) return;
        clearTimeout(saveT);
        doc = await resetTemplate(templateId);
        modified = false;
        editor.setDoc(doc, { resetHistory: true, fit: true });
        nameEl.value = doc.name;
        drawAll();
        toast('Template restored', 'ok');
      });
    } else {
      item('🗑 Delete this circuit', async () => {
        const ok = await modal('Delete circuit?', h('p', {}, `“${doc.name}” is removed from this app.`), [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }]);
        if (!ok) return;
        clearTimeout(saveT);
        await deleteCircuit(doc.id);
        navigate('/lab?tab=circuits');
      });
    }
    item('⬇ Export circuit (.json)', async () => {
      const { platform } = await import('../platform/index.js');
      platform.saveFile(`${doc.name}.circuit.json`, JSON.stringify(doc, null, 2), { mime: 'application/json', filters: [{ name: 'Circuit', extensions: ['json'] }] });
    });
    item('⬆ Import circuit (.json)…', async () => {
      const { platform } = await import('../platform/index.js');
      const [f] = await platform.pickFiles({ accept: '.json', filters: [{ name: 'Circuit', extensions: ['json'] }] });
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        if (obj.kind !== 'circuit') throw new Error('not a circuit file');
        const copy = await saveCircuitAs(obj, obj.name || 'Imported circuit');
        navigate('/circuit/' + copy.id);
      } catch (err) { toast('Could not import: ' + err.message, 'err', 5000); }
    });
    const r = fileBtn.getBoundingClientRect();
    Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(8, r.right - 260) + 'px' });
    document.body.append(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  });

  // ---- oscilloscope -----------------------------------------------------------------------------
  function drawScope() {
    const chans = doc.probes.filter((p) => p.scope && p.kind !== 'R').slice(0, 4);
    scopeWrap.style.display = chans.length ? '' : 'none';
    if (!chans.length) return;
    if (!scopeWrap.firstChild) {
      scopeWrap.append(h('div', { class: 'card-h' }, h('b', {}, 'Oscilloscope'), scopeLegend, h('button', { class: 'btn tiny', onclick: () => { sim.samples = []; } }, 'Clear')), scopeCanvas);
    }
    const g = scopeCanvas.getContext('2d');
    const W = scopeCanvas.width;
    const H = scopeCanvas.height;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--scope-bg') || '#0b1220';
    g.fillRect(0, 0, W, H);
    const s = sim.samples;
    const win = sim.window || 1;
    const tEnd = sim.circuit ? sim.circuit.time : 0;
    const t0 = tEnd - win;
    // one vertical scale per unit (V on the left, A on the right)
    const range = { V: [0, 0], A: [0, 0] };
    for (const smp of s) for (const p of chans) { const v = smp.v[p.id]; if (v == null) continue; const r = range[p.kind]; if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v; }
    for (const k of ['V', 'A']) {
      const r = range[k];
      const span = Math.max(r[1] - r[0], k === 'V' ? 1e-3 : 1e-6);
      r[0] -= span * 0.08; r[1] += span * 0.08;
    }
    const y = (v, k) => H - 6 - ((v - range[k][0]) / (range[k][1] - range[k][0])) * (H - 12);
    g.strokeStyle = 'rgba(120,160,255,0.16)';
    g.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { const x = (i / 10) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let i = 0; i <= 4; i++) { const yy = (i / 4) * H; g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); }
    g.font = '11px monospace';
    g.fillStyle = 'rgba(200,210,255,0.75)';
    if (chans.some((p) => p.kind === 'V')) { g.fillText(formatSI(range.V[1], 'V'), 4, 12); g.fillText(formatSI(range.V[0], 'V'), 4, H - 4); if (range.V[0] < 0 && range.V[1] > 0) { g.strokeStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.moveTo(0, y(0, 'V')); g.lineTo(W, y(0, 'V')); g.stroke(); } }
    if (chans.some((p) => p.kind === 'A')) { g.textAlign = 'right'; g.fillText(formatSI(range.A[1], 'A'), W - 4, 12); g.fillText(formatSI(range.A[0], 'A'), W - 4, H - 4); g.textAlign = 'left'; }
    g.textAlign = 'center';
    g.fillText(`${formatSI(win / 10, 's')}/div`, W / 2, 12);
    g.textAlign = 'left';
    for (const p of chans) {
      g.strokeStyle = probeColor(doc, p);
      g.lineWidth = 2;
      g.beginPath();
      let first = true;
      for (const smp of s) {
        if (smp.t < t0) continue;
        const v = smp.v[p.id];
        if (v == null) continue;
        const x = ((smp.t - t0) / win) * W;
        if (first) { g.moveTo(x, y(v, p.kind)); first = false; } else g.lineTo(x, y(v, p.kind));
      }
      g.stroke();
    }
    const sig = chans.map((p) => p.id + sim.probeLabel(p)).join();
    if (scopeLegend.dataset.sig !== sig) {
      scopeLegend.dataset.sig = sig;
      clear(scopeLegend);
      for (const p of chans) scopeLegend.append(h('span', {}, h('i', { style: { background: probeColor(doc, p) } }), sim.probeLabel(p)));
    }
  }

  function drawAll() {
    drawBadge();
    drawPalette();
    drawInspector();
    drawProblems();
    drawMeasure();
    drawInfo();
  }
  drawAll();
  editor.setTool('select');

  // ---- frame loop ----------------------------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let uiT = 0;
  let lastErrSig = '';
  const stats = { ms: 0, frames: 0 }; // smoothed work time per frame (simulation + drawing)
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const now0 = performance.now();
    sim.updateWindow();
    sim.tick(dt);
    editor.refreshLive();
    if (flowNet !== sim.net) { flowNet = sim.net; flowGraph = buildFlowGraph(doc); }
    if (flow.on) solveFlow(flowGraph, sim.net, sim.result);
    particles.draw(flowGraph.items, editor, sim.running ? dt : 0, flow);
    stats.ms += (performance.now() - now0 - stats.ms) * 0.05;
    stats.frames++;
    uiT += dt;
    if (uiT > 0.12) {
      uiT = 0;
      for (const { p, val } of measureRows.values()) {
        const v = sim.probeValue(p);
        val.textContent = v == null ? '—' : formatSI(v, { V: 'V', A: 'A', R: 'Ω' }[p.kind]);
      }
      if (flow.potential && editor.potentialRange) {
        const [lo, hi] = editor.potentialRange;
        const txt = `${formatSI(lo, 'V')}|${formatSI(hi, 'V')}`;
        if (legend.dataset.t !== txt) { legend.dataset.t = txt; clear(legend); legend.append(txt.split('|')[0], h('i'), txt.split('|')[1]); }
      } else if (legend.dataset.t) { legend.dataset.t = ''; clear(legend); }
      const sig = sigOf(sim.diagnostics);
      if (sig !== lastErrSig) { lastErrSig = sig; drawProblems(); editor.renderAll(); }
    }
    drawScope();
  }
  raf = requestAnimationFrame(frame);
  statusEl.append(legend);
  window.__ce = { editor, sim, particles, flow, stats, get flowGraph() { return flowGraph; }, get doc() { return doc; } }; // handy for debugging from the console

  return {
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(saveT);
      if (modified) saveCircuit(doc);
      particles.destroy();
      editor.destroy();
      document.querySelectorAll('.menu.ce-file, .menu.flow-menu').forEach((m) => m.remove());
    },
  };
}
