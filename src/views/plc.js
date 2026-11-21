import { h, clear, toast, prompt, modal } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { db, uid } from '../core/db.js';
import { bus } from '../core/bus.js';
import { getTheme } from '../core/theme.js';
import { getScenario } from '../scenarios/index.js';
import { PlcRuntime } from '../plc/runtime.js';
import { emptyLadder } from '../plc/ladder.js';
import { World } from '../three/world.js';
import { codeEditor } from '../ui/code-editor.js';
import { ladderEditor } from '../ui/ladder-editor.js';
import { ioPanel } from '../ui/io-panel.js';
import { getDoc } from '../docs/store.js';
import { parseLaunch } from './launch.js';
import { loadEmbed, saveDraft, discardDraft, applyEmbed, stable } from '../docs/embeds.js';
import { leaveDialog, finishTransition, coverWith } from './embed-ui.js';
import { worldSnapshot, plcTable } from '../scenarios/snapshot.js';

const SCAN_S = 0.02; // 20 ms scan cycle (simulated time)
const clone = (o) => JSON.parse(JSON.stringify(o));

export async function plcView(root, id, q = {}) {
  const scn = getScenario(id);
  clear(root);
  if (!scn) { root.append(h('div', { class: 'page' }, h('h2', {}, 'Unknown scenario'), h('a', { href: '#/lab' }, 'Back to lab'))); return; }
  document.getElementById('crumb').textContent = `Lab › ${scn.name}`;
  const launch = parseLaunch(q);
  const doc = launch.docId ? await getDoc(launch.docId) : null;
  // opened from an object embedded in a document: work on that instance, not on the lab copy
  const emb = q.embed ? await loadEmbed(q.doc, +q.page, q.obj) : null;

  // ---- parameters (defaults ← document) ---------------------------------
  const params = {};
  const fromDoc = new Set();
  for (const p of scn.params) params[p.key] = p.default;
  for (const [k, v] of Object.entries(launch.params || {})) {
    if (k in params) { params[k] = v; fromDoc.add(k); }
  }
  if (emb) Object.assign(params, emb.state.params || {});

  // ---- runtime -----------------------------------------------------------
  const rt = new PlcRuntime(scn.io);
  const io = { get: (n) => rt.inputs[n], set: (n, v) => rt.setInput(n, v), out: (n) => rt.getOutput(n) };
  const applySetpoints = () => {
    for (const p of scn.params) if (p.input) rt.setInput(p.input, params[p.key] * (p.scale || 1));
  };

  // ---- program state ------------------------------------------------------
  let program = null; // {id?, name, lang, source}
  const AUTOSAVE = 'autosave_' + scn.id;
  if (emb) program = { name: emb.state.program.name || 'Embedded program', lang: emb.state.program.lang, source: clone(emb.state.program.source) };
  else if (q.program) {
    const saved = await db.get('programs', q.program);
    if (saved) program = { id: saved.id, name: saved.name, lang: saved.lang, source: saved.source };
  }
  if (!program) {
    const auto = await db.get('programs', AUTOSAVE);
    if (auto && auto.source) {
      program = { name: auto.name || 'Working copy', lang: auto.lang, source: auto.source };
      setTimeout(() => toast('Restored your last working copy (Program ▾ → Solution to reset)', 'info', 4000), 300);
    } else program = { name: 'Solution', lang: scn.programs.solution.lang, source: clone(scn.programs.solution.source) };
  }

  // ---- layout -------------------------------------------------------------
  const viewport = h('div', { class: 'viewport' });
  const hud = h('div', { class: 'hud' });
  const tip = h('div', { class: 'hover-tip' });
  const crosshair = h('div', { class: 'crosshair' });
  const fpsHelp = h('div', { class: 'fps-help' }, 'WASD / arrows: walk · Shift: run · Mouse: look (click to capture, Esc to release) · Click: operate buttons · C: overview camera');
  const cpuBadge = h('span', { class: 'cpu stop' }, 'STOP');
  viewport.append(hud, tip, crosshair, fpsHelp);

  const runBtn = h('button', { class: 'btn primary', title: 'Compile, download & RUN (Ctrl+Enter)' }, '▶ Run');
  const stopBtn = h('button', { class: 'btn', title: 'PLC to STOP (outputs off)' }, '■ Stop');
  const stepBtn = h('button', { class: 'btn', title: 'Single scan (while stopped)' }, '⏭ Scan');
  const resetBtn = h('button', { class: 'btn', title: 'Reset process and PLC memory' }, '⟲ Reset');
  const speedSel = h('select', { class: 'input slim', title: 'Simulation speed' }, [0.25, 0.5, 1, 2, 4].map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
  const camBtn = h('button', { class: 'btn', title: 'Toggle camera (C)' }, '🚶 First person');
  const progLabel = h('span', { class: 'prog-name' });
  const progMenuBtn = h('button', { class: 'btn' }, 'Program ▾');
  const saveBtn = h('button', { class: 'btn' }, '💾 Save');

  const embBannerEl = h('span', { class: 'embed-banner' });
  function embBanner() {
    if (!emb) return;
    const d = embedDirty();
    embBannerEl.textContent = d ? 'Embedded · unapplied changes' : 'Embedded in document';
    embBannerEl.classList.toggle('dirty', d);
  }
  async function leaveEmbed() {
    clearTimeout(saveWorking.t);
    let objId = emb.ref.objId;
    const snap = worldSnapshot(world);
    if (embedDirty()) {
      const choice = await leaveDialog(emb.meta.name);
      if (!choice) return;
      if (choice === 'discard') await discardDraft(emb.ref);
      else {
        const r = await applyEmbed(emb.ref, { state: embedState(), snapshot: snap.dataUrl, imgW: snap.width, imgH: snap.height, table: plcTable(sim) }, choice);
        objId = r.id;
        toast(choice === 'apply' ? `Applied to the document${r.others ? ` and ${r.others} linked place(s)` : ''}` : 'Saved as a new version in the document', 'ok');
      }
    } else await discardDraft(emb.ref);
    coverWith(snap.dataUrl);
    navigate(`/doc/${emb.ref.docId}?back=1&obj=${encodeURIComponent(objId)}`);
  }

  const toolbar = h('div', { class: 'toolbar' },
    emb ? h('button', { class: 'btn ghost', id: 'embed-back', onclick: () => leaveEmbed() }, `← Back to ${emb.meta.name}`)
      : doc ? h('a', { class: 'btn ghost', href: `#/doc/${doc.id}${launch.page != null ? '?page=' + launch.page : ''}` }, `← ${doc.name}`) : h('a', { class: 'btn ghost', href: '#/lab' }, '← Lab'),
    emb ? embBannerEl : null,
    h('div', { class: 'tb-title' }, h('span', { class: 'tb-icon' }, scn.icon), h('b', {}, scn.name), h('span', { class: `badge diff-${scn.difficulty.toLowerCase()}` }, scn.difficulty)),
    h('div', { class: 'spacer' }),
    cpuBadge, runBtn, stopBtn, stepBtn, resetBtn, speedSel, camBtn);

  const tabsEl = h('div', { class: 'tabs' });
  const tabBody = h('div', { class: 'tab-body' });
  const console_ = h('div', { class: 'console' });
  const side = h('div', { class: 'side' },
    h('div', { class: 'prog-bar' }, progLabel, h('div', { class: 'spacer' }), progMenuBtn, saveBtn),
    tabsEl, tabBody, console_);
  const resizer = h('div', { class: 'resizer', title: 'Drag to resize' });
  const split = h('div', { class: 'split' }, viewport, resizer, side);
  root.append(h('div', { class: 'plc-view' }, toolbar, split));

  // resizable side panel
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const w = Math.max(320, Math.min(window.innerWidth * 0.7, split.getBoundingClientRect().right - ev.clientX));
      side.style.width = w + 'px';
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ---- 3D world + process sim ---------------------------------------------
  const world = new World(viewport, { theme: getTheme() });
  const sim = scn.build(world, io, params);
  window.__oos = { world, rt, sim }; // handy for debugging from the console
  sim.reset();
  applySetpoints();
  world.onHover = (t) => { tip.textContent = t || ''; tip.style.display = t ? 'block' : 'none'; };
  world.onModeChange = (m) => { camBtn.textContent = m === 'fps' ? '🛰 Overview' : '🚶 First person'; };
  const offTheme = bus.on('theme', (t) => world.setTheme(t));

  // ---- editors ------------------------------------------------------------
  const ioNames = [...scn.io.inputs, ...scn.io.outputs].map((p) => p.name);
  let stEditor = null;
  let ldEditor = null;
  let activeTab = 'program';
  let ioP = null;

  const embedState = () => ({ scenarioId: scn.id, params: { ...params }, program: { name: program.name, lang: program.lang, source: clone(program.source) } });
  const embedDirty = () => !!emb && stable(embedState()) !== stable({ scenarioId: scn.id, params: { ...Object.fromEntries(scn.params.map((p) => [p.key, p.default])), ...(emb.applied.params || {}) }, program: { name: emb.applied.program.name || 'Embedded program', lang: emb.applied.program.lang, source: emb.applied.program.source } });
  function saveWorking() {
    clearTimeout(saveWorking.t);
    if (emb) {
      // changes to an embedded scene are a draft until they are applied to the document
      saveWorking.t = setTimeout(() => { if (embedDirty()) saveDraft(emb.ref, embedState()); else discardDraft(emb.ref); embBanner(); }, 300);
      return;
    }
    saveWorking.t = setTimeout(() => {
      db.put('programs', { id: AUTOSAVE, autosave: true, scenarioId: scn.id, name: program.name, lang: program.lang, source: program.source, updated: Date.now() });
    }, 600);
  }

  function programPane() {
    const pane = h('div', { class: 'prog-pane' });
    const langSw = h('div', { class: 'seg' },
      h('button', { class: program.lang === 'ST' ? 'active' : '', onclick: () => switchLang('ST') }, 'Structured Text'),
      h('button', { class: program.lang === 'LD' ? 'active' : '', onclick: () => switchLang('LD') }, 'Ladder Diagram'));
    pane.append(h('div', { class: 'row between' }, langSw,
      h('div', { class: 'row gap' },
        program.lang === 'LD' ? h('button', { class: 'btn small', onclick: showGenerated }, 'View generated ST') : null,
        h('button', { class: 'btn small primary', onclick: () => compileAndRun(true) }, '⬇ Download & run'))));
    if (program.lang === 'ST') {
      stEditor = codeEditor({ value: program.source, ioNames, onChange: (v) => { program.source = v; saveWorking(); }, onSubmit: () => compileAndRun(true) });
      ldEditor = null;
      pane.append(stEditor.el);
      pane.append(h('div', { class: 'small muted hint' }, 'IEC 61131-3 ST: IF/CASE/FOR/WHILE/REPEAT, TON/TOF/TP, CTU/CTD/CTUD, R_TRIG/F_TRIG, SR/RS, T#… literals. I/O names are pre-declared. Ctrl+Enter = download & run.'));
    } else {
      ldEditor = ladderEditor({ ladder: program.source, names: ioNames, onChange: () => saveWorking() });
      stEditor = null;
      pane.append(ldEditor.el);
      pane.append(h('div', { class: 'small muted hint' }, 'Click a contact symbol to cycle NO / NC / P (rising) / N (falling). Timers & counters: reference their output as T1 or T1.Q, C1.CV …'));
    }
    return pane;
  }

  async function switchLang(lang) {
    if (lang === program.lang) return;
    if (lang === 'ST') {
      let st = '';
      if (program.lang === 'LD') {
        const r = rt.load('LD', program.source);
        st = rt.generatedST || '';
        if (!r.ok && !st) st = '';
      }
      program = { ...program, lang: 'ST', source: st || '(* Structured Text *)\n' };
    } else {
      const ok = await modal('Switch to Ladder?', h('p', {}, 'Structured Text cannot be converted to ladder automatically. Start with an empty ladder (your ST code stays available via Program ▾ → Solution / saved programs)?'), [{ label: 'Cancel', value: null }, { label: 'Empty ladder', value: 'ok', primary: true }]);
      if (!ok) return;
      program = { ...program, lang: 'LD', source: emptyLadder() };
    }
    saveWorking();
    drawTab();
  }

  function showGenerated() {
    rt.load('LD', program.source);
    modal('Generated Structured Text', h('pre', { class: 'gen-st' }, rt.generatedST || '(errors)'), [{ label: 'Close', value: null }]);
  }

  function taskPane() {
    return h('div', { class: 'task-pane' },
      h('p', {}, scn.summary),
      h('h4', {}, 'Objectives'),
      h('ol', {}, scn.objectives.map((o) => h('li', {}, o))),
      h('h4', {}, 'I/O assignment'),
      h('table', { class: 'io-table compact' },
        h('tbody', {}, [...scn.io.inputs.map((p) => ({ ...p, d: 'IN' })), ...scn.io.outputs.map((p) => ({ ...p, d: 'OUT' }))].map((p) =>
          h('tr', {}, h('td', { class: 'addr' }, p.addr), h('td', { class: 'name' }, p.name), h('td', { class: 'small muted' }, `${p.d} · ${p.type || 'BOOL'}`), h('td', { class: 'small' }, p.desc || ''))))),
      h('h4', {}, 'Controls in the 3D scene'),
      h('p', { class: 'small' }, 'Click the push buttons and switches in the scene (or use the I/O tab). In first-person mode aim with the crosshair and click.'));
  }

  function paramsPane() {
    const pane = h('div', { class: 'params-pane' });
    if (doc && fromDoc.size) pane.append(h('div', { class: 'note' }, `📄 ${fromDoc.size} parameter(s) pre-configured from “${doc.name}”.`));
    for (const p of scn.params) {
      const val = h('span', { class: 'pval' });
      const inp = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: params[p.key] });
      const show = () => { val.textContent = `${params[p.key]} ${p.unit}`; };
      inp.addEventListener('input', () => { params[p.key] = +inp.value; show(); applySetpoints(); if (emb) saveWorking(); });
      show();
      pane.append(h('div', { class: 'param' }, h('div', { class: 'row between' }, h('label', {}, p.label, fromDoc.has(p.key) ? h('span', { class: 'chip tiny' }, 'from doc') : null, p.input ? h('span', { class: 'chip tiny' }, `→ ${p.input}`) : null), val), inp));
    }
    pane.append(h('button', { class: 'btn small', onclick: () => { for (const p of scn.params) params[p.key] = p.default; applySetpoints(); drawTab(); if (emb) saveWorking(); } }, 'Restore defaults'));
    return pane;
  }

  function drawTab() {
    clear(tabsEl);
    for (const [k, label] of [['program', '✏️ Program'], ['io', '📟 I/O'], ['params', '🎛 Parameters'], ['task', '📋 Task']]) {
      tabsEl.append(h('button', { class: 'tab' + (activeTab === k ? ' active' : ''), onclick: () => { activeTab = k; drawTab(); } }, label));
    }
    clear(tabBody);
    if (activeTab === 'program') tabBody.append(programPane());
    else if (activeTab === 'io') { ioP = ioPanel(rt, scn); tabBody.append(ioP.el); }
    else if (activeTab === 'params') tabBody.append(paramsPane());
    else tabBody.append(taskPane());
    if (activeTab !== 'io') ioP = null;
    progLabel.textContent = `${program.name}${program.id ? '' : ' (unsaved)'} · ${program.lang === 'LD' ? 'Ladder' : 'ST'}`;
  }

  // ---- console --------------------------------------------------------------
  function log(msg, kind = 'info', line) {
    const row = h('div', { class: 'log ' + kind }, h('span', { class: 'ts' }, new Date().toLocaleTimeString()), msg);
    if (line && stEditor) { row.classList.add('link'); row.addEventListener('click', () => stEditor.goto(line)); }
    console_.prepend(row);
    while (console_.children.length > 40) console_.lastChild.remove();
  }

  // ---- compile / run --------------------------------------------------------
  function compileAndRun(run) {
    const res = rt.load(program.lang, program.source);
    if (stEditor) stEditor.setErrors(res.ok ? [] : res.errors.map((e) => e.line).filter(Boolean));
    if (ldEditor) ldEditor.markErrors(res.ok ? [] : res.errors.map((e) => e.rung).filter((x) => x != null));
    if (!res.ok) {
      for (const e of res.errors) log(e.line ? `Line ${e.line}: ${e.msg}` : e.msg, 'err', e.line);
      setRunning(false);
      if (activeTab !== 'program') { activeTab = 'program'; drawTab(); }
      toast('Compile error – see console', 'err');
      return false;
    }
    applySetpoints();
    log(`Compiled ${program.lang === 'LD' ? 'ladder' : 'ST'} program “${program.name}” – ${rt.program.symbols.size} symbols. Downloaded to PLC.`, 'ok');
    if (ioP) ioP.rebuild();
    if (run) setRunning(true);
    return true;
  }

  function allOutputsOff() {
    for (const p of scn.io.outputs) rt.mem[p.name.toUpperCase()] = p.type && p.type !== 'BOOL' ? 0 : false;
  }

  function setRunning(on) {
    rt.running = on && !!rt.program;
    if (!rt.running) allOutputsOff();
    cpuBadge.textContent = rt.running ? 'RUN' : rt.error ? 'FAULT' : 'STOP';
    cpuBadge.className = 'cpu ' + (rt.running ? 'run' : rt.error ? 'fault' : 'stop');
    runBtn.disabled = rt.running;
    stopBtn.disabled = !rt.running;
    stepBtn.disabled = rt.running;
  }

  runBtn.addEventListener('click', () => compileAndRun(true));
  stopBtn.addEventListener('click', () => { setRunning(false); log('PLC set to STOP'); });
  stepBtn.addEventListener('click', () => {
    if (!rt.program && !compileAndRun(false)) return;
    rt.running = true;
    sim.update(SCAN_S);
    rt.scan(SCAN_S * 1000);
    rt.running = false;
    log(`Single scan #${rt.scanCount} executed`);
  });
  resetBtn.addEventListener('click', () => {
    sim.reset();
    applySetpoints();
    rt.forces = {};
    if (rt.program) rt.resetMemory();
    log('Process and PLC memory reset');
  });
  camBtn.addEventListener('click', () => world.setMode(world.mode === 'fps' ? 'overview' : 'fps'));

  // program menu
  progMenuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const saved = (await db.all('programs')).filter((p) => p.scenarioId === scn.id && !p.autosave);
    const menu = h('div', { class: 'menu' });
    const item = (label, fn) => menu.append(h('button', { onclick: () => { menu.remove(); fn(); } }, label));
    menu.append(h('div', { class: 'menu-h' }, 'Built-in'));
    item('✅ Solution (' + (scn.programs.solution.lang === 'LD' ? 'Ladder' : 'ST') + ')', () => loadProgram({ name: 'Solution', ...clone(scn.programs.solution) }));
    if (scn.programs.alt) item('✅ ' + scn.programs.alt.label, () => loadProgram({ name: scn.programs.alt.label, lang: scn.programs.alt.lang, source: clone(scn.programs.alt.source) }));
    item('📝 Exercise starter', () => loadProgram({ name: 'Exercise', ...clone(scn.programs.starter) }));
    item('🧱 Empty ladder', () => loadProgram({ name: 'New ladder', lang: 'LD', source: emptyLadder() }));
    item('📄 Empty Structured Text', () => loadProgram({ name: 'New program', lang: 'ST', source: 'VAR\nEND_VAR\n\n' }));
    if (saved.length) {
      menu.append(h('div', { class: 'menu-h' }, 'Saved programs'));
      for (const p of saved) item(`💾 ${p.name}`, () => loadProgram({ id: p.id, name: p.name, lang: p.lang, source: clone(p.source) }));
    }
    menu.append(h('div', { class: 'menu-h' }, 'File'));
    item('Save as…', saveAs);
    item('Export program (.json)', () => {
      const blob = new Blob([JSON.stringify({ scenario: scn.id, ...program }, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `${scn.id}-${program.name}.json` });
      a.click();
    });
    item('Import program (.json / .st)', () => {
      const f = h('input', { type: 'file', accept: '.json,.st,.txt' });
      f.addEventListener('change', async () => {
        const txt = await f.files[0].text();
        try {
          if (f.files[0].name.endsWith('.json')) { const o = JSON.parse(txt); loadProgram({ name: o.name || 'Imported', lang: o.lang, source: o.source }); }
          else loadProgram({ name: f.files[0].name.replace(/\.\w+$/, ''), lang: 'ST', source: txt });
        } catch (err) { toast('Invalid program file', 'err'); }
      });
      f.click();
    });
    const r = progMenuBtn.getBoundingClientRect();
    Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(8, r.right - 260) + 'px' });
    document.body.append(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  });

  function loadProgram(p) {
    program = p;
    saveWorking();
    activeTab = 'program';
    drawTab();
    compileAndRun(true);
  }

  async function saveAs() {
    const name = await prompt('Save program as', program.id ? program.name + ' copy' : `${scn.name} – my program`);
    if (!name) return;
    const rec = { id: uid('prog'), scenarioId: scn.id, name, lang: program.lang, source: program.source, updated: Date.now() };
    await db.put('programs', rec);
    program = { ...program, id: rec.id, name };
    drawTab();
    toast('Program saved', 'ok');
  }
  saveBtn.addEventListener('click', async () => {
    if (!program.id) return saveAs();
    await db.put('programs', { id: program.id, scenarioId: scn.id, name: program.name, lang: program.lang, source: program.source, updated: Date.now() });
    toast('Program saved', 'ok');
  });

  // ---- keyboard ----------------------------------------------------------------
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.code === 'KeyC') world.setMode(world.mode === 'fps' ? 'overview' : 'fps');
  };
  window.addEventListener('keydown', onKey);

  // ---- main loop -------------------------------------------------------------
  let acc = 0;
  let uiT = 0;
  world.onUpdate((dt) => {
    acc += dt * +speedSel.value;
    let n = 0;
    while (acc >= SCAN_S && n++ < 60) {
      sim.update(SCAN_S);
      rt.scan(SCAN_S * 1000);
      acc -= SCAN_S;
    }
    if (rt.error) {
      log(`Runtime fault${rt.error.line ? ' at line ' + rt.error.line : ''}: ${rt.error.msg}`, 'err', rt.error.line);
      rt.error = { ...rt.error, logged: true };
      setRunning(false);
      rt.error = null;
      cpuBadge.textContent = 'FAULT';
      cpuBadge.className = 'cpu fault';
    }
    sim.render(dt);
    uiT += dt;
    if (uiT > 0.1) {
      uiT = 0;
      updateHud();
      if (ioP) ioP.update();
      if (ldEditor) ldEditor.setLive(rt.running ? (b, m) => {
        const v = rt.mem[b.toUpperCase()];
        if (v === undefined) return undefined;
        if (m && v && typeof v === 'object') return v[m.toUpperCase()];
        return v;
      } : null);
    }
  });

  function updateHud() {
    const st = sim.status ? sim.status() : [];
    hud.innerHTML = '';
    hud.append(
      h('div', { class: 'hud-row head' }, h('span', {}, `CPU ${rt.running ? 'RUN' : 'STOP'} · scan ${rt.scanCount}`), h('span', {}, `${(rt.lastExecUs / 1000).toFixed(2)} ms`)),
      ...st.map(([k, v]) => h('div', { class: 'hud-row' + (String(v).includes('⚠') || String(v).includes('💥') ? ' warn' : '') }, h('span', {}, k), h('b', {}, v))),
      h('div', { class: 'hud-io' }, scn.io.outputs.map((p) => h('span', { class: 'mini-lamp' + (rt.getOutput(p.name) ? ' on' : ''), title: p.name }, p.name))));
  }

  drawTab();
  setRunning(false);
  world.start();
  compileAndRun(true);
  embBanner();
  requestAnimationFrame(() => finishTransition());

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      offTheme();
      world.dispose();
    },
  };
}
