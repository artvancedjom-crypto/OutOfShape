// Plant workbench: build a plant from kit elements in 3D, program it, and test it.
// Used for the built-in templates, for the user's own plants and for plants that
// are embedded in documents.
import { h, clear, toast, prompt, modal } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { bus } from '../core/bus.js';
import { getTheme } from '../core/theme.js';
import { platform } from '../platform/index.js';
import { PlcRuntime } from '../plc/runtime.js';
import { emptyLadder } from '../plc/ladder.js';
import { formatTime } from '../plc/st-lexer.js';
import { codeEditor } from '../ui/code-editor.js';
import { ladderEditor } from '../ui/ladder-editor.js';
import { KIT, KIT_CATEGORIES, FAULTS, faultClass, RAW } from '../kit/elements.js';
import { KitSim } from '../kit/sim.js';
import { Stage } from '../kit/stage.js';
import { plcIo, ioList, allocateIO, tagProblem, addressProblem, renameTag, loadScene, TAG_RE } from '../kit/model.js';
import { openScene, saveScene, saveSceneAs, resetSceneTemplate, isSceneTemplate, deleteScene, createScene } from '../kit/store.js';
import { sceneTemplate, templateScene, applyDocParams } from '../kit/templates.js';
import { GROUPS, makeGroupEntry, saveKitEntry, deleteKitEntry, listKitEntries, exportKitEntries, isBuiltinKit, LOOK_SHAPES, LOOK_COLORS, ensureKitCatalog, registerSceneDefs, kitDefsUsedBy } from '../kit/catalog.js';
import { importEntries } from '../circuits/catalog.js';
import { getDoc } from '../docs/store.js';
import { parseLaunch } from './launch.js';
import { loadEmbed, saveDraft, discardDraft, applyEmbed, stable } from '../docs/embeds.js';
import { leaveDialog, finishTransition, coverWith } from './embed-ui.js';

