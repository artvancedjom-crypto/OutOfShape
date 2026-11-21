// Catalog user interface: palette with favourites, the catalog manager, the
// variant editor (with characteristic-curve preview) and the subcircuit dialog.
import { h, clear, toast } from '../core/dom.js';
import { platform } from '../platform/index.js';
import { PARTS, CATEGORY_ORDER } from '../circuits/parts.js';
import {
  catalogList, favourites, toggleFavourite, saveEntry, deleteEntry, listEntries, exportEntries, importEntries,
  characteristic, fitDiodeIs, MODEL_INFO, isBuiltin, subcircuitLayout, newEntryId, entryToDef, validateEntry,
} from '../circuits/catalog.js';
import { parseSI, editSI, formatSI } from '../circuits/units.js';

const defaults = (def) => Object.fromEntries(def.params.map((p) => [p.key, p.def]));
const symbolSvg = (def, params) => {
  const b = def.bbox || [-2, -1, 2, 1];
  const pad = 12;
  const x = b[0] * 20 - pad; const y = Math.min(b[1] * 20, -30) - pad;
  const w = (b[2] - b[0]) * 20 + 2 * pad; const hgt = Math.max(b[3] * 20, 30) - Math.min(b[1] * 20, -30) + 2 * pad;
  return `<svg viewBox="${x} ${y} ${w} ${hgt}"><g class="ce-part">${def.symbol(params || defaults(def), null)}</g></svg>`;
};

/** Generic dialog. onOk may return false (or throw) to keep it open. */
function dialog(title, body, { okLabel = 'OK', onOk, wide = false, cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); resolve(v); };
    const ok = h('button', { class: 'btn primary', onclick: async () => {
      try { const r = onOk ? await onOk() : true; if (r !== false) close(r === undefined ? true : r); } catch (e) { toast(e.message, 'err', 5000); }
    } }, okLabel);
    back.append(h('div', { class: 'modal' + (wide ? ' wide' : '') },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: () => close(null) }, '✕')),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, cancelLabel ? h('button', { class: 'btn', onclick: () => close(null) }, cancelLabel) : null, onOk || okLabel ? ok : null)));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    document.body.append(back);
  });
}

export function drawCurve(canvas, ch) {
  const g = canvas.getContext('2d');
  const W = canvas.width; const H = canvas.height;
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--code-bg') || '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = css.getPropertyValue('--muted') || '#888';
  g.font = '11px sans-serif';
  if (!ch) { g.fillText('No characteristic curve for this model.', 12, H / 2); return; }
  const all = ch.series.flatMap((s) => s.pts);
  let x1 = Math.max(...all.map((p) => p[0]), 1e-12); let y1 = Math.max(...all.map((p) => p[1]), 1e-12);
  for (const m of ch.marks || []) { if (m.x !== undefined) x1 = Math.max(x1, m.x * 1.05); if (m.y !== undefined) y1 = Math.max(y1, m.y * 1.1); }
  const L = 46; const B = 24; const T = 18; const R = 10;
  const X = (x) => L + (x / x1) * (W - L - R);
  const Y = (y) => H - B - (Math.max(0, y) / y1) * (H - B - T);
  g.strokeStyle = css.getPropertyValue('--line') || '#ccc';
  g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const yy = T + ((H - B - T) * k) / 4; g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
    g.fillText(formatSI((y1 * (4 - k)) / 4, '', 2), 2, yy + 4);
    const xx = L + ((W - L - R) * k) / 4; g.beginPath(); g.moveTo(xx, T); g.lineTo(xx, H - B); g.stroke();
    g.fillText(formatSI((x1 * k) / 4, '', 2), xx - 8, H - 8);
  }
  g.fillText(`${ch.y}  ·  ${ch.x} →`, L, 12);
  const colors = ['#3366ff', '#ff9f1c', '#1fa363', '#e0393e'];
  ch.series.forEach((s, k) => {
    g.strokeStyle = colors[k % 4]; g.lineWidth = 2; g.beginPath();
    s.pts.forEach((p, i) => { if (i) g.lineTo(X(p[0]), Y(Math.min(p[1], y1 * 1.2))); else g.moveTo(X(p[0]), Y(p[1])); });
    g.stroke();
    g.fillStyle = colors[k % 4]; g.fillText(s.label, W - R - 150, T + 12 + k * 13);
  });
  g.setLineDash([4, 3]); g.strokeStyle = '#e0393e'; g.fillStyle = '#e0393e';
  for (const m of ch.marks || []) {
    g.beginPath();
    if (m.y !== undefined) { g.moveTo(L, Y(m.y)); g.lineTo(W - R, Y(m.y)); g.fillText(m.label, L + 4, Y(m.y) - 3); }
    else { g.moveTo(X(m.x), T); g.lineTo(X(m.x), H - B); g.fillText(m.label, X(m.x) + 3, T + 10); }
    g.stroke();
  }
  g.setLineDash([]);
}

