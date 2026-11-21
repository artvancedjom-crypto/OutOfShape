// UI pieces for simulations embedded in documents: the insert dialog, the
// "what to do with your changes" dialog and the zoom transition between
// document and simulation.
import { h, toast } from '../core/dom.js';
import { db, uid } from '../core/db.js';
import { CIRCUITS } from '../circuits/library.js';
import { SCENE_TEMPLATES } from '../kit/templates.js';
import { openScene, listUserScenes, saveScene, isSceneTemplate, sceneWorkingId } from '../kit/store.js';
import { kitDefsUsedBy } from '../kit/catalog.js';
import { openCircuit, listUserCircuits, saveCircuit, isTemplateId, workingId } from '../circuits/store.js';
import { snapshotOf } from '../circuits/snapshot.js';
import { sceneSnapshotOf } from '../kit/snapshot.js';

function overlayDialog(title, body, buttons) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.remove(); resolve(v); };
    back.append(h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: () => close(null) }, '✕')),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), 'data-value': b.value, onclick: async () => { const r = b.run ? await b.run() : b.value; if (r !== false) close(r); } }, b.label)))));
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); e.stopPropagation(); });
    document.body.append(back);
  });
}

/**
 * Choose what to embed. Resolves with the data for makeEmbed(), or null.
 * @returns {Promise<null|{kind:string,title:string,state:any,link:any,snapshot:string,imgW:number,imgH:number,table:any[]}>}
 */
export async function insertSimulationDialog() {
  const mine = await listUserCircuits();
  const sel = h('select', { class: 'input', size: 9, style: { width: '100%' } });
  const group = (label, items) => { if (items.length) sel.append(h('optgroup', { label }, items.map(([v, t]) => h('option', { value: v }, t)))); };
  group('Circuit templates', CIRCUITS.map((c) => [`circuit:${c.id}`, `${c.icon} ${c.name}`]));
  group('My circuits', mine.map((c) => [`circuit:${c.id}`, `🔌 ${c.name}`]));
  group('PLC plant templates', SCENE_TEMPLATES.map((s) => [`plc:${s.id}`, `${s.icon} ${s.name}`]));
  group('My plants', (await listUserScenes()).map((s) => [`plc:${s.id}`, `🏭 ${s.name}`]));
  sel.selectedIndex = 0;
  const own = h('input', { type: 'radio', name: 'emb-own', checked: true });
  const linked = h('input', { type: 'radio', name: 'emb-own' });
  const body = h('div', { class: 'form' },
    h('label', {}, 'Simulation', sel),
    h('label', { class: 'row gap', style: { fontWeight: 500 } }, own, h('span', {}, h('b', {}, 'Own copy'), h('div', { class: 'small muted' }, 'Independent of the original and of other documents. Editing it changes only this object.'))),
    h('label', { class: 'row gap', style: { fontWeight: 500 } }, linked, h('span', {}, h('b', {}, 'Linked'), h('div', { class: 'small muted' }, 'Shares one simulation with the original and with every other place where it is embedded as linked. Applying a change updates all of them.'))),
    h('p', { class: 'small muted' }, 'The object shows a snapshot and a table of key values. Double-click it later to open the simulation in that state.'));
  return overlayDialog('Insert simulation', body, [
    { label: 'Cancel', value: null },
    { label: 'Insert', primary: true, run: async () => {
      const [kind, id] = sel.value.split(':');
      try {
        if (kind === 'circuit') {
          const opened = await openCircuit(id);
          const doc = opened.doc;
          let link = null;
          if (linked.checked) {
            // make sure the original exists as a stored circuit that both sides can follow
            if (isTemplateId(id)) { doc.id = workingId(id); await saveCircuit(doc); }
            link = { store: 'circuits', id: doc.id };
          }
          const snap = await snapshotOf(doc);
          return { kind, title: doc.name, state: JSON.parse(JSON.stringify(doc)), link, snapshot: snap.dataUrl, imgW: snap.width, imgH: snap.height, table: snap.table };
        }
        const opened = await openScene(id);
        const doc = opened.doc;
        doc.defs = kitDefsUsedBy(doc);
        let link = null;
        if (linked.checked) {
          if (isSceneTemplate(id)) { doc.id = sceneWorkingId(id); await saveScene(doc); }
          link = { store: 'scenes', id: doc.id };
        }
        const snap = await sceneSnapshotOf(doc);
        return { kind, title: doc.name, state: JSON.parse(JSON.stringify(doc)), link, snapshot: snap.dataUrl, imgW: snap.width, imgH: snap.height, table: snap.table };
      } catch (e) {
        console.error(e);
        toast('Could not create the snapshot: ' + e.message, 'err', 6000);
        return false;
      }
    } },
  ]);
}

/** Leaving an edited embedded simulation. Resolves 'apply' | 'new-version' | 'discard' | null (stay). */
export function leaveDialog(docName) {
  return overlayDialog('You changed this simulation', h('div', {},
    h('p', {}, `The object in “${docName}” still shows the old state.`),
    h('ul', { class: 'small' },
      h('li', {}, h('b', {}, 'Apply changes'), ': update the snapshot, the values and the simulation in the document (can be undone there).'),
      h('li', {}, h('b', {}, 'Save as new version'), ': keep the old object and add the changed one next to it.'),
      h('li', {}, h('b', {}, 'Discard'), ': throw the changes away.'))), [
    { label: 'Keep editing', value: null },
    { label: 'Discard', value: 'discard', danger: true },
    { label: 'Save as new version', value: 'new-version' },
    { label: 'Apply changes', value: 'apply', primary: true },
  ]);
}

// ---- zoom transition ------------------------------------------------------------------
let overlay = null;

/** Grow a picture from a rectangle on screen to the whole work area, then keep it until the next view is ready. */
export function zoomIn(src, rect) {
  finishTransition(true);
  const main = document.getElementById('view').getBoundingClientRect();
  const el = h('div', { class: 'embed-zoom' }, h('img', { src }));
  Object.assign(el.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  document.body.append(el);
  overlay = el;
  // next frame: animate to the full area
  requestAnimationFrame(() => {
    Object.assign(el.style, { left: main.left + 'px', top: main.top + 'px', width: main.width + 'px', height: main.height + 'px' });
  });
  return new Promise((r) => setTimeout(r, 230));
}

/** Cover the work area with a picture immediately (used when going back to the document). */
export function coverWith(src) {
  finishTransition(true);
  if (!src) return;
  const main = document.getElementById('view').getBoundingClientRect();
  const el = h('div', { class: 'embed-zoom' }, h('img', { src }));
  Object.assign(el.style, { left: main.left + 'px', top: main.top + 'px', width: main.width + 'px', height: main.height + 'px', transition: 'none' });
  document.body.append(el);
  overlay = el;
}

/** The new view is drawn: fade the picture away (optionally shrinking onto a target rectangle). */
export function finishTransition(now = false, toRect = null) {
  const el = overlay;
  if (!el) return;
  overlay = null;
  if (now) { el.remove(); return; }
  el.style.transition = 'all 0.24s ease';
  requestAnimationFrame(() => {
    if (toRect) Object.assign(el.style, { left: toRect.left + 'px', top: toRect.top + 'px', width: toRect.width + 'px', height: toRect.height + 'px' });
    el.style.opacity = '0';
  });
  setTimeout(() => el.remove(), 280);
}

export const transitionPending = () => !!overlay;
export { uid };