const SCAN = 0.02;
const clone = (o) => JSON.parse(JSON.stringify(o));
const stopKeys = (el) => { el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
const TRACE_COLORS = ['#2ec4b6', '#ff9f1c', '#e71d36', '#9b5de5', '#00bbf9', '#8ac926', '#f15bb5', '#ffca3a'];

export async function sceneView(root, id, q = {}) {
  clear(root);
  const launch = parseLaunch(q);
  const fromDoc = launch.docId ? await getDoc(launch.docId) : null;
  await ensureKitCatalog();

  if (id === 'new') { const d = await createScene(); navigate('/plc/' + d.id); return null; }
  // ---- which plant? ---------------------------------------------------------------
  let emb = null;
  let embBaseline = '';
  let opened;
  if (id === 'embed') {
    emb = await loadEmbed(q.doc, +q.page, q.obj);
    if (emb) {
      // objects embedded by version 1.1 only stored a scenario id: open the matching template
      const conv = (s) => (s && s.kind === 'scene' ? s : templateScene((s && s.scenarioId) || 'motor'));
      registerSceneDefs(emb.state);
      opened = { doc: loadScene(conv(emb.state)), modified: false };
      embBaseline = stable(loadScene(conv(emb.applied)));
    }
  } else opened = await openScene(id);
  if (!opened) { root.append(h('div', { class: 'page' }, h('h2', {}, 'Plant not found'), h('a', { href: '#/lab' }, 'Back to the lab'))); return null; }
  let doc = opened.doc;
  const templateId = isSceneTemplate(id) ? id : null;
  const tpl = templateId ? sceneTemplate(templateId) : null;
  const applied = tpl && launch.params ? applyDocParams(doc, templateId, launch.params) : [];
  let modified = opened.modified || applied.length > 0;
  document.getElementById('crumb').textContent = `Lab › ${doc.name}`;

  // ---- PLC + process --------------------------------------------------------------
  let rt = new PlcRuntime(plcIo(doc));
  const io = { out: (t) => rt.getOutput(t), set: (t, v) => rt.setInput(t, v) };
  let sim = new KitSim(doc, io);
  let ioSig = '';
  const sigOf = () => ioList(doc).map((r) => `${r.name}:${r.type}:${r.dir}`).join('|');

  // ---- layout -----------------------------------------------------------------------
  const viewport = h('div', { class: 'viewport' });
  const hud = h('div', { class: 'hud' });
  const crosshair = h('div', { class: 'crosshair' });
  const fpsHelp = h('div', { class: 'fps-help' }, 'WASD / arrows: walk · Shift: run · mouse: look (click to capture, Esc to release) · click: operate buttons · C: overview');
  viewport.append(hud, crosshair, fpsHelp);
  const statusEl = h('div', { class: 'ce-status' });
  const palette = h('div', { class: 'ce-palette kit-palette' });
  const tabsEl = h('div', { class: 'tabs' });
  const tabBody = h('div', { class: 'tab-body' });
  const consoleEl = h('div', { class: 'console' });
  const side = h('div', { class: 'side' }, tabsEl, tabBody, consoleEl);
  const resizer = h('div', { class: 'resizer' });
  const nameEl = stopKeys(h('input', { class: 'doc-name', value: doc.name, title: 'Plant name' }));
  nameEl.addEventListener('change', () => { doc.name = nameEl.value.trim() || doc.name; persist(); });
  const badge = h('span', { class: 'badge' });
  const cpu = h('span', { class: 'cpu stop', id: 'cpu-state' }, 'STOP');
  const forcedBadge = h('span', { class: 'cpu fault', id: 'forced-badge', style: { display: 'none' }, title: 'At least one signal is forced' }, 'FORCED');
  const buildBtn = h('button', { title: 'Build mode (B): place, move, rotate, delete' }, '🔨 Build');
  const operateBtn = h('button', { title: 'Operate mode (B): click buttons and switches in the scene' }, '▶ Operate');
  const runBtn = h('button', { class: 'btn small primary', title: 'Compile, download and run the program (Ctrl+Enter)' }, '▶ Run');
  const stopBtn = h('button', { class: 'btn small', title: 'PLC to STOP: all outputs off' }, '■ Stop');
  const resetBtn = h('button', { class: 'btn small', title: 'Clear workpieces, tank levels and PLC memory' }, '⟲ Reset');
  const speedSel = h('select', { class: 'input slim', title: 'Simulation speed' }, [0.25, 0.5, 1, 2, 4].map((s) => h('option', { value: s, selected: s === 1 }, `${s}×`)));
  const camBtn = h('button', { class: 'btn small', title: 'First person / overview (C)' }, '🚶 Walk');
  const undoBtn = h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)' }, '↶');
  const redoBtn = h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)' }, '↷');
  const fileBtn = h('button', { class: 'btn small' }, 'File ▾');
  const viewBtn = h('button', { class: 'btn small', title: 'Names and wiring' }, 'View ▾');
  const embBannerEl = h('span', { class: 'embed-banner' });

  const toolbar = h('div', { class: 'toolbar editor-tb' },
    emb ? h('button', { class: 'btn ghost', id: 'embed-back', onclick: () => leaveEmbed() }, `← Back to ${emb.meta.name}`)
      : fromDoc ? h('a', { class: 'btn ghost', href: `#/doc/${fromDoc.id}${launch.page != null ? '?page=' + launch.page : ''}` }, `← ${fromDoc.name}`) : h('a', { class: 'btn ghost', href: '#/lab' }, '← Lab'),
    nameEl, badge, emb ? embBannerEl : null,
    h('div', { class: 'sep' }), h('div', { class: 'seg' }, buildBtn, operateBtn),
    h('button', { class: 'icon-btn', title: 'Rotate (R)', onclick: () => stage.rotate() }, '⟳'),
    h('button', { class: 'icon-btn', title: 'Duplicate (Ctrl+D)', onclick: () => stage.duplicate() }, '⧉'),
    h('button', { class: 'icon-btn', title: 'Delete (Del)', onclick: () => stage.remove() }, '🗑'),
    undoBtn, redoBtn,
    h('div', { class: 'spacer' }),
    forcedBadge, cpu, runBtn, stopBtn, resetBtn, speedSel, camBtn, viewBtn, fileBtn);
  root.append(h('div', { class: 'ce-view kit-view' }, toolbar,
    h('div', { class: 'ce-body' }, palette, h('div', { class: 'ce-main' }, viewport, statusEl), resizer, side)));
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => { side.style.width = Math.max(320, Math.min(window.innerWidth * 0.6, side.getBoundingClientRect().right - ev.clientX)) + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ---- stage --------------------------------------------------------------------------
  const stage = new Stage(viewport, {
    doc, getSim: () => sim, theme: getTheme(),
    onChange: (reason) => { rebuild(reason); persist(); refreshButtons(); if (active === 'io' || active === 'element' || active === 'watch') redrawSoon(); },
    onSelect: () => { refreshButtons(); if (active === 'element') redrawSoon(); else if (stage.sel.size === 1 && !stage.tool && autoInspect) { active = 'element'; redrawSoon(); } },
    onStatus: (msg) => { if (msg) toast(msg, 'err', 2500); showStatus(); },
  });
  let autoInspect = true;
  const offTheme = bus.on('theme', (t) => stage.world.setTheme(t));

  function log(msg, kind = 'info', line) {
    const row = h('div', { class: 'log ' + kind }, h('span', { class: 'ts' }, new Date().toLocaleTimeString()), msg);
    if (line && stEditor) { row.classList.add('link'); row.addEventListener('click', () => stEditor.goto(line)); }
    consoleEl.prepend(row);
    while (consoleEl.children.length > 40) consoleEl.lastChild.remove();
  }

  // ---- program / runtime -----------------------------------------------------------------
  let stEditor = null;
  let ldEditor = null;
  function compile(run = true, quiet = false) {
    const res = rt.load(doc.program.lang, doc.program.source);
    if (stEditor) stEditor.setErrors(res.ok ? [] : res.errors.map((e) => e.line).filter(Boolean));
    if (ldEditor) ldEditor.markErrors(res.ok ? [] : res.errors.map((e) => e.rung).filter((x) => x != null));
    if (!res.ok) {
      for (const e of res.errors) log(e.line ? `Line ${e.line}: ${e.msg}` : e.msg, 'err', e.line);
      setRunning(false);
      if (!quiet) toast('The program has an error – see the messages below it', 'err');
      return false;
    }
    if (!quiet) log(`Program compiled (${rt.program.symbols.size} symbols) and downloaded.`, 'ok');
    if (run) setRunning(true);
    return true;
  }
  function setRunning(on) {
    rt.running = on && !!rt.program;
    if (!rt.running) for (const r of ioList(doc)) if (r.dir === 'out') rt.mem[r.name.toUpperCase()] = r.type === 'BOOL' ? false : 0;
    cpu.textContent = rt.running ? 'RUN' : 'STOP';
    cpu.className = 'cpu ' + (rt.running ? 'run' : 'stop');
    runBtn.disabled = rt.running;
    stopBtn.disabled = !rt.running;
  }
  /** After the plant changed: new process model; new PLC image only if the signals changed. */
  function rebuild(reason) {
    const sig = sigOf();
    const wasRunning = rt.running;
    if (sig !== ioSig) {
      ioSig = sig;
      const forces = rt.forces;
      const inputs = rt.inputs;
      rt = new PlcRuntime(plcIo(doc));
      for (const [k, v] of Object.entries(forces)) if (ioList(doc).some((r) => r.name === k)) rt.forces[k] = v;
      for (const k of Object.keys(rt.inputs)) if (k in inputs) rt.inputs[k] = inputs[k];
      if (reason !== 'init') log(`I/O changed: ${ioList(doc).length} signals. Tags are available in the program editor.`);
      const ok = compile(wasRunning || reason === 'init', true);
      if (!ok && reason !== 'init') toast('The program no longer compiles (a tag it uses is gone?)', 'err', 4000);
      if (active === 'program') redrawSoon();
    }
    sim = new KitSim(doc, io, reason === 'init' ? null : sim);
  }

  let saveT = 0;
  const embedDirty = () => !!emb && stable(doc) !== embBaseline;
  function embBanner() {
    if (!emb) return;
    const d = embedDirty();
    embBannerEl.textContent = d ? 'Embedded · unapplied changes' : 'Embedded in document';
    embBannerEl.classList.toggle('dirty', d);
  }
  function persist() {
    modified = true;
    drawBadge();
    clearTimeout(saveT);
    if (emb) { saveT = setTimeout(() => { if (embedDirty()) saveDraft(emb.ref, doc); else discardDraft(emb.ref); }, 300); embBanner(); }
    else saveT = setTimeout(() => saveScene(doc), 500);
    document.getElementById('crumb').textContent = `Lab › ${doc.name}`;
  }
  let leaving = false;
  async function leaveEmbed() {
    clearTimeout(saveT);
    let objId = emb.ref.objId;
    const snap = stage.snapshot();
    if (embedDirty()) {
      const choice = await leaveDialog(emb.meta.name);
      if (!choice) return;
      if (choice === 'discard') await discardDraft(emb.ref);
      else {
        doc.defs = kitDefsUsedBy(doc);
        const r = await applyEmbed(emb.ref, { state: doc, snapshot: snap.dataUrl, imgW: snap.width, imgH: snap.height, table: summaryTable() }, choice);
        objId = r.id;
        toast(choice === 'apply' ? `Applied to the document${r.others ? ` and ${r.others} linked place(s)` : ''}` : 'Saved as a new version in the document', 'ok');
      }
    } else await discardDraft(emb.ref);
    leaving = true;
    coverWith(snap.dataUrl);
    navigate(`/doc/${emb.ref.docId}?back=1&obj=${encodeURIComponent(objId)}`);
  }
  const summaryTable = () => sim.summary().slice(0, 8).map(([label, value]) => ({ label, value: String(value).replace(/[⚠💥]\s*/g, '') }));

  function drawBadge() {
    badge.textContent = emb ? 'Embedded copy' : templateId ? (modified ? 'Template · edited copy' : 'Template') : 'My plant';
    badge.className = 'badge ' + (templateId ? 'diff-intermediate' : 'diff-beginner');
  }
  function refreshButtons() {
    buildBtn.classList.toggle('active', stage.mode === 'build');
    operateBtn.classList.toggle('active', stage.mode === 'operate');
    undoBtn.disabled = !stage.undoStack.length;
    redoBtn.disabled = !stage.redoStack.length;
    camBtn.textContent = stage.world.mode === 'fps' ? '🛰 Overview' : '🚶 Walk';
    for (const b of palette.querySelectorAll('.ce-pal-item')) b.classList.toggle('active', !!stage.tool && (b.dataset.type === (stage.tool.type || '') || b.dataset.group === (stage.tool.group ? stage.tool.group.id : '')));
    showStatus();
  }
  function showStatus() {
    const el = stage.hoverEl;
    if (stage.tool) statusEl.textContent = `Click on the plate to place ${stage.tool.group ? stage.tool.group.name : KIT[stage.tool.type].name}. R rotates, Esc or right-click stops. Green = fits, red = taken.`;
    else if (el) statusEl.textContent = `${el.name} · ${KIT[el.type].name} · ${sim.status(el) || ''}${el.fault ? ' · FAULT: ' + el.fault : ''}`;
    else statusEl.textContent = stage.mode === 'build' ? 'Build mode: pick an element on the left, click to select, drag to move. Shift-click selects several.' : 'Operate mode: click buttons and switches in the scene.';
  }

  // ---- palette ------------------------------------------------------------------------------
  function drawPalette() {
    clear(palette);
    const search = stopKeys(h('input', { class: 'input slim', placeholder: 'Search elements…' }));
    const list = h('div', { class: 'ce-pal-list' });
    const fill = () => {
      clear(list);
      const term = search.value.trim().toLowerCase();
      const all = Object.entries(KIT).filter(([, d]) => !d.removed && (!term || d.name.toLowerCase().includes(term)));
      if (GROUPS.size) {
        const gs = [...GROUPS.values()].filter((g) => !term || g.name.toLowerCase().includes(term));
        if (gs.length) list.append(h('div', { class: 'menu-h' }, 'My groups'));
        for (const g of gs) list.append(h('button', { class: 'ce-pal-item', 'data-group': g.id, title: g.description || `${g.elements.length} elements`, onclick: () => stage.setTool({ group: g }) }, h('span', { class: 'kit-ico' }, '🧩'), h('span', { class: 'grow' }, g.name, h('i', { class: 'ce-mine' }, `${g.elements.length}`))));
      }
      for (const cat of KIT_CATEGORIES) {
        const items = all.filter(([, d]) => d.cat === cat);
        if (!items.length) continue;
        list.append(h('div', { class: 'menu-h' }, cat));
        for (const [type, d] of items) {
          const sig = d.io({ params: Object.fromEntries(d.params.map((p) => [p.key, p.def])) });
          const ins = sig.filter((p) => p.dir === 'in').length; const outs = sig.length - ins;
          list.append(h('button', { class: 'ce-pal-item', 'data-type': type, title: `${d.name}${sig.length ? ` – ${ins} input(s), ${outs} output(s) for the PLC` : ''}`, onclick: () => stage.setTool({ type }) },
            h('span', { class: 'kit-ico' }, ICON[d.base || type] || '▫️'), h('span', { class: 'grow' }, d.name, d.entry ? h('i', { class: 'ce-mine' }, 'mine') : null),
            sig.length ? h('span', { class: 'kit-io' }, `${ins ? ins + 'I' : ''}${ins && outs ? ' ' : ''}${outs ? outs + 'Q' : ''}`) : null));
        }
      }
    };
    search.addEventListener('input', fill);
    palette.append(search, list, h('button', { class: 'btn small', onclick: kitCatalogDialog }, '🧩 My elements…'));
    fill();
  }

  // ---- tabs -----------------------------------------------------------------------------------
  let active = tpl ? 'task' : 'program';
  const watch = { names: [], trace: new Set(), samples: [], paused: false };
  let ioRows = [];
  let watchRows = [];
  let traceCanvas = null;

  // redraw after the current event: the field that triggered the change may still have the focus
  let redrawT = 0;
  function redrawSoon() { clearTimeout(redrawT); redrawT = setTimeout(() => { if (root.isConnected) drawTab(); }, 0); }
  function drawTab() {
    clearTimeout(redrawT);
    clear(tabsEl);
    const tabs = [['program', '✏️ Program'], ['io', '🔌 I/O map'], ['watch', '📈 Watch'], ['element', '🧱 Element'], ...(tpl ? [['task', '📋 Task']] : [])];
    for (const [k, t] of tabs) tabsEl.append(h('button', { class: 'tab' + (active === k ? ' active' : ''), onclick: () => { active = k; autoInspect = k === 'element'; drawTab(); } }, t));
    clear(tabBody);
    stEditor = null; ldEditor = null; ioRows = []; watchRows = []; traceCanvas = null;
    if (active === 'program') tabBody.append(programPane());
    else if (active === 'io') tabBody.append(ioPane());
    else if (active === 'watch') tabBody.append(watchPane());
    else if (active === 'element') tabBody.append(elementPane());
    else tabBody.append(taskPane());
  }

  function programPane() {
    const p = doc.program;
    const tags = ioList(doc).map((r) => r.name);
    const pane = h('div', { class: 'prog-pane' });
    const sw = async (lang) => {
      if (lang === p.lang) return;
      if (lang === 'ST') { rt.load('LD', p.source); doc.program = { ...p, lang: 'ST', source: rt.generatedST || '' }; }
      else {
        const ok = await modal('Switch to ladder?', h('p', {}, 'Structured Text cannot be converted to ladder automatically. Continue with an empty ladder diagram? (Undo is not possible for this step; export the program first if you want to keep it.)'), [{ label: 'Cancel', value: null }, { label: 'Empty ladder', value: 'ok', primary: true }]);
        if (!ok) return;
        doc.program = { ...p, lang: 'LD', source: emptyLadder() };
      }
      persist(); drawTab(); compile(rt.running, true);
    };
    pane.append(h('div', { class: 'row between' },
      h('div', { class: 'seg' }, h('button', { class: p.lang === 'ST' ? 'active' : '', onclick: () => sw('ST') }, 'Structured Text'), h('button', { class: p.lang === 'LD' ? 'active' : '', onclick: () => sw('LD') }, 'Ladder')),
      h('div', { class: 'row gap' },
        tpl ? h('button', { class: 'btn small', title: 'Put the template solution back', onclick: () => { doc.program = clone(templateScene(templateId).program); persist(); drawTab(); compile(true); } }, 'Solution') : null,
        h('button', { class: 'btn small primary', onclick: () => compile(true) }, '⬇ Download & run'))));
    if (p.lang === 'ST') {
      stEditor = codeEditor({ value: p.source, ioNames: tags, onChange: (v) => { p.source = v; persist(); }, onSubmit: () => compile(true) });
      pane.append(stEditor.el);
    } else {
      ldEditor = ladderEditor({ ladder: p.source, names: tags, onChange: () => persist() });
      pane.append(ldEditor.el);
    }
    pane.append(h('details', { class: 'why' }, h('summary', {}, `Tags of this plant (${tags.length})`), h('div', { class: 'tag-cloud' }, ioList(doc).map((r) => h('code', { class: r.dir, title: `${r.addr} · ${r.desc}` }, r.name)))));
    return pane;
  }

  function ioPane() {
    const pane = h('div', { class: 'io-panel' });
    const rows = ioList(doc);
    if (!rows.length) { pane.append(h('p', { class: 'muted' }, 'No signals yet. Place a sensor, a button or an actuator: it gets the next free address and a tag automatically.')); return pane; }
    pane.append(h('p', { class: 'small muted' }, 'Every placed element is wired to the next free address. Edit a tag or an address to reassign it; the program is updated when you rename a tag. F forces a signal.'));
    const tb = h('tbody');
    for (const r of rows) {
      const lampEl = h('span', { class: 'lamp' });
      const val = h('span', { class: 'val' });
      const tag = stopKeys(h('input', { class: 'io-edit tag', value: r.name, spellcheck: false }));
      const addr = stopKeys(h('input', { class: 'io-edit addr', value: r.addr, spellcheck: false }));
      const msg = h('div', { class: 'field-err' });
      tag.addEventListener('change', () => {
        const v = tag.value.trim();
        if (!r.el.io[r.key] || v === r.el.io[r.key].tag) return;
        const problem = tagProblem(doc, v, r.el, r.key);
        if (problem) { msg.textContent = problem; tag.classList.add('bad'); return; }
        stage.rememberProgram();
        renameTag(doc, r.el, r.key, v);
        stage.commit('rename', { program: true });
        log(`Tag ${r.name} renamed to ${v} (mapping and program).`);
      });
      addr.addEventListener('change', () => {
        const v = addr.value.trim().toUpperCase().replace(/^%?/, '%');
        if (!r.el.io[r.key] || v === r.el.io[r.key].addr) return;
        const def = KIT[r.el.type].io(r.el).find((x) => x.key === r.key);
        const problem = addressProblem(doc, v, def, r.el, r.key);
        if (problem) { msg.textContent = problem; addr.classList.add('bad'); return; }
        r.el.io[r.key].addr = v;
        stage.commit('address');
      });
      const force = h('button', { class: 'force', title: r.type === 'BOOL' ? 'Force: none → TRUE → FALSE' : 'Force to the value you enter' }, 'F');
      force.addEventListener('click', async () => {
        const has = Object.prototype.hasOwnProperty.call(rt.forces, r.name);
        if (r.type !== 'BOOL') {
          if (has) rt.force(r.name, undefined);
          else { const v = await prompt(`Force ${r.name} to (raw value, 0..${RAW})`, String(r.dir === 'in' ? rt.inputs[r.name] : rt.getOutput(r.name))); if (v != null && !Number.isNaN(parseInt(v, 10))) rt.force(r.name, parseInt(v, 10)); }
        } else if (!has) rt.force(r.name, true);
        else if (rt.forces[r.name] === true) rt.force(r.name, false);
        else rt.force(r.name, undefined);
      });
      const tr = h('tr', {}, h('td', {}, r.type === 'BOOL' ? lampEl : null), h('td', {}, tag, msg), h('td', {}, addr),
        h('td', { class: 'small' }, h('a', { href: 'javascript:void 0', onclick: () => { stage.select([r.el.id]); } }, r.el.name), h('div', { class: 'desc' }, r.label)), h('td', {}, val), h('td', { class: 'ctl' }, force));
      tb.append(tr);
      ioRows.push({ r, lampEl, val, tr });
    }
    pane.append(h('table', { class: 'io-table kit-io-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Tag'), h('th', {}, 'Address'), h('th', {}, 'Element · signal'), h('th', {}, 'Value'), h('th'))), tb));
    return pane;
  }

  function allWatchable() {
    const out = ioList(doc).map((r) => ({ name: r.name, type: r.type, kind: r.dir === 'in' ? 'input' : 'output' }));
    for (const v of rt.internals()) {
      if (v.name.startsWith('_')) continue;
      if (v.fb) { for (const k of Object.keys(v.fb)) if (!k.startsWith('_')) out.push({ name: `${v.name}.${k}`, type: typeof v.fb[k] === 'boolean' ? 'BOOL' : k === 'PT' || k === 'ET' ? 'TIME' : 'INT', kind: v.type }); }
      else out.push({ name: v.name, type: v.type, kind: 'variable' });
    }
    return out;
  }
  function readVar(name) {
    const [b, m] = name.split('.');
    const row = ioList(doc).find((r) => r.name === b);
    if (row) return row.dir === 'in' ? rt.effectiveInput(b) : rt.getOutput(b);
    const v = rt.mem[b.toUpperCase()];
    return m && v && typeof v === 'object' ? v[m] : v;
  }
  function watchPane() {
    const pane = h('div', { class: 'watch-pane' });
    const all = allWatchable();
    watch.names = watch.names.filter((n) => all.some((a) => a.name === n));
    const pick = h('select', { class: 'input slim' }, h('option', { value: '' }, '＋ Add a signal or variable…'), all.filter((a) => !watch.names.includes(a.name)).map((a) => h('option', { value: a.name }, `${a.name}  (${a.kind})`)));
    pick.addEventListener('change', () => { if (pick.value) { watch.names.push(pick.value); if (watch.trace.size < 8) watch.trace.add(pick.value); drawTab(); } });
    pane.append(h('div', { class: 'row gap' }, pick, h('button', { class: 'btn small', onclick: () => { watch.names = ioList(doc).map((r) => r.name).slice(0, 12); watch.trace = new Set(watch.names.slice(0, 8)); drawTab(); } }, 'All I/O')));
    if (!watch.names.length) pane.append(h('p', { class: 'small muted' }, 'Watch table: add signals, timers, counters or program variables to see their live values and record them over time.'));
    const tb = h('tbody');
    watch.names.forEach((n, k) => {
      const val = h('span', { class: 'val' });
      const tr = h('input', { type: 'checkbox', checked: watch.trace.has(n), title: 'Record in the trace (up to 8)' });
      tr.addEventListener('change', () => { if (tr.checked && watch.trace.size >= 8) { tr.checked = false; toast('The trace shows up to 8 signals.', 'err'); return; } if (tr.checked) watch.trace.add(n); else watch.trace.delete(n); });
      tb.append(h('tr', {}, h('td', {}, h('i', { class: 'tdot2', style: { background: TRACE_COLORS[k % 8] } })), h('td', { class: 'name' }, n), h('td', {}, val), h('td', {}, tr), h('td', {}, h('button', { class: 'btn tiny', onclick: () => { watch.names = watch.names.filter((x) => x !== n); watch.trace.delete(n); drawTab(); } }, '✕'))));
      watchRows.push({ n, val, type: (all.find((a) => a.name === n) || {}).type });
    });
    if (watch.names.length) pane.append(h('table', { class: 'io-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Trace'), h('th'))), tb));
    traceCanvas = h('canvas', { class: 'trace', width: 900, height: 300 });
    const pauseBtn = h('button', { class: 'btn small' }, watch.paused ? '▶ Continue' : '⏸ Pause');
    pauseBtn.addEventListener('click', () => { watch.paused = !watch.paused; pauseBtn.textContent = watch.paused ? '▶ Continue' : '⏸ Pause'; });
    pane.append(h('div', { class: 'row between', style: { marginTop: '10px' } }, h('b', {}, 'Trace (last 30 s)'), h('div', { class: 'row gap' }, pauseBtn,
      h('button', { class: 'btn small', onclick: () => { watch.samples = []; } }, 'Clear'),
      h('button', { class: 'btn small', onclick: () => {
        const names = [...watch.trace];
        const csv = ['time_s;' + names.join(';'), ...watch.samples.map((s) => [s.t.toFixed(2), ...names.map((n) => { const v = s.v[n]; return v === true ? 1 : v === false ? 0 : v ?? ''; })].join(';'))].join('\n');
        platform.saveFile(`${doc.name}-trace.csv`, csv, { mime: 'text/csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
      } }, '⬇ CSV'))), traceCanvas);
    return pane;
  }
  function drawTrace() {
    if (!traceCanvas) return;
    const g = traceCanvas.getContext('2d');
    const W = traceCanvas.width; const H = traceCanvas.height;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--scope-bg') || '#0b1220';
    g.fillRect(0, 0, W, H);
    const names = watch.names.filter((n) => watch.trace.has(n));
    if (!names.length) return;
    const t1 = watch.samples.length ? watch.samples[watch.samples.length - 1].t : 0;
    const t0 = t1 - 30;
    const lane = (H - 8) / names.length;
    g.font = '11px monospace';
    names.forEach((n, k) => {
      const y0 = 4 + k * lane;
      const color = TRACE_COLORS[watch.names.indexOf(n) % 8];
      let lo = Infinity; let hi = -Infinity; let isBool = true;
      for (const s of watch.samples) { const v = s.v[n]; if (typeof v === 'number') { isBool = false; lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      if (isBool) { lo = 0; hi = 1; }
      if (hi - lo < 1e-9) hi = lo + 1;
      g.strokeStyle = 'rgba(120,160,255,0.18)'; g.beginPath(); g.moveTo(0, y0 + lane - 2); g.lineTo(W, y0 + lane - 2); g.stroke();
      g.strokeStyle = color; g.lineWidth = 1.8; g.beginPath();
      let first = true; let prevY = 0;
      for (const s of watch.samples) {
        if (s.t < t0) continue;
        const raw = s.v[n];
        if (raw === undefined) continue;
        const v = raw === true ? 1 : raw === false ? 0 : raw;
        const x = ((s.t - t0) / 30) * W;
        const y = y0 + lane - 4 - ((v - lo) / (hi - lo)) * (lane - 12);
        if (first) { g.moveTo(x, y); first = false; } else { if (isBool) g.lineTo(x, prevY); g.lineTo(x, y); }
        prevY = y;
      }
      g.stroke();
      g.fillStyle = color; g.fillText(isBool ? n : `${n}  [${+lo.toFixed(1)} … ${+hi.toFixed(1)}]`, 6, y0 + 12);
    });
  }

  function elementPane() {
    const pane = h('div', { class: 'part-form' });
    const els = stage.selected();
    if (!els.length) { pane.append(h('p', { class: 'muted' }, 'Select an element in the scene (build mode) to see its settings, its signals and to inject a fault.')); return pane; }
    if (els.length > 1) {
      pane.append(h('b', {}, `${els.length} elements selected`), h('p', { class: 'small muted' }, 'Drag to move them together, R rotates the group, Ctrl+D duplicates.'),
        h('button', { class: 'btn small primary', onclick: async () => {
          const name = await prompt('Save these elements as a reusable group', 'Sorting station');
          if (!name) return;
          try { const e = await saveKitEntry(makeGroupEntry(name, els)); drawPalette(); toast(`Group “${e.name}” saved. It is in the palette under “My groups”.`, 'ok', 4000); } catch (err) { toast(err.message, 'err', 5000); }
        } }, '🧩 Save as group…'));
      return pane;
    }
    const el = els[0];
    const def = KIT[el.type];
    pane.append(h('div', { class: 'row between' }, h('b', {}, def.name), h('span', { class: 'small muted' }, sim.status(el))));
    const name = stopKeys(h('input', { class: 'input slim', value: el.name, spellcheck: false }));
    const nameMsg = h('div', { class: 'field-err' });
    name.addEventListener('change', () => {
      const v = name.value.trim();
      if (!TAG_RE.test(v)) { nameMsg.textContent = 'Use letters, digits and _ (for example Conv2).'; return; }
      if (doc.elements.some((o) => o !== el && o.name === v)) { nameMsg.textContent = `"${v}" already exists.`; return; }
      el.name = v; stage.commit('name');
    });
    pane.append(h('label', { class: 'field' }, h('span', {}, 'Name'), name, nameMsg));
    for (const prm of def.params) {
      let inp;
      const set = (v) => { el.params[prm.key] = v; allocateIO(doc); stage.commit('param'); };
      if (prm.type === 'select') { inp = h('select', { class: 'input slim' }, prm.options.map((o) => h('option', { value: o, selected: el.params[prm.key] === o }, o))); inp.addEventListener('change', () => set(inp.value)); }
      else if (prm.type === 'bool') { inp = h('input', { type: 'checkbox', checked: !!el.params[prm.key] }); inp.addEventListener('change', () => set(inp.checked)); }
      else if (prm.type === 'text') { inp = stopKeys(h('input', { class: 'input slim', value: el.params[prm.key] ?? '' })); inp.addEventListener('change', () => set(inp.value)); }
      else {
        inp = stopKeys(h('input', { class: 'input slim', type: 'number', value: el.params[prm.key], min: prm.min, max: prm.max, step: prm.step || 'any' }));
        const msg = h('div', { class: 'field-err' });
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (Number.isNaN(v) || v < prm.min || v > prm.max) { msg.textContent = `Between ${prm.min} and ${prm.max}${prm.unit ? ' ' + prm.unit : ''}.`; inp.classList.add('bad'); return; }
          const before = el.params[prm.key];
          el.params[prm.key] = v;
          // a longer conveyor may no longer fit
          if (!stage._settle([el])) { el.params[prm.key] = before; msg.textContent = 'There is no room for that size here.'; inp.value = before; return; }
          set(v);
        });
        pane.append(h('label', { class: 'field' }, h('span', {}, prm.label, prm.unit ? h('i', {}, ` [${prm.unit}]`) : null), inp, msg));
        continue;
      }
      pane.append(h('label', { class: 'field' + (prm.type === 'bool' ? ' inline' : '') }, h('span', {}, prm.label), inp));
    }
    const sig = ioList(doc).filter((r) => r.el === el);
    if (sig.length) pane.append(h('h4', {}, 'Signals'), h('table', { class: 'io-table compact' }, h('tbody', {}, sig.map((r) => h('tr', {}, h('td', { class: 'addr' }, r.addr), h('td', { class: 'name' }, r.name), h('td', { class: 'small muted' }, `${r.dir === 'in' ? 'input' : 'output'} · ${r.label}`))))),
      h('button', { class: 'btn tiny', onclick: () => { active = 'io'; autoInspect = false; drawTab(); } }, 'Edit in the I/O map'));
    const fc = faultClass(el);
    if (fc) {
      const fs = h('select', { class: 'input slim' }, FAULTS[fc].map(([v, t]) => h('option', { value: v, selected: (el.fault || '') === v }, t)));
      fs.addEventListener('change', () => { el.fault = fs.value; stage.commit('fault'); if (fs.value) log(`Fault injected on ${el.name}: ${fs.selectedOptions[0].textContent}`, 'err'); });
      pane.append(h('h4', {}, 'Fault injection (for troubleshooting practice)'), h('label', { class: 'field' }, h('span', {}, fc === 'sensor' ? 'Sensor fault' : 'Actuator fault'), fs));
    }
    if (isBuiltinKit(el.type) && def.io(el).length) pane.append(h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: () => variantDialog(el.type, el.params) }, '＋ Save as my own element type…'));
    return pane;
  }

  function taskPane() {
    return h('div', { class: 'task-pane' }, h('p', {}, tpl.summary), h('h4', {}, 'Objectives'), h('ol', {}, tpl.objectives.map((o) => h('li', {}, o))),
      applied.length && fromDoc ? h('div', { class: 'note' }, `📄 ${applied.length} value(s) taken from “${fromDoc.name}”: ${applied.join(', ')}`) : null,
      h('p', { class: 'small muted' }, 'This is a template: every element can be moved, deleted, replaced or rewired, and the program is yours to change. “File → Reset to template” brings the original back.'));
  }

  // ---- custom element types ---------------------------------------------------------------------
  async function variantDialog(base, params = null, entry = null) {
    const def = KIT[base];
    const values = { ...Object.fromEntries(def.params.map((p) => [p.key, p.def])), ...(params || {}), ...(entry ? entry.params : {}) };
    const name = stopKeys(h('input', { class: 'input', value: entry ? entry.name : `${def.name} (my type)` }));
    const tag = stopKeys(h('input', { class: 'input', value: entry ? entry.tag || def.tag : def.tag, maxlength: 10 }));
    const baseSel = h('select', { class: 'input', disabled: !!entry }, Object.entries(KIT).filter(([t, d]) => isBuiltinKit(t) && d.io({ params: Object.fromEntries(d.params.map((p) => [p.key, p.def])) }).length).map(([t, d]) => h('option', { value: t, selected: t === base }, `${d.cat}: ${d.name}`)));
    const cat = h('select', { class: 'input' }, KIT_CATEGORIES.map((c) => h('option', { value: c, selected: c === (entry ? entry.category : def.cat) }, c)));
    const custom = h('input', { type: 'checkbox', checked: !!(entry && entry.look) });
    const shape = h('select', { class: 'input slim' }, LOOK_SHAPES.map((s) => h('option', { value: s, selected: entry && entry.look && entry.look.shape === s }, s)));
    const c1 = h('select', { class: 'input slim' }, LOOK_COLORS.map((s) => h('option', { value: s, selected: entry && entry.look ? entry.look.color === s : s === 'blue' }, s)));
    const c2 = h('select', { class: 'input slim' }, LOOK_COLORS.map((s) => h('option', { value: s, selected: entry && entry.look ? entry.look.accent === s : s === 'yellow' }, s)));
    const fields = h('div', { class: 'part-form' });
    const errors = new Set();
    for (const prm of def.params) {
      let inp;
      if (prm.type === 'select') { inp = h('select', { class: 'input slim' }, prm.options.map((o) => h('option', { value: o, selected: values[prm.key] === o }, o))); inp.addEventListener('change', () => { values[prm.key] = inp.value; }); }
      else if (prm.type === 'bool') { inp = h('input', { type: 'checkbox', checked: !!values[prm.key] }); inp.addEventListener('change', () => { values[prm.key] = inp.checked; }); }
      else if (prm.type === 'text') { inp = stopKeys(h('input', { class: 'input slim', value: values[prm.key] ?? '' })); inp.addEventListener('input', () => { values[prm.key] = inp.value; }); }
      else {
        inp = stopKeys(h('input', { class: 'input slim', type: 'number', value: values[prm.key], step: prm.step || 'any' }));
        const msg = h('div', { class: 'field-err' });
        inp.addEventListener('input', () => { const v = parseFloat(inp.value); const bad = Number.isNaN(v) || v < prm.min || v > prm.max; msg.textContent = bad ? `Between ${prm.min} and ${prm.max}.` : ''; inp.classList.toggle('bad', bad); if (bad) errors.add(prm.key); else { errors.delete(prm.key); values[prm.key] = v; } });
        fields.append(h('label', { class: 'field', 'data-key': prm.key }, h('span', {}, prm.label, prm.unit ? h('i', {}, ` [${prm.unit}]`) : null), inp, msg));
        continue;
      }
      fields.append(h('label', { class: 'field' + (prm.type === 'bool' ? ' inline' : ''), 'data-key': prm.key }, h('span', {}, prm.label), inp));
    }
    baseSel.addEventListener('change', () => { back.remove(); variantDialog(baseSel.value); });
    const sig = def.io({ params: values });
    const body = h('div', { class: 'form kit-variant' },
      h('label', {}, 'Behaviour class (what it does)', baseSel),
      h('div', { class: 'small muted' }, `Signals: ${sig.map((p) => `${p.label} (${p.dir === 'in' ? 'input' : 'output'}, ${p.type === 'BOOL' ? 'digital' : 'analog'})`).join(' · ')}`),
      h('label', {}, 'Name', name), h('label', {}, 'Tag prefix (tags become e.g. ' + (tag.value || def.tag) + '1)', tag), h('label', {}, 'Category', cat),
      h('h4', {}, 'Parameters and signal type'), fields,
      h('h4', {}, 'Look'), h('label', { class: 'row gap', style: { fontWeight: 500 } }, custom, 'Own look from brick shapes (otherwise it looks like its behaviour class)'),
      h('div', { class: 'row gap' }, 'Shape', shape, 'Colour', c1, 'Accent', c2));
    const back = h('div', { class: 'modal-back' });
    const close = () => back.remove();
    back.append(h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h3', {}, entry ? `Edit “${entry.name}”` : 'New element type'), h('button', { class: 'icon-btn', onclick: close }, '✕')), h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
        if (!name.value.trim()) { toast('Give the element type a name.', 'err'); return; }
        if (errors.size) { toast('Fix the fields marked in red first.', 'err'); return; }
        if (!TAG_RE.test(tag.value.trim())) { toast('The tag prefix may only contain letters, digits and _.', 'err'); return; }
        if (Object.entries(KIT).some(([t, d]) => !d.removed && d.name.toLowerCase() === name.value.trim().toLowerCase() && (!entry || t !== entry.id))) { toast('An element with this name already exists.', 'err'); return; }
        const prm = {};
        for (const p of def.params) if (values[p.key] !== p.def) prm[p.key] = values[p.key];
        try {
          const e = await saveKitEntry({ ...(entry || {}), kind: 'kit-variant', name: name.value.trim(), tag: tag.value.trim(), category: cat.value, base, params: prm, look: custom.checked ? { shape: shape.value, color: c1.value, accent: c2.value } : null });
          close(); drawPalette(); stage.sync(); toast(`“${e.name}” is now in the palette (${e.category}).`, 'ok', 3500);
        } catch (err) { toast(err.message, 'err', 5000); }
      } }, 'Save element type'))));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    document.body.append(back);
  }

  async function kitCatalogDialog() {
    const mine = await listKitEntries();
    const list = h('div', { class: 'prog-list' });
    if (!mine.length) list.append(h('p', { class: 'muted small' }, 'Nothing yet. Create a new element type here, or select several elements in the scene and use “Save as group…”.'));
    const back = h('div', { class: 'modal-back' });
    const close = () => back.remove();
    for (const e of mine) {
      list.append(h('div', { class: 'prog-row' }, h('div', { class: 'prog-ico' }, e.kind === 'kit-group' ? '🧩' : ICON[e.base] || '▫️'),
        h('div', { class: 'grow' }, h('b', {}, e.name), h('div', { class: 'small muted' }, e.kind === 'kit-group' ? `Group of ${e.elements.length} elements` : `Element type · behaves like ${KIT[e.base].name}`)),
        e.kind === 'kit-variant' ? h('button', { class: 'btn tiny', onclick: () => { close(); variantDialog(e.base, null, e); } }, 'Edit') : null,
        h('button', { class: 'btn tiny', onclick: () => platform.saveFile(`${e.name}.catalog.json`, exportKitEntries([e]), { mime: 'application/json', filters: [{ name: 'Catalog', extensions: ['json'] }] }) }, 'Export'),
        h('button', { class: 'btn tiny danger', onclick: async () => { await deleteKitEntry(e); close(); drawPalette(); kitCatalogDialog(); } }, 'Delete')));
    }
    back.append(h('div', { class: 'modal' }, h('div', { class: 'modal-head' }, h('h3', {}, 'My kit elements'), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, list),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', onclick: async () => {
          const [f] = await platform.pickFiles({ accept: '.json', filters: [{ name: 'Catalog', extensions: ['json'] }] });
          if (!f) return;
          try { const r = await importEntries(await f.text()); toast(`Imported ${r.added} new and ${r.updated} updated entr${r.added + r.updated === 1 ? 'y' : 'ies'}`, 'ok'); close(); drawPalette(); } catch (err) { toast('Import failed: ' + err.message, 'err', 6000); }
        } }, '⬆ Import JSON…'),
        mine.length ? h('button', { class: 'btn', onclick: () => platform.saveFile('my-kit-elements.catalog.json', exportKitEntries(mine), { mime: 'application/json', filters: [{ name: 'Catalog', extensions: ['json'] }] }) }, '⬇ Export all') : null,
        h('button', { class: 'btn primary', onclick: () => { close(); variantDialog('lightbarrier'); } }, '＋ New element type…'))));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    document.body.append(back);
  }

  function toggleCam() {
    stage.world.setMode(stage.world.mode === 'fps' ? 'overview' : 'fps');
    if (stage.world.mode === 'fps') { const c = stage.world.renderer.domElement; if (!c.hasAttribute('tabindex')) c.tabIndex = 0; c.focus(); } // walking keys go to the 3D view
    refreshButtons();
  }

  // ---- toolbar actions ------------------------------------------------------------------------------
  buildBtn.addEventListener('click', () => stage.setMode('build'));
  operateBtn.addEventListener('click', () => stage.setMode('operate'));
  runBtn.addEventListener('click', () => compile(true));
  stopBtn.addEventListener('click', () => { setRunning(false); log('PLC set to STOP'); });
  resetBtn.addEventListener('click', () => { sim.reset(); rt.forces = {}; if (rt.program) rt.resetMemory(); watch.samples = []; log('Process and PLC memory reset'); });
  camBtn.addEventListener('click', () => { toggleCam(); });
  undoBtn.addEventListener('click', () => stage.undo());
  redoBtn.addEventListener('click', () => stage.redo());
  const menu = (btn, cls, build) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.' + cls).forEach((m) => m.remove());
    const m = h('div', { class: 'menu ' + cls });
    build((label, fn) => m.append(h('button', { onclick: () => { m.remove(); fn(); } }, label)), m);
    const r = btn.getBoundingClientRect();
    Object.assign(m.style, { top: r.bottom + 4 + 'px', left: Math.max(8, r.right - 260) + 'px' });
    document.body.append(m);
    const closeM = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', closeM); } };
    setTimeout(() => document.addEventListener('pointerdown', closeM), 0);
  });
  menu(viewBtn, 'kit-view-menu', (item) => {
    item(`${stage.showNames ? '☑' : '☐'} Element names (build mode)`, () => { stage.showNames = !stage.showNames; for (const b of stage.built.values()) b.tagSig = null; stage.sync(); });
    item(`${stage.showWiring ? '☑' : '☐'} Cables to the PLC rack`, () => { stage.showWiring = !stage.showWiring; stage.sync(); });
  });
  menu(fileBtn, 'kit-file', (item) => {
    item('📄 New empty plant', () => navigate('/plc/new'));
    item('💾 Save as…', async () => { const n = await prompt('Save plant as', templateId ? `${doc.name} (my version)` : `${doc.name} copy`); if (!n) return; const c = await saveSceneAs(doc, n); toast('Saved as a new plant', 'ok'); navigate('/plc/' + c.id); });
    if (templateId) item('↺ Reset to template', async () => {
      const ok = await modal('Reset to template?', h('p', {}, 'Your changes to this template copy (plant and program) are discarded. Use “Save as…” first if you want to keep them.'), [{ label: 'Cancel', value: null }, { label: 'Reset', value: 'ok', primary: true }]);
      if (!ok) return;
      clearTimeout(saveT);
      const fresh = await resetSceneTemplate(templateId);
      doc.elements = fresh.elements; doc.program = fresh.program; doc.name = fresh.name;
      nameEl.value = doc.name; modified = false;
      stage.undoStack = []; stage.redoStack = []; stage._saved = stage._snapshot(); stage.sel.clear(); stage.sync();
      ioSig = ''; rebuild('init'); sim.reset(); drawBadge(); drawTab(); refreshButtons();
      toast('Template restored', 'ok');
    });
    else if (!emb) item('🗑 Delete this plant', async () => { const ok = await modal('Delete plant?', h('p', {}, `“${doc.name}” is removed from this app.`), [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }]); if (!ok) return; clearTimeout(saveT); leaving = true; await deleteScene(doc.id); navigate('/lab'); });
    item('⬇ Export plant (.json)', () => platform.saveFile(`${doc.name}.plant.json`, JSON.stringify({ ...doc, defs: kitDefsUsedBy(doc) }, null, 2), { mime: 'application/json', filters: [{ name: 'Plant', extensions: ['json'] }] }));
    item('⬆ Import plant (.json)…', async () => {
      const [f] = await platform.pickFiles({ accept: '.json', filters: [{ name: 'Plant', extensions: ['json'] }] });
      if (!f) return;
      try { const o = JSON.parse(await f.text()); if (o.kind !== 'scene') throw new Error('not a plant file'); const c = await saveSceneAs(o, o.name || 'Imported plant'); navigate('/plc/' + c.id); } catch (err) { toast('Could not import: ' + err.message, 'err', 5000); }
    });
    item('🧩 My kit elements…', kitCatalogDialog);
  });

  const onKey = (e) => {
    if (!root.isConnected || document.querySelector('.modal-back')) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) stage.redo(); else stage.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); stage.redo(); return; }
    if (mod && k === 'd') { e.preventDefault(); stage.duplicate(); return; }
    if (mod && k === 'a') { e.preventDefault(); stage.select(doc.elements.map((x) => x.id)); return; }
    if (mod) return;
    if (stage.world.mode === 'fps' && k !== 'c' && k !== 'escape') return; // WASD belongs to walking
    if (e.key === 'Escape') { if (stage.tool) stage.cancelTool(); else stage.select([]); }
    else if (k === 'r') stage.rotate();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); stage.remove(); }
    else if (k === 'b') stage.setMode(stage.mode === 'build' ? 'operate' : 'build');
    else if (k === 'c') { toggleCam(); }
  };
  window.addEventListener('keydown', onKey);

  // ---- main loop ------------------------------------------------------------------------------------------
  let acc = 0;
  let uiT = 0;
  stage.world.onUpdate((dt) => {
    acc += dt * +speedSel.value;
    let n = 0;
    while (acc >= SCAN && n++ < 60) {
      sim.step(SCAN);
      rt.scan(SCAN * 1000);
      acc -= SCAN;
      if (!watch.paused && watch.trace.size) {
        const last = watch.samples[watch.samples.length - 1];
        if (!last || sim.time - last.t >= 0.04) {
          const v = {};
          for (const name of watch.trace) v[name] = readVar(name);
          watch.samples.push({ t: sim.time, v });
          if (watch.samples.length > 1200) watch.samples.splice(0, 200);
        }
      }
    }
    if (rt.error) { log(`Runtime fault${rt.error.line ? ' at line ' + rt.error.line : ''}: ${rt.error.msg}`, 'err', rt.error.line); rt.error = null; setRunning(false); cpu.textContent = 'FAULT'; cpu.className = 'cpu fault'; }
    uiT += dt;
    if (uiT < 0.12) return;
    uiT = 0;
    clear(hud);
    const rows = sim.summary();
    hud.append(h('div', { class: 'hud-row head' }, h('span', {}, `CPU ${rt.running ? 'RUN' : 'STOP'} · scan ${rt.scanCount}`), h('span', {}, `${sim.items.length} workpieces`)),
      ...rows.slice(0, 9).map(([k, v]) => h('div', { class: 'hud-row' + (/⚠|wrong [1-9]|[1-9]\d* wrong|OVERLOAD|overflowed|spilled|×/.test(String(v)) ? ' warn' : '') }, h('span', {}, k), h('b', {}, v))));
    forcedBadge.style.display = Object.keys(rt.forces).length ? '' : 'none';
    for (const { r, lampEl, val, tr } of ioRows) {
      const v = r.dir === 'in' ? rt.effectiveInput(r.name) : rt.getOutput(r.name);
      if (r.type === 'BOOL') lampEl.classList.toggle('on', !!v);
      val.textContent = r.type === 'BOOL' ? (v ? 'TRUE' : 'FALSE') : String(v);
      tr.classList.toggle('forced', Object.prototype.hasOwnProperty.call(rt.forces, r.name));
    }
    for (const w of watchRows) { const v = readVar(w.n); w.val.textContent = v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : w.type === 'TIME' ? formatTime(v) : typeof v === 'number' ? String(+v.toFixed(3)) : String(v); }
    drawTrace();
    if (ldEditor) ldEditor.setLive(rt.running ? (b, m) => { const v = rt.mem[b.toUpperCase()]; if (v === undefined) return undefined; return m && v && typeof v === 'object' ? v[m.toUpperCase()] : v; } : null);
    if (stage.hoverEl && !stage.tool) showStatus();
  });

  // ---- start --------------------------------------------------------------------------------------------------
  drawBadge();
  drawPalette();
  rebuild('init');
  drawTab();
  if (templateId || doc.elements.length) stage.setMode(templateId ? 'operate' : 'build'); else refreshButtons();
  refreshButtons();
  embBanner();
  if (applied.length) saveScene(doc);
  requestAnimationFrame(() => finishTransition());
  window.__kit = { stage, get sim() { return sim; }, get rt() { return rt; }, get doc() { return doc; }, compile, watch }; // handy for debugging from the console

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      offTheme();
      clearTimeout(saveT);
      if (emb) { if (!leaving && embedDirty()) saveDraft(emb.ref, doc); } else if (modified && !leaving) saveScene(doc);
      stage.destroy();
      document.querySelectorAll('.menu.kit-file, .menu.kit-view-menu').forEach((m) => m.remove());
      if (window.__kit && window.__kit.stage === stage) window.__kit = null;
    },
  };
}

const ICON = {
  conveyor: '🟰', road: '🛣', crossing: '➕', spawner: '📦', sink: '🗑', tank: '🛢', reservoir: '🌊', drain: '🚰', pipe: '➖', elbow: '↪️',
  motor: '⚙️', pump: '🔄', valve: '🔧', cylinder1: '➡️', cylinder2: '↔️', gate: '🚧', lamp: '💡', horn: '📢', trafficlight: '🚦', elevator: '🛗', mixer: '🌀', heater: '🔥', filler: '🚿', capper: '🔩',
  lightbarrier: '🔦', inductive: '🧲', capacitive: '📡', coloursensor: '🎨', limitswitch: '⏹', levelswitch: '📏', leveltx: '📶', pressure: '🧭', temperature: '🌡', encoder: '🎚', scale: '⚖️',
  button: '🔘', switch: '🎛', estop: '🛑', selector: '🔀', potentiometer: '🎚', setpoint: '🔢', brick: '🧱',
};
