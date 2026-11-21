import { h, clear, toast, modal } from '../core/dom.js';
import { platform } from '../platform/index.js';
import { navigate } from '../core/router.js';
import { uid } from '../core/db.js';
import { getDoc, getFile, getAnnotations, saveAnnotations, updateDoc } from '../docs/store.js';
import { loadPdf, reencodeImage } from '../docs/pdf.js';
import { drawObjects, hitTest, translate, bbox, exportAnnotatedPdf } from '../docs/annotations.js';
import { analyseDocument, matchText, extractParams } from '../docs/matcher.js';
import { SCENARIOS } from '../scenarios/index.js';
import { CIRCUITS } from '../circuits/library.js';
import { launchUrl } from './launch.js';
import { makeEmbed, embedHeight, draftIds, syncLinksAfterHistory } from '../docs/embeds.js';
import { saveSession, takeSession } from '../docs/session.js';
import { insertSimulationDialog, zoomIn, finishTransition } from './embed-ui.js';

const COLORS = ['#1d1d1f', '#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#ffffff'];
const HL_COLORS = ['#fff176', '#a5d6a7', '#81d4fa', '#f8bbd0', '#ffcc80'];
const TOOLS = [
  ['select', '🖐', 'Select / move (V)', 'KeyV'],
  ['pen', '✒️', 'Pen (P)', 'KeyP'],
  ['highlighter', '🖍', 'Highlighter (H)', 'KeyH'],
  ['eraser', '🧽', 'Eraser (E)', 'KeyE'],
  ['text', '🔤', 'Text box (T)', 'KeyT'],
  ['shape', '⬜', 'Shapes (R)', 'KeyR'],
  ['image', '🖼', 'Insert image (I)', 'KeyI'],
  ['embed', '🧪', 'Insert simulation (S): a live circuit or PLC scene as an object on the page', 'KeyS'],
];
const allTargets = () => [
  ...SCENARIOS.map((s) => ({ kind: 'plc', id: s.id, name: s.name, icon: s.icon, params: s.params, match: s.match })),
  ...CIRCUITS.map((c) => ({ kind: 'circuit', id: c.id, name: c.name, icon: c.icon, params: c.params, match: c.match })),
];