// ---------------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------------
export async function renderPalette(host, { onPick, onManage }) {
  clear(host);
  const favs = await favourites();
  const search = h('input', { class: 'input slim', placeholder: 'Search parts…' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const list = h('div', { class: 'ce-pal-list' });
  const item = (type, def) => {
    const star = h('span', { class: 'ce-star' + (favs.has(type) ? ' on' : ''), title: favs.has(type) ? 'Remove from favourites' : 'Add to favourites' }, favs.has(type) ? '★' : '☆');
    star.addEventListener('click', async (e) => { e.stopPropagation(); await toggleFavourite(type); fill(); });
    return h('button', { class: 'ce-pal-item', title: `Place ${def.name}${def.entry ? ' (my part)' : ''}`, 'data-type': type, onclick: () => onPick(type) },
      h('span', { class: 'ce-pal-sym', html: symbolSvg(def) }), h('span', { class: 'grow' }, def.name, def.entry ? h('i', { class: 'ce-mine' }, def.subcircuit ? 'sub' : 'mine') : null), star);
  };
  function fill() {
    clear(list);
    const term = search.value.trim().toLowerCase();
    const all = catalogList().filter(({ def }) => !term || def.name.toLowerCase().includes(term) || (def.entry && (def.entry.description || '').toLowerCase().includes(term)));
    const fav = all.filter(({ type }) => favs.has(type));
    if (fav.length) { list.append(h('div', { class: 'menu-h' }, '★ Favourites')); fav.forEach(({ type, def }) => list.append(item(type, def))); }
    const cats = [...CATEGORY_ORDER, ...new Set(all.map(({ def }) => def.category).filter((c) => !CATEGORY_ORDER.includes(c)))];
    for (const cat of cats) {
      const items = all.filter(({ def }) => def.category === cat);
      if (!items.length) continue;
      list.append(h('div', { class: 'menu-h' }, cat));
      items.forEach(({ type, def }) => list.append(item(type, def)));
    }
    if (!all.length) list.append(h('p', { class: 'small muted' }, 'No part matches.'));
  }
  search.addEventListener('input', fill);
  host.append(search, list, h('button', { class: 'btn small', onclick: onManage, title: 'Browse all parts, create your own, import and export' }, '📚 Catalog…'));
  fill();
}

// ---------------------------------------------------------------------------------
// Variant editor
// ---------------------------------------------------------------------------------
export async function variantDialog({ base, entry = null }) {
  const baseType = entry ? entry.base : base;
  const baseDef = PARTS[baseType];
  const values = { ...defaults(baseDef), ...(entry ? entry.params : {}) };
  const errors = new Map();
  const stop = (el) => { el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
  const name = stop(h('input', { class: 'input', value: entry ? entry.name : `${baseDef.name} (my version)` }));
  const cat = h('select', { class: 'input' }, CATEGORY_ORDER.map((c) => h('option', { value: c, selected: c === (entry ? entry.category : baseDef.category) }, c)));
  const desc = stop(h('input', { class: 'input', value: entry ? entry.description || '' : '', placeholder: 'e.g. datasheet, manufacturer, order number' }));
  const canvas = h('canvas', { class: 'curve', width: 440, height: 230 });
  const sym = h('div', { class: 'cat-sym' });
  const inputs = new Map();
  const preview = () => {
    try { drawCurve(canvas, errors.size ? null : characteristic(baseType, values)); } catch (e) { drawCurve(canvas, null); }
    sym.innerHTML = symbolSvg(baseDef, values);
  };
  const fields = h('div', { class: 'part-form' });
  for (const prm of baseDef.params) {
    if (prm.transient) continue;
    const msg = h('div', { class: 'field-err' });
    const hint = h('span', { class: 'field-hint' });
    let inp;
    if (prm.type === 'select') { inp = h('select', { class: 'input slim' }, prm.options.map((o) => h('option', { value: o, selected: values[prm.key] === o }, o))); inp.addEventListener('change', () => { values[prm.key] = inp.value; preview(); }); }
    else if (prm.type === 'bool') { inp = h('input', { type: 'checkbox', checked: !!values[prm.key] }); inp.addEventListener('change', () => { values[prm.key] = inp.checked; preview(); }); }
    else if (prm.type === 'text') { inp = stop(h('input', { class: 'input slim', value: values[prm.key] ?? '' })); inp.addEventListener('input', () => { values[prm.key] = inp.value.trim(); }); }
    else {
      inp = stop(h('input', { class: 'input slim', value: editSI(values[prm.key]), spellcheck: false }));
      const check = () => {
        const v = parseSI(inp.value);
        if (Number.isNaN(v)) errors.set(prm.key, 'Not a number. Examples: 470, 4k7, 100n, 1e-14');
        else if (prm.min !== undefined && v < prm.min) errors.set(prm.key, `Must be at least ${formatSI(prm.min, prm.unit)}.`);
        else if (prm.max !== undefined && v > prm.max) errors.set(prm.key, `Must be at most ${formatSI(prm.max, prm.unit)}.`);
        else { errors.delete(prm.key); values[prm.key] = v; }
        msg.textContent = errors.get(prm.key) || '';
        hint.textContent = errors.has(prm.key) ? '' : `= ${formatSI(values[prm.key], prm.unit)}`;
        inp.classList.toggle('bad', errors.has(prm.key));
        preview();
      };
      inp.addEventListener('input', check);
      hint.textContent = `= ${formatSI(values[prm.key], prm.unit)}`;
      inp._check = check;
    }
    inputs.set(prm.key, inp);
    fields.append(h('label', { class: 'field' + (prm.type === 'bool' ? ' inline' : ''), 'data-key': prm.key }, h('span', {}, prm.label, prm.unit && prm.type !== 'bool' ? h('i', {}, ` [${prm.unit}]`) : null, prm.limit ? h('em', {}, ' limit') : null), inp, hint, msg));
  }
  // datasheet helper for diodes
  let helper = null;
  if (baseType === 'D' || baseType === 'LED') {
    const vf = stop(h('input', { class: 'input slim', value: baseType === 'LED' ? '2.0' : '0.7', title: 'Forward voltage from the datasheet' }));
    const iff = stop(h('input', { class: 'input slim', value: '20m', title: 'at this forward current' }));
    const nn = stop(h('input', { class: 'input slim', value: '2', title: 'Emission coefficient: 1…2 for silicon diodes, about 2 for LEDs' }));
    helper = h('div', { class: 'note helper' }, h('b', {}, 'From a datasheet'), h('div', { class: 'row gap' }, 'U', h('sub', {}, 'F'), vf, 'V at I', h('sub', {}, 'F'), iff, 'A, n =', nn,
      h('button', { class: 'btn small', onclick: () => {
        const V = parseSI(vf.value); const I = parseSI(iff.value); const N = parseSI(nn.value);
        if (!(V > 0) || !(I > 0) || !(N > 0.5 && N < 5)) { toast('Enter a forward voltage, a forward current and n between 0.5 and 5.', 'err'); return; }
        const Is = fitDiodeIs(V, I, N);
        for (const [k, v] of [['Is', Is], ['n', N]]) { const el = inputs.get(k); el.value = editSI(v); el._check(); }
        toast(`Is = ${Is.toExponential(3)} A fitted: the curve now passes through ${V} V at ${formatSI(I, 'A')}`, 'ok', 4000);
      } }, 'Calculate Is')));
  }
  const body = h('div', { class: 'variant-form' },
    h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Category'), cat),
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('div', { class: 'small muted', style: { margin: '8px 0' } }, `Model: ${baseDef.name} · ${MODEL_INFO[baseType] || ''}`),
      helper, fields),
    h('div', {}, h('div', { class: 'small muted' }, 'Characteristic (updates while you type)'), canvas, h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Symbol'), sym));
  preview();
  return dialog(entry ? `Edit “${entry.name}”` : `New variant of ${baseDef.name}`, body, {
    okLabel: 'Save to catalog', wide: true,
    onOk: async () => {
      if (!name.value.trim()) { toast('Give the part a name.', 'err'); return false; }
      if (errors.size) { toast('Fix the fields marked in red first.', 'err'); return false; }
      const clash = catalogList().some(({ type, def }) => def.name.toLowerCase() === name.value.trim().toLowerCase() && (!entry || type !== entry.id));
      if (clash) { toast(`A part called “${name.value.trim()}” already exists.`, 'err'); return false; }
      const params = {};
      for (const prm of baseDef.params) if (!prm.transient && values[prm.key] !== prm.def) params[prm.key] = values[prm.key];
      return saveEntry({ ...(entry || {}), kind: 'variant', id: entry ? entry.id : newEntryId(), name: name.value.trim(), category: cat.value, description: desc.value.trim(), base: baseType, params });
    },
  });
}

// ---------------------------------------------------------------------------------
// Subcircuit from the current circuit
// ---------------------------------------------------------------------------------
export async function subcircuitDialog(doc) {
  const labels = [...new Set(doc.labels.map((l) => String(l.text).trim()).filter((t) => t && !/^(gnd|0)$/i.test(t)))];
  if (!labels.length) {
    await dialog('Save as catalog part', h('div', {}, h('p', {}, 'A subcircuit needs outer pins. Mark each connection point of this circuit with a net label first (tool 🏷, for example IN, OUT, VCC).'), h('p', { class: 'small muted' }, 'Ground symbols inside the subcircuit stay connected to the common ground of the circuit it is used in.')), { okLabel: null, cancelLabel: 'Close' });
    return null;
  }
  const stop = (el) => { el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
  const name = stop(h('input', { class: 'input', value: doc.name }));
  const abbr = stop(h('input', { class: 'input', value: doc.name.slice(0, 10), maxlength: 14 }));
  const cat = h('select', { class: 'input' }, CATEGORY_ORDER.map((c) => h('option', { value: c }, c)));
  const desc = stop(h('input', { class: 'input', placeholder: 'What does it do?' }));
  const color = h('input', { type: 'color', value: '#dfeaff' });
  const rows = labels.map((t, k) => {
    const use = h('input', { type: 'checkbox', checked: true });
    const side = h('select', { class: 'input slim' }, h('option', { value: 'left', selected: k < Math.ceil(labels.length / 2) }, 'left'), h('option', { value: 'right', selected: k >= Math.ceil(labels.length / 2) }, 'right'));
    return { t, use, side };
  });
  const sym = h('div', { class: 'cat-sym big' });
  const build = () => ({
    kind: 'subcircuit', name: name.value.trim(), abbr: abbr.value.trim(), category: cat.value, description: desc.value.trim(), color: color.value, prefix: 'X',
    pins: rows.filter((r) => r.use.checked).map((r) => ({ name: r.t, side: r.side.value })),
    circuit: JSON.parse(JSON.stringify({ parts: doc.parts, wires: doc.wires, labels: doc.labels })),
  });
  const preview = () => { const e = build(); sym.innerHTML = e.pins.length ? symbolSvg(entryToDef({ ...e, id: 'preview' })) : '<p class="small muted">Tick at least one pin.</p>'; };
  for (const el of [name, abbr, color, ...rows.flatMap((r) => [r.use, r.side])]) el.addEventListener('input', preview);
  preview();
  const body = h('div', { class: 'variant-form' },
    h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Text on the symbol'), abbr),
      h('label', { class: 'field' }, h('span', {}, 'Category'), cat),
      h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
      h('label', { class: 'field inline' }, h('span', {}, 'Symbol colour'), color),
      h('h4', {}, 'Outer pins (from the net labels of this circuit)'),
      h('table', { class: 'io-table' }, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.use), h('td', { class: 'name' }, r.t), h('td', {}, r.side))))),
      h('p', { class: 'small muted' }, `Contains ${doc.parts.filter((p) => p.type !== 'GND').length} parts. Ground symbols inside stay connected to the common ground.`)),
    h('div', {}, h('div', { class: 'small muted' }, 'Symbol'), sym));
  return dialog('Save circuit as a catalog part', body, {
    okLabel: 'Save to catalog', wide: true,
    onOk: async () => {
      const e = build();
      if (!e.name) { toast('Give the part a name.', 'err'); return false; }
      if (!e.pins.length) { toast('Tick at least one outer pin.', 'err'); return false; }
      if (catalogList().some(({ def }) => def.name.toLowerCase() === e.name.toLowerCase())) { toast(`A part called “${e.name}” already exists.`, 'err'); return false; }
      validateEntry(e);
      return saveEntry({ ...e, id: newEntryId() });
    },
  });
}

// ---------------------------------------------------------------------------------
// Catalog manager
// ---------------------------------------------------------------------------------
export async function openCatalogManager({ onChange } = {}) {
  let selected = 'R';
  let filter = 'All';
  const list = h('div', { class: 'cat-list' });
  const detail = h('div', { class: 'cat-detail' });
  const search = h('input', { class: 'input slim', placeholder: 'Search…' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const filterSel = h('select', { class: 'input slim' }, ['All', 'My parts', '★ Favourites', ...CATEGORY_ORDER].map((c) => h('option', { value: c }, c)));
  const changed = () => { if (onChange) onChange(); };
  const favs = await favourites();

  function drawList() {
    clear(list);
    const term = search.value.trim().toLowerCase();
    const items = catalogList().filter(({ type, def }) => (!term || def.name.toLowerCase().includes(term))
      && (filter === 'All' || (filter === 'My parts' ? !!def.entry : filter === '★ Favourites' ? favs.has(type) : def.category === filter)));
    for (const { type, def } of items) {
      list.append(h('button', { class: 'cat-row' + (type === selected ? ' active' : ''), 'data-type': type, onclick: () => { selected = type; drawList(); drawDetail(); } },
        h('span', { class: 'ce-pal-sym', html: symbolSvg(def) }), h('span', { class: 'grow' }, h('b', {}, def.name), h('div', { class: 'small muted' }, def.category + (def.entry ? def.subcircuit ? ' · my subcircuit' : ` · my variant of ${PARTS[def.entry.base].name}` : ''))),
        favs.has(type) ? h('span', { class: 'ce-star on' }, '★') : null));
    }
    if (!items.length) list.append(h('p', { class: 'small muted', style: { padding: '10px' } }, 'Nothing here yet.'));
  }

  function drawDetail() {
    clear(detail);
    const def = PARTS[selected];
    if (!def) return;
    const entry = def.entry;
    const baseType = entry ? entry.base : selected;
    const canvas = h('canvas', { class: 'curve', width: 440, height: 210 });
    const acts = h('div', { class: 'row gap' });
    acts.append(h('button', { class: 'btn small', onclick: async () => { await toggleFavourite(selected); drawList(); drawDetail(); changed(); } }, favs.has(selected) ? '★ Favourite' : '☆ Add to favourites'));
    if (!def.subcircuit && def.params.length && isBuiltin(baseType)) acts.append(h('button', { class: 'btn small primary', onclick: async () => { const e = await variantDialog({ base: baseType }); if (e) { selected = e.id; drawList(); drawDetail(); changed(); toast(`“${e.name}” added to the catalog`, 'ok'); } } }, '＋ New variant of this model'));
    if (entry) {
      if (entry.kind === 'variant') acts.append(h('button', { class: 'btn small', onclick: async () => { const e = await variantDialog({ entry }); if (e) { drawList(); drawDetail(); changed(); } } }, '✎ Edit'));
      acts.append(h('button', { class: 'btn small', onclick: () => platform.saveFile(`${entry.name}.catalog.json`, exportEntries([entry]), { mime: 'application/json', filters: [{ name: 'Catalog', extensions: ['json'] }] }) }, '⬇ Export'));
      acts.append(h('button', { class: 'btn small danger', onclick: async () => {
        const ok = await dialog('Delete from catalog?', h('p', {}, `“${entry.name}” is removed from the catalog. Circuits that already use it keep their own copy.`), { okLabel: 'Delete', onOk: () => true });
        if (ok) { await deleteEntry(entry.id); selected = 'R'; drawList(); drawDetail(); changed(); }
      } }, '🗑 Delete'));
    }
    const prmRows = def.params.filter((p) => !p.transient).map((p) => h('tr', {}, h('td', { class: 'name' }, p.label), h('td', { class: 'val' }, p.type === 'bool' ? (p.def ? 'yes' : 'no') : p.type === 'select' || p.type === 'text' ? String(p.def) : formatSI(p.def, p.unit)), h('td', { class: 'small muted' }, p.limit ? 'rated limit' : p.unit || '')));
    detail.append(
      h('div', { class: 'row between' }, h('h3', {}, def.name), h('span', { class: 'badge ' + (entry ? 'diff-beginner' : 'diff-intermediate') }, entry ? 'My part' : 'Built-in')),
      entry && entry.description ? h('p', { class: 'small' }, entry.description) : null,
      acts,
      h('div', { class: 'cat-cols' },
        h('div', {}, h('h4', {}, 'Symbol'), h('div', { class: 'cat-sym big', html: symbolSvg(def) }),
          h('h4', {}, 'Pins'), h('p', { class: 'small' }, def.pins.map((p) => p.name).join(' · ')),
          h('h4', {}, 'Simulation model'), h('p', { class: 'small' }, def.subcircuit ? `Subcircuit of ${def.subcircuit.circuit.parts.filter((p) => p.type !== 'GND').length} parts: ${[...new Set(def.subcircuit.circuit.parts.filter((p) => p.type !== 'GND').map((p) => (PARTS[p.type] ? PARTS[p.type].name : p.type)))].join(', ')}` : MODEL_INFO[baseType] || '')),
        h('div', {}, prmRows.length ? h('h4', {}, 'Parameters and defaults') : null, prmRows.length ? h('table', { class: 'io-table compact' }, h('tbody', {}, prmRows)) : null,
          def.subcircuit ? null : h('h4', {}, 'Characteristic'), def.subcircuit ? null : canvas)));
    if (!def.subcircuit) { try { drawCurve(canvas, characteristic(baseType, defaults(def))); } catch { drawCurve(canvas, null); } }
  }

  search.addEventListener('input', drawList);
  filterSel.addEventListener('change', () => { filter = filterSel.value; drawList(); });
  const body = h('div', { class: 'cat-manager' },
    h('div', { class: 'cat-left' }, h('div', { class: 'row gap' }, search, filterSel), list,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn small', onclick: async () => {
          const [f] = await platform.pickFiles({ accept: '.json', filters: [{ name: 'Catalog', extensions: ['json'] }] });
          if (!f) return;
          try { const r = await importEntries(await f.text()); toast(`Imported ${r.added} new and ${r.updated} updated part(s): ${r.names.slice(0, 4).join(', ')}`, 'ok', 4500); drawList(); changed(); } catch (e) { toast('Import failed: ' + e.message, 'err', 6000); }
        } }, '⬆ Import JSON…'),
        h('button', { class: 'btn small', onclick: async () => {
          const mine = await listEntries();
          if (!mine.length) { toast('You have no own parts yet.', 'err'); return; }
          platform.saveFile('my-parts.catalog.json', exportEntries(mine), { mime: 'application/json', filters: [{ name: 'Catalog', extensions: ['json'] }] });
        } }, '⬇ Export my parts'))),
    detail);
  drawList();
  drawDetail();
  await dialog('Component catalog', body, { okLabel: null, cancelLabel: 'Close', wide: true });
}