export async function editorView(root, docId, q = {}) {
  clear(root);
  let meta = await getDoc(docId);
  if (!meta) { root.append(h('div', { class: 'page' }, h('h2', {}, 'Document not found'), h('a', { href: '#/library' }, 'Back to library'))); return; }
  document.getElementById('crumb').textContent = `Library › ${meta.name}`;
  const bytes = await getFile(docId);
  const ann = await getAnnotations(docId);
  if (!ann.layers) ann.layers = [{ id: 'L1', name: 'Ink & notes', visible: true }];
  ann.pages = ann.pages || {};
  for (const objs of Object.values(ann.pages)) for (const o of objs) if (!o.layer) o.layer = ann.layers[0].id;
  let activeLayer = ann.layers[0].id;

  const pdf = await loadPdf(bytes);
  const sizes = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1, rotation: 0 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  const pageObjs = (i) => (ann.pages[i] = ann.pages[i] || []);

  // ---- state ----------------------------------------------------------------
  const st = {
    tool: 'pen', color: COLORS[0], hlColor: HL_COLORS[0], size: 2.2, hlSize: 14, textSize: 14, shape: 'rect',
    zoom: 1, current: 0, selected: null, selPage: -1,
  };
  const sess = takeSession(docId); // zoom, scroll and history from before a trip into a simulation
  let drafts = await draftIds(docId); // embeds with unapplied changes
  const undo = sess ? sess.undo : [];
  const redo = sess ? sess.redo : [];
  let penSeen = false;

  // ---- layout -----------------------------------------------------------------
  const thumbs = h('div', { class: 'thumbs' });
  const scroller = h('div', { class: 'pages-scroll' });
  const pagesEl = h('div', { class: 'pages' });
  scroller.append(pagesEl);
  const panel = h('div', { class: 'doc-panel' });
  const nameEl = h('input', { class: 'doc-name', value: meta.name });
  nameEl.addEventListener('change', async () => { meta = { ...meta, name: nameEl.value }; await updateDoc(meta); });
  nameEl.addEventListener('keydown', (e) => e.stopPropagation());

  const toolBtns = {};
  const toolGroup = h('div', { class: 'tool-group' }, TOOLS.map(([k, ico, title]) => (toolBtns[k] = h('button', { class: 'tool', title, onclick: () => setTool(k) }, ico))));
  const swatches = h('div', { class: 'swatches' });
  const sizeIn = h('input', { type: 'range', min: 0.5, max: 24, step: 0.5, value: st.size, title: 'Size' });
  const shapeSel = h('select', { class: 'input slim' }, [['rect', '▭ Rectangle'], ['ellipse', '◯ Ellipse'], ['line', '╱ Line'], ['arrow', '➚ Arrow']].map(([v, l]) => h('option', { value: v }, l)));
  shapeSel.addEventListener('change', () => { st.shape = shapeSel.value; });
  const layerSel = h('select', { class: 'input slim', title: 'Active layer' });
  const undoBtn = h('button', { class: 'icon-btn', title: 'Undo (Ctrl+Z)', onclick: doUndo }, '↶');
  const redoBtn = h('button', { class: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', onclick: doRedo }, '↷');
  const zoomLbl = h('span', { class: 'zoom-lbl' });
  const imgInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });

  const toolbar = h('div', { class: 'toolbar editor-tb' },
    h('a', { class: 'btn ghost', href: '#/library' }, '←'), nameEl,
    h('div', { class: 'sep' }), toolGroup, h('div', { class: 'sep' }), swatches, sizeIn, shapeSel,
    h('div', { class: 'sep' }), layerSel, undoBtn, redoBtn,
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => setZoom(st.zoom / 1.2) }, '−'), zoomLbl,
    h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => setZoom(st.zoom * 1.2) }, '+'),
    h('button', { class: 'btn small', title: 'Fit width', onclick: fitWidth }, 'Fit'),
    h('button', { class: 'btn small primary', onclick: exportPdf }, '⬇ Export PDF'),
    h('button', { class: 'btn small', onclick: () => root.querySelector('.editor').classList.toggle('panel-hidden') }, '🧪 Simulations'),
    imgInput);
  root.append(h('div', { class: 'editor' }, toolbar, h('div', { class: 'editor-body' }, thumbs, scroller, panel)));

  // ---- pages ------------------------------------------------------------------
  const pages = sizes.map((sz, i) => {
    const pdfC = h('canvas', { class: 'pdf-c' });
    const annC = h('canvas', { class: 'ann-c' });
    const links = h('div', { class: 'page-links' });
    const wrap = h('div', { class: 'page-wrap', 'data-page': i }, pdfC, annC, links, h('div', { class: 'page-num' }, `${i + 1} / ${sizes.length}`));
    pagesEl.append(wrap);
    const p = { i, sz, wrap, pdfC, annC, links, rendered: 0, task: null };
    bindPointer(p);
    return p;
  });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pages[+e.target.dataset.page];
      p.visible = e.isIntersecting;
      if (p.visible) renderPage(p);
    }
  }, { root: scroller, rootMargin: '300px 0px' });
  // current page = the one that fills most of the visible area
  let curRaf = 0;
  function computeCurrent() {
    curRaf = 0;
    const sr = scroller.getBoundingClientRect();
    let best = -1; let bestArea = 0;
    for (const p of pages) {
      if (!p.visible) continue;
      const r = p.wrap.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
      if (area > bestArea) { bestArea = area; best = p.i; }
    }
    if (best >= 0 && best !== st.current) setCurrent(best, false);
  }
  scroller.addEventListener('scroll', () => { if (!curRaf) curRaf = requestAnimationFrame(computeCurrent); }, { passive: true });
  pages.forEach((p) => io.observe(p.wrap));

  async function renderPage(p) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = st.zoom * dpr;
    layoutPage(p);
    if (p.rendered === key) return;
    p.rendered = key;
    if (p.task) { try { p.task.cancel(); } catch { /* ignore */ } }
    const page = await pdf.getPage(p.i + 1);
    const vp = page.getViewport({ scale: key, rotation: 0 });
    const tmp = document.createElement('canvas');
    tmp.width = Math.ceil(vp.width);
    tmp.height = Math.ceil(vp.height);
    p.task = page.render({ canvasContext: tmp.getContext('2d'), viewport: vp });
    try {
      await p.task.promise;
      if (p.rendered !== key) return;
      p.pdfC.width = tmp.width;
      p.pdfC.height = tmp.height;
      p.pdfC.getContext('2d').drawImage(tmp, 0, 0);
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.error(e);
    }
    drawAnn(p);
  }

  function layoutPage(p) {
    const w = p.sz.w * st.zoom;
    const hh = p.sz.h * st.zoom;
    p.wrap.style.width = w + 'px';
    p.wrap.style.height = hh + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const aw = Math.ceil(w * dpr);
    const ah = Math.ceil(hh * dpr);
    if (p.annC.width !== aw || p.annC.height !== ah) { p.annC.width = aw; p.annC.height = ah; drawAnn(p); }
  }

  const visibleLayers = () => new Set(ann.layers.filter((l) => l.visible).map((l) => l.id));
  function drawAnn(p, extra) {
    const ctx = p.annC.getContext('2d');
    const s = p.annC.width / p.sz.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.annC.width, p.annC.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    const vis = visibleLayers();
    const objs = pageObjs(p.i).filter((o) => vis.has(o.layer));
    if (extra) objs.push(extra);
    drawObjects(ctx, objs, { onImageLoad: () => drawAnn(p), selected: st.selPage === p.i ? st.selected : null, drafts });
  }
  const redrawAll = () => pages.forEach((p) => drawAnn(p));

  function setZoom(z) {
    const anchor = scroller.scrollTop / (scroller.scrollHeight || 1);
    st.zoom = Math.max(0.25, Math.min(5, z));
    zoomLbl.textContent = Math.round(st.zoom * 100) + '%';
    pages.forEach(layoutPage);
    scroller.scrollTop = anchor * scroller.scrollHeight;
    pages.filter((p) => p.visible).forEach(renderPage);
  }
  function fitWidth() {
    const maxW = Math.max(...sizes.map((s) => s.w));
    setZoom((scroller.clientWidth - 48) / maxW);
  }
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(st.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }
  }, { passive: false });

  // ---- thumbnails ---------------------------------------------------------------
  const thumbEls = sizes.map((sz, i) => {
    const c = h('canvas', {});
    const el = h('div', { class: 'thumb-item', onclick: () => gotoPage(i) }, c, h('span', {}, i + 1), h('i', { class: 'tdot' }));
    thumbs.append(el);
    return { el, c, done: false };
  });
  const tio = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      const i = thumbEls.findIndex((t) => t.el === e.target);
      const t = thumbEls[i];
      if (!e.isIntersecting || t.done) continue;
      t.done = true;
      const page = await pdf.getPage(i + 1);
      const vp0 = page.getViewport({ scale: 1, rotation: 0 });
      const vp = page.getViewport({ scale: 120 / vp0.width, rotation: 0 });
      t.c.width = vp.width;
      t.c.height = vp.height;
      page.render({ canvasContext: t.c.getContext('2d'), viewport: vp });
    }
  }, { root: thumbs });
  thumbEls.forEach((t) => tio.observe(t.el));

  function setCurrent(i, scroll = true) {
    st.current = i;
    thumbEls.forEach((t, k) => t.el.classList.toggle('active', k === i));
    if (scroll) gotoPage(i);
    drawPanelPage();
  }
  function gotoPage(i) {
    const p = pages[i];
    if (!p) return;
    scroller.scrollTop = p.wrap.offsetTop - 16;
    st.current = i;
    thumbEls.forEach((t, k) => t.el.classList.toggle('active', k === i));
    thumbEls[i].el.scrollIntoView({ block: 'nearest' });
    drawPanelPage();
  }

  // ---- tools ---------------------------------------------------------------------
  function setTool(t) {
    if (t === 'image') { imgInput.click(); return; }
    if (t === 'embed') { insertEmbed(); return; }
    st.tool = t;
    for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === t);
    pagesEl.dataset.tool = t;
    shapeSel.style.display = t === 'shape' ? '' : 'none';
    if (t !== 'select') select(null, -1);
    drawSwatches();
  }
  function drawSwatches() {
    clear(swatches);
    const hl = st.tool === 'highlighter';
    const list = hl ? HL_COLORS : COLORS;
    const cur = hl ? st.hlColor : st.color;
    for (const c of list) {
      swatches.append(h('button', { class: 'swatch' + (c === cur ? ' active' : ''), style: { background: c }, title: c, onclick: () => {
        if (hl) st.hlColor = c; else st.color = c;
        if (st.selected && 'color' in st.selected && !hl) { const before = snap(st.selPage); st.selected.color = c; commit(st.selPage, before); }
        drawSwatches();
      } }));
    }
    const custom = h('input', { type: 'color', value: cur, title: 'Custom colour' });
    custom.addEventListener('input', () => { if (hl) st.hlColor = custom.value; else st.color = custom.value; });
    swatches.append(custom);
    sizeIn.value = hl ? st.hlSize : st.tool === 'text' ? st.textSize : st.size;
    sizeIn.max = st.tool === 'text' ? 48 : hl ? 40 : 24;
  }
  sizeIn.addEventListener('input', () => {
    const v = +sizeIn.value;
    if (st.tool === 'highlighter') st.hlSize = v;
    else if (st.tool === 'text') st.textSize = v;
    else st.size = v;
  });

  function drawLayers() {
    clear(layerSel);
    for (const l of ann.layers) layerSel.append(h('option', { value: l.id, selected: l.id === activeLayer }, `▤ ${l.name}`));
    layerSel.append(h('option', { value: '__new' }, '＋ New layer…'));
  }
  layerSel.addEventListener('change', () => {
    if (layerSel.value === '__new') {
      const id = 'L' + (ann.layers.length + 1) + Math.random().toString(36).slice(2, 5);
      ann.layers.push({ id, name: `Layer ${ann.layers.length + 1}`, visible: true });
      activeLayer = id;
      save();
      drawPanel();
    } else activeLayer = layerSel.value;
    drawLayers();
  });

  imgInput.addEventListener('change', async () => {
    const f = imgInput.files[0];
    imgInput.value = '';
    if (!f) return;
    const isJpg = f.type === 'image/jpeg';
    const data = await reencodeImage(f, isJpg ? 'image/jpeg' : 'image/png', 1800);
    let bin = '';
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
    const url = `data:${isJpg ? 'image/jpeg' : 'image/png'};base64,${btoa(bin)}`;
    const im = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
    const p = pages[st.current];
    const w = Math.min(p.sz.w * 0.5, im.width);
    const hgt = (w * im.height) / im.width;
    const o = { id: uid('o'), type: 'image', x: (p.sz.w - w) / 2, y: Math.max(20, (p.sz.h - hgt) / 3), w, h: hgt, data: url, layer: activeLayer };
    const before = snap(p.i);
    pageObjs(p.i).push(o);
    commit(p.i, before);
    setTool('select');
    select(o, p.i);
  });

  // ---- undo / persistence ------------------------------------------------------------
  const snap = (i) => JSON.stringify(pageObjs(i));
  function commit(i, before) {
    const after = snap(i);
    if (after === before) return;
    undo.push({ i, before, after });
    if (undo.length > 200) undo.shift();
    redo.length = 0;
    save();
    drawAnn(pages[i]);
    updateUndoBtns();
  }
  function restore(i, json) {
    ann.pages[i] = JSON.parse(json);
    select(null, -1);
    drawAnn(pages[i]);
    save();
    // linked simulations follow the restored state
    if (ann.pages[i].some((o) => o.type === 'embed' && o.link)) syncLinksAfterHistory(docId, i, ann.pages[i]);
  }
  function doUndo() {
    const u = undo.pop();
    if (!u) return;
    redo.push(u);
    restore(u.i, u.before);
    gotoPageIfHidden(u.i);
    updateUndoBtns();
  }
  function doRedo() {
    const u = redo.pop();
    if (!u) return;
    undo.push(u);
    restore(u.i, u.after);
    gotoPageIfHidden(u.i);
    updateUndoBtns();
  }
  function gotoPageIfHidden(i) { if (!pages[i].visible) gotoPage(i); }
  function updateUndoBtns() { undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length; }
  let saveT = 0;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      await saveAnnotations(docId, ann);
      meta = { ...meta, updated: Date.now() };
      await updateDoc(meta);
    }, 400);
  }

  function select(o, i) {
    const prev = st.selPage;
    st.selected = o;
    st.selPage = o ? i : -1;
    if (prev >= 0 && pages[prev]) drawAnn(pages[prev]);
    if (o) drawAnn(pages[i]);
    updateEmbedBar();
  }

  // ---- embedded simulations ----------------------------------------------------------------
  let embedBar = null;
  function updateEmbedBar() {
    if (embedBar) { embedBar.remove(); embedBar = null; }
    const o = st.selected;
    if (!o || o.type !== 'embed' || st.selPage < 0) return;
    const p = pages[st.selPage];
    embedBar = h('div', { class: 'embed-bar' },
      h('button', { class: 'btn small primary', onclick: () => openEmbed(p, o) }, '▶ Open simulation'),
      h('button', { class: 'btn small', title: 'Show or hide the table of key values', onclick: () => { const before = snap(p.i); o.showTable = !o.showTable; o.h = embedHeight(o); commit(p.i, before); updateEmbedBar(); } }, o.showTable ? 'Hide values' : 'Show values'),
      drafts.has(o.id) ? h('span', { class: 'embed-banner dirty' }, 'unapplied changes') : null);
    Object.assign(embedBar.style, { left: o.x * st.zoom + 'px', top: Math.max(0, o.y * st.zoom - 44) + 'px' });
    p.wrap.append(embedBar);
  }

  function embedRect(p, o) {
    const r = p.wrap.getBoundingClientRect();
    return { left: r.left + o.x * st.zoom, top: r.top + o.y * st.zoom, width: o.w * st.zoom, height: o.h * st.zoom };
  }

  async function openEmbed(p, o) {
    clearTimeout(saveT);
    await saveAnnotations(docId, ann);
    const q2 = `doc=${encodeURIComponent(docId)}&page=${p.i}&obj=${encodeURIComponent(o.id)}`;
    await zoomIn(o.snapshot, embedRect(p, o));
    navigate(o.kind === 'plc' ? `/plc/${o.state.scenarioId}?embed=1&${q2}` : `/circuit/embed?${q2}`);
  }

  async function insertEmbed() {
    const data = await insertSimulationDialog();
    if (!data) return;
    const p = pages[st.current];
    const w = Math.min(p.sz.w - 80, 330);
    const o = makeEmbed({ ...data, layer: activeLayer, x: (p.sz.w - w) / 2, y: 0, w });
    // place it in the part of the page that is on screen
    const r = p.wrap.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    const visTop = Math.max(0, (sr.top - r.top) / st.zoom);
    o.y = Math.max(20, Math.min(p.sz.h - o.h - 20, visTop + 40));
    // do not cover an object that is already there
    for (let k = 0; k < 6; k++) {
      const hitObj = pageObjs(p.i).find((e) => e.type === 'embed' && o.y < e.y + e.h + 6 && o.y + o.h > e.y - 6 && o.x < e.x + e.w && o.x + o.w > e.x);
      if (!hitObj || hitObj.y + hitObj.h + 10 + o.h > p.sz.h - 10) break;
      o.y = hitObj.y + hitObj.h + 10;
    }
    const before = snap(p.i);
    pageObjs(p.i).push(o);
    commit(p.i, before);
    setTool('select');
    select(o, p.i);
    // bring it into view if it landed below the visible part
    const oy = p.wrap.offsetTop + o.y * st.zoom;
    if (oy + o.h * st.zoom > scroller.scrollTop + scroller.clientHeight || oy < scroller.scrollTop) scroller.scrollTop = Math.max(0, oy - 90);
    updateEmbedBar();
    toast('Simulation inserted. Double-click it to open it.', 'ok', 3500);
  }

  // ---- pointer handling ------------------------------------------------------------------
  function bindPointer(p) {
    const c = p.annC;
    let cur = null;
    const pt = (e) => {
      const r = c.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * p.sz.w, ((e.clientY - r.top) / r.height) * p.sz.h];
    };
    const editable = (o) => o.layer === activeLayer && visibleLayers().has(o.layer);
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen') penSeen = true;
      if (e.pointerType === 'touch' && penSeen && st.tool !== 'select') return; // palm rejection
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const [x, y] = pt(e);
      setCurrent(p.i, false);
      const objs = pageObjs(p.i);
      // an embedded simulation is always clickable: no ink on top of it by accident
      if (st.tool !== 'select' && st.tool !== 'eraser' && [...objs].reverse().some((o) => o.type === 'embed' && editable(o) && hitTest(o, x, y, 0))) setTool('select');
      if (st.tool === 'pen' || st.tool === 'highlighter') {
        c.setPointerCapture(e.pointerId);
        const hl = st.tool === 'highlighter';
        cur = {
          mode: 'draw',
          o: { id: uid('o'), type: st.tool, color: hl ? st.hlColor : st.color, size: hl ? st.hlSize : st.size, opacity: hl ? 0.45 : 1, simulate: e.pointerType !== 'pen', points: [[x, y, e.pointerType === 'pen' ? e.pressure : 0.5]], layer: activeLayer },
          before: snap(p.i),
        };
      } else if (st.tool === 'eraser') {
        c.setPointerCapture(e.pointerId);
        cur = { mode: 'erase', before: snap(p.i) };
        eraseAt(p, x, y);
      } else if (st.tool === 'shape') {
        c.setPointerCapture(e.pointerId);
        cur = { mode: 'shape', o: { id: uid('o'), type: 'shape', shape: st.shape, x1: x, y1: y, x2: x, y2: y, color: st.color, size: st.size, layer: activeLayer }, before: snap(p.i) };
      } else if (st.tool === 'text') {
        const hit = [...objs].reverse().find((o) => o.type === 'text' && editable(o) && hitTest(o, x, y));
        editText(p, hit || null, x, y);
      } else if (st.tool === 'select') {
        const sel = st.selected && st.selPage === p.i ? st.selected : null;
        if (sel && (sel.type === 'image' || sel.type === 'text' || sel.type === 'embed')) {
          const b = bbox(sel);
          if (Math.abs(x - (b.x + b.w)) < 8 && Math.abs(y - (b.y + b.h)) < 8) {
            c.setPointerCapture(e.pointerId);
            cur = { mode: 'resize', o: sel, start: [x, y], orig: { ...sel }, before: snap(p.i) };
            return;
          }
        }
        const hit = [...objs].reverse().find((o) => editable(o) && hitTest(o, x, y, 5));
        select(hit || null, p.i);
        if (hit) {
          c.setPointerCapture(e.pointerId);
          cur = { mode: 'move', o: hit, last: [x, y], before: snap(p.i) };
        }
      }
    });
    c.addEventListener('pointermove', (e) => {
      if (!cur) {
        if (st.tool === 'select') {
          const [x, y] = pt(e);
          const sel = st.selected && st.selPage === p.i ? st.selected : null;
          let cursor = '';
          if (sel && (sel.type === 'image' || sel.type === 'text' || sel.type === 'embed')) {
            const b = bbox(sel);
            if (Math.abs(x - (b.x + b.w)) < 8 && Math.abs(y - (b.y + b.h)) < 8) cursor = 'nwse-resize';
          }
          if (!cursor && pageObjs(p.i).some((o) => editable(o) && hitTest(o, x, y, 5))) cursor = 'move';
          c.style.cursor = cursor;
        }
        return;
      }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (cur.mode === 'draw') {
        for (const ev of evs.length ? evs : [e]) {
          const [x, y] = pt(ev);
          cur.o.points.push([x, y, ev.pointerType === 'pen' ? ev.pressure : 0.5]);
        }
        drawAnnLive(p, cur.o);
      } else if (cur.mode === 'erase') {
        const [x, y] = pt(e);
        eraseAt(p, x, y);
      } else if (cur.mode === 'shape') {
        const [x, y] = pt(e);
        cur.o.x2 = x;
        cur.o.y2 = y;
        if (e.shiftKey && (cur.o.shape === 'rect' || cur.o.shape === 'ellipse')) {
          const d = Math.max(Math.abs(x - cur.o.x1), Math.abs(y - cur.o.y1));
          cur.o.x2 = cur.o.x1 + Math.sign(x - cur.o.x1) * d;
          cur.o.y2 = cur.o.y1 + Math.sign(y - cur.o.y1) * d;
        }
        drawAnn(p, cur.o);
      } else if (cur.mode === 'move') {
        const [x, y] = pt(e);
        translate(cur.o, x - cur.last[0], y - cur.last[1]);
        cur.last = [x, y];
        drawAnn(p);
      } else if (cur.mode === 'resize') {
        const [x, y] = pt(e);
        const o = cur.o;
        if (o.type === 'image') {
          const nw = Math.max(10, cur.orig.w + (x - cur.start[0]));
          o.w = nw;
          o.h = (nw * cur.orig.h) / cur.orig.w;
        } else if (o.type === 'embed') {
          o.w = Math.max(90, Math.min(p.sz.w - o.x, cur.orig.w + (x - cur.start[0])));
          o.h = embedHeight(o);
          updateEmbedBar();
        } else o.w = Math.max(30, cur.orig.w + (x - cur.start[0]));
        drawAnn(p);
      }
    });
    const end = () => {
      if (!cur) return;
      if (cur.mode === 'draw') {
        if (cur.o.points.length === 1) cur.o.points.push([cur.o.points[0][0] + 0.1, cur.o.points[0][1] + 0.1, 0.5]);
        pageObjs(p.i).push(cur.o);
      } else if (cur.mode === 'shape') {
        if (Math.hypot(cur.o.x2 - cur.o.x1, cur.o.y2 - cur.o.y1) > 2) pageObjs(p.i).push(cur.o);
        drawAnn(p);
      }
      commit(p.i, cur.before);
      cur = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      const [x, y] = pt(e);
      const emb = [...pageObjs(p.i)].reverse().find((o) => o.type === 'embed' && editable(o) && hitTest(o, x, y, 0));
      if (emb) { openEmbed(p, emb); return; }
      if (st.tool !== 'select') return;
      const hit = [...pageObjs(p.i)].reverse().find((o) => (o.type === 'text' || o.type === 'embed') && editable(o) && hitTest(o, x, y));
      if (hit && hit.type === 'embed') openEmbed(p, hit);
      else if (hit) editText(p, hit, x, y);
    });
  }

  // live stroke drawing on top of the cached page without re-rendering everything
  function drawAnnLive(p, o) {
    drawAnn(p, o);
  }

  function eraseAt(p, x, y) {
    const objs = pageObjs(p.i);
    const vis = visibleLayers();
    const tol = 6 / st.zoom;
    const keep = objs.filter((o) => !(o.layer === activeLayer && vis.has(o.layer) && hitTest(o, x, y, tol)));
    if (keep.length !== objs.length) {
      ann.pages[p.i] = keep;
      drawAnn(p);
    }
  }

  function editText(p, obj, x, y) {
    const before = snap(p.i);
    const isNew = !obj;
    const o = obj || { id: uid('o'), type: 'text', x, y: y - st.textSize * 0.6, w: Math.min(260, p.sz.w - x - 10), text: '', size: st.textSize, color: st.color, layer: activeLayer };
    if (isNew) pageObjs(p.i).push(o);
    const z = st.zoom;
    const ta = h('textarea', { class: 'text-edit', value: o.text });
    Object.assign(ta.style, { left: o.x * z + 'px', top: o.y * z + 'px', width: o.w * z + 'px', fontSize: o.size * z + 'px', color: o.color, lineHeight: 1.25 });
    const hidden = { ...o };
    o.text = '';
    drawAnn(p);
    p.wrap.append(ta);
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    setTimeout(() => { ta.focus(); fit(); }, 0);
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') ta.blur(); });
    ta.addEventListener('blur', () => {
      o.text = ta.value;
      ta.remove();
      if (!o.text.trim()) {
        ann.pages[p.i] = pageObjs(p.i).filter((x) => x !== o);
        if (!isNew) hidden.text = '';
      }
      commit(p.i, before);
      drawAnn(p);
    });
  }

  // keyboard
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); doRedo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected) {
      const i = st.selPage;
      const before = snap(i);
      ann.pages[i] = pageObjs(i).filter((o) => o !== st.selected);
      select(null, -1);
      commit(i, before);
      return;
    }
    if (mod) return;
    const t = TOOLS.find((x) => x[3] === e.code);
    if (t) setTool(t[0]);
    if (e.key === '+' || e.key === '=') setZoom(st.zoom * 1.2);
    if (e.key === '-') setZoom(st.zoom / 1.2);
    if (e.key === 'PageDown') gotoPage(Math.min(pages.length - 1, st.current + 1));
    if (e.key === 'PageUp') gotoPage(Math.max(0, st.current - 1));
  };
  window.addEventListener('keydown', onKey);

  // ---- export ----------------------------------------------------------------------------
  async function exportPdf() {
    try {
      const vis = visibleLayers();
      const pagesAnn = {};
      for (const [i, objs] of Object.entries(ann.pages)) pagesAnn[i] = objs.filter((o) => vis.has(o.layer));
      const out = await exportAnnotatedPdf(bytes, pagesAnn);
      const saved = await platform.saveFile(`${meta.name} (annotated).pdf`, out, { mime: 'application/pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (saved) toast('Exported annotated PDF (visible layers flattened)', 'ok');
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + e.message, 'err', 5000);
    }
  }

  // ---- simulations panel ------------------------------------------------------------------
  let pageInfoHost;
  function drawPanel() {
    clear(panel);
    if (!meta.analysis) meta.analysis = analyseDocument(meta.pagesText || []);
    const overall = meta.analysis.overall.filter((m) => m.score > 0).slice(0, 6);
    panel.append(h('div', { class: 'panel-h' }, h('b', {}, '🧪 Interactive simulations'), h('button', { class: 'btn tiny', title: 'Re-run the analysis', onclick: async () => { meta = { ...meta, analysis: analyseDocument(meta.pagesText || []) }; await updateDoc(meta); drawPanel(); toast('Re-analysed'); } }, '↻')));
    panel.append(h('p', { class: 'small muted' }, 'Keyword & pattern matching on the extracted text. Expand a match to see exactly which terms and values were found; edit parameters before launching.'));
    if (!overall.length) panel.append(h('div', { class: 'note' }, 'No built-in simulation was recognised. Link a page manually below.'));
    for (const m of overall) panel.append(matchCard(m));
    pageInfoHost = h('div');
    panel.append(pageInfoHost);
    drawPanelPage();
    panel.append(layersSection());
  }

  function matchCard(m, page) {
    const t = allTargets().find((x) => x.kind === m.kind && x.id === m.id);
    const vals = Object.fromEntries(m.params.map((p) => [p.key, p.value]));
    const pct = Math.round(m.confidence * 100);
    const details = h('details', { class: 'why' },
      h('summary', {}, `Why? ${m.hits.length} signal(s), score ${m.score.toFixed(1)}`),
      h('table', { class: 'hits' }, h('tbody', {}, m.hits.map((x) => h('tr', {}, h('td', {}, x.domain ? h('i', {}, x.term) : `“${x.term}”`), h('td', {}, `×${x.count}`), h('td', {}, `w ${x.weight}`), h('td', {}, `+${x.contrib.toFixed(1)}`))))),
      h('div', { class: 'small muted' }, 'confidence = 1 − e^(−score/10)'));
    const paramBox = h('div', { class: 'xparams' });
    if (m.params.length) {
      paramBox.append(h('div', { class: 'small' }, h('b', {}, 'Extracted parameters')));
      for (const p of m.params) {
        const pd = t.params.find((x) => x.key === p.key);
        const inp = pd && pd.options
          ? h('select', { class: 'input slim' }, pd.options.map((o) => h('option', { value: o, selected: o === p.value }, o)))
          : h('input', { class: 'input slim', value: p.value, type: 'number', step: 'any' });
        inp.addEventListener('change', () => { vals[p.key] = pd && pd.options ? inp.value : +inp.value; });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        paramBox.append(h('div', { class: 'xparam', title: `Pattern: /${p.pattern}/` }, h('span', {}, p.label), inp, h('span', { class: 'small muted' }, p.unit), h('div', { class: 'snip' }, p.snippet)));
      }
    } else paramBox.append(h('div', { class: 'small muted' }, 'No parameters found – defaults will be used.'));
    return h('div', { class: 'match-card' },
      h('div', { class: 'row between' }, h('b', {}, `${m.icon} ${m.name}`), h('span', { class: 'small muted' }, m.kind === 'plc' ? 'PLC · 3D' : 'circuit')),
      h('div', { class: 'conf' }, h('div', { class: 'conf-bar' }, h('i', { style: { width: pct + '%', background: pct >= 60 ? 'var(--ok)' : pct >= 35 ? 'var(--warn)' : 'var(--muted)' } })), h('span', {}, pct + '%')),
      details, paramBox,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small primary', onclick: () => navigate(launchUrl(m.kind, m.id, { docId, page: page ?? st.current, params: vals })) }, '▶ Launch'),
        h('button', { class: 'btn small', onclick: () => addLink(m.kind, m.id, vals, page ?? st.current) }, `🔗 Link to page ${(page ?? st.current) + 1}`)));
  }

  function drawPanelPage() {
    if (!pageInfoHost) return;
    clear(pageInfoHost);
    const i = st.current;
    const txt = (meta.pagesText || [])[i] || '';
    const links = (meta.links || []).filter((l) => l.page === i);
    const targetSel = h('select', { class: 'input slim' }, allTargets().map((t) => h('option', { value: `${t.kind}:${t.id}` }, `${t.icon} ${t.name}`)));
    const best = matchText(txt).find((m) => m.score > 0);
    if (best) targetSel.value = `${best.kind}:${best.id}`;
    const note = h('input', { class: 'input slim', placeholder: 'Note (optional)' });
    note.addEventListener('keydown', (e) => e.stopPropagation());
    pageInfoHost.append(...[
      h('div', { class: 'panel-h' }, h('b', {}, `📄 Page ${i + 1}`)),
      best ? h('div', { class: 'small' }, `Best match on this page: ${best.icon} ${best.name} (${Math.round(best.confidence * 100)}%)`) : h('div', { class: 'small muted' }, 'No match on this page.'),
      h('div', { class: 'link-form' }, h('label', { class: 'small' }, 'Link this page to any simulation (manual override):'), targetSel, note,
        h('button', { class: 'btn small', onclick: () => {
          const [kind, id] = targetSel.value.split(':');
          const t = allTargets().find((x) => x.kind === kind && x.id === id);
          const params = Object.fromEntries(extractParams(t, txt).map((p) => [p.key, p.value]));
          addLink(kind, id, params, i, note.value);
        } }, '🔗 Create link')),
      links.length ? h('div', { class: 'links' }, links.map((l) => linkRow(l))) : null,
      h('details', { class: 'why' }, h('summary', {}, 'Extracted text of this page'), h('pre', { class: 'page-text' }, txt || '(no text layer – scanned page?)'))].filter(Boolean));
    if (meta.links && meta.links.length) {
      pageInfoHost.append(h('div', { class: 'panel-h' }, h('b', {}, `🔗 All links (${meta.links.length})`)), h('div', { class: 'links' }, meta.links.map((l) => linkRow(l, true))));
    }
  }

  function linkRow(l, showPage) {
    const t = allTargets().find((x) => x.kind === l.kind && x.id === l.targetId);
    return h('div', { class: 'link-row' },
      h('span', { class: 'grow' }, showPage ? h('a', { href: 'javascript:void 0', onclick: () => gotoPage(l.page) }, `p.${l.page + 1}`) : null, ` ${t ? t.icon + ' ' + t.name : l.targetId}`, l.note ? h('div', { class: 'small muted' }, l.note) : null),
      h('button', { class: 'btn tiny primary', onclick: () => navigate(launchUrl(l.kind, l.targetId, { docId, page: l.page, params: l.params })) }, '▶'),
      h('button', { class: 'btn tiny', title: 'Remove link', onclick: async () => { meta = { ...meta, links: meta.links.filter((x) => x.id !== l.id) }; await updateDoc(meta); drawPanel(); drawPageLinks(); } }, '✕'));
  }

  async function addLink(kind, targetId, params, page, note = '') {
    const link = { id: uid('lnk'), kind, targetId, params, page, note, created: Date.now() };
    meta = { ...meta, links: [...(meta.links || []), link] };
    await updateDoc(meta);
    toast(`Linked page ${page + 1}`, 'ok');
    drawPanel();
    drawPageLinks();
  }

  function drawPageLinks() {
    for (const p of pages) {
      clear(p.links);
      const ls = (meta.links || []).filter((l) => l.page === p.i);
      for (const l of ls) {
        const t = allTargets().find((x) => x.kind === l.kind && x.id === l.targetId);
        p.links.append(h('a', { class: 'page-link', href: '#' + launchUrl(l.kind, l.targetId, { docId, page: l.page, params: l.params }), title: 'Launch linked simulation' }, `${t ? t.icon : '🔗'} ${t ? t.name : l.targetId} ▶`));
      }
      thumbEls[p.i].el.classList.toggle('linked', ls.length > 0);
    }
  }

  function layersSection() {
    const box = h('div', {}, h('div', { class: 'panel-h' }, h('b', {}, '▤ Annotation layers')),
      h('p', { class: 'small muted' }, 'Annotations are stored separately from the original PDF. Hidden layers are not exported.'));
    for (const l of ann.layers) {
      const vis = h('input', { type: 'checkbox', checked: l.visible });
      vis.addEventListener('change', () => { l.visible = vis.checked; save(); redrawAll(); });
      const name = h('input', { class: 'input slim', value: l.name });
      name.addEventListener('change', () => { l.name = name.value; save(); drawLayers(); });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      const count = Object.values(ann.pages).reduce((n, objs) => n + objs.filter((o) => o.layer === l.id).length, 0);
      box.append(h('div', { class: 'layer-row' + (l.id === activeLayer ? ' active' : '') }, vis, name, h('span', { class: 'small muted' }, `${count}`),
        ann.layers.length > 1 ? h('button', { class: 'btn tiny', title: 'Delete layer and its annotations', onclick: async () => {
          const ok = await modal('Delete layer?', h('p', {}, `Delete “${l.name}” and its ${count} annotation(s)?`), [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }]);
          if (!ok) return;
          ann.layers = ann.layers.filter((x) => x !== l);
          for (const k of Object.keys(ann.pages)) ann.pages[k] = ann.pages[k].filter((o) => o.layer !== l.id);
          if (activeLayer === l.id) activeLayer = ann.layers[0].id;
          undo.length = redo.length = 0;
          save(); drawLayers(); drawPanel(); redrawAll();
        } }, '🗑') : null));
    }
    return box;
  }

  // ---- init ------------------------------------------------------------------------------
  drawLayers();
  setTool('pen');
  updateUndoBtns();
  drawPanel();
  drawPageLinks();
  requestAnimationFrame(() => {
    if (sess) {
      // back from a simulation: same zoom, same scroll position
      setZoom(sess.zoom);
      scroller.scrollTop = sess.scrollTop;
      scroller.scrollLeft = sess.scrollLeft;
      let target = null;
      if (q.obj) {
        for (const p of pages) { const o = pageObjs(p.i).find((x) => x.id === q.obj); if (o) { target = embedRect(p, o); break; } }
      }
      finishTransition(false, target);
      if (q.page != null && !q.back) gotoPage(Math.min(pages.length - 1, +q.page));
      return;
    }
    finishTransition(true);
    fitWidth();
    const startPage = q.page != null ? Math.min(pages.length - 1, +q.page) : 0;
    if (startPage) setTimeout(() => gotoPage(startPage), 50);
  });
  const onResize = () => pages.filter((p) => p.visible).forEach(renderPage);
  window.addEventListener('resize', onResize);

  window.__ed = { st, ann, scroller, pages, undo, redo, get drafts() { return drafts; } }; // handy for debugging from the console

  return {
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      io.disconnect();
      tio.disconnect();
      clearTimeout(saveT);
      saveAnnotations(docId, ann);
      saveSession(docId, { zoom: st.zoom, scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft, undo, redo });
      if (window.__ed && window.__ed.ann === ann) window.__ed = null;
      pdf.destroy();
    },
  };
}
