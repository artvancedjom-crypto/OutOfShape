// Simulations embedded in document pages.
//
// The embed is an annotation object on the page:
//   { id, type:'embed', kind:'circuit'|'plc', x, y, w, h, layer, title,
//     snapshot (PNG data URL), imgW, imgH, table:[{label,value}], showTable,
//     state: {...},            // the simulation itself: an independent instance
//     link: {store, id}|null,  // set when it is shared with an original / other documents
//     version }
//
// Because the state lives inside the object, it is saved, backed up, undone and
// redone together with the page. Edits made in the simulation go to a DRAFT first
// (kv store); the document only changes when the user applies them.
import { db, uid } from '../core/db.js';
import { getAnnotations, saveAnnotations, getDoc, updateDoc } from './store.js';
import { pushUndo } from './session.js';

const draftKey = (docId, objId) => `embed-draft:${docId}:${objId}`;
export const HEADER = 15; // pt
export const ROW = 11; // pt per table row
export const stable = (state) => JSON.stringify(state, (k, v) => (k === 'updated' || k === 'created' || k === 'defs' ? undefined : v));

/** Height of the object for a given width, image aspect and table. */
export function embedHeight(o) {
  const imgH = (o.w * o.imgH) / o.imgW;
  return HEADER + imgH + (o.showTable && o.table.length ? 6 + o.table.length * ROW : 0);
}

export function makeEmbed({ kind, title, state, snapshot, imgW, imgH, table, link = null, layer, x, y, w }) {
  const o = { id: uid('o'), type: 'embed', kind, title, state, snapshot, imgW, imgH, table: table || [], showTable: true, link, layer, x, y, w, h: 0, version: 1 };
  o.h = embedHeight(o);
  return o;
}

export async function findEmbed(docId, page, objId) {
  const ann = await getAnnotations(docId);
  const obj = ((ann.pages || {})[page] || []).find((o) => o.id === objId && o.type === 'embed');
  return { ann, obj };
}

/** Open an embed for editing: the draft if there is one, otherwise the applied state. */
export async function loadEmbed(docId, page, objId) {
  const meta = await getDoc(docId);
  const { obj } = await findEmbed(docId, page, objId);
  if (!meta || !obj) return null;
  let applied = obj.state;
  if (obj.link) {
    // a linked embed follows its original
    const row = await db.get(obj.link.store, obj.link.id);
    if (row) applied = obj.link.store === 'circuits' || row.kind === 'scene' ? row : row.state;
  }
  const draft = await db.get('kv', draftKey(docId, objId));
  return { meta, obj, applied, state: draft ? draft.state : JSON.parse(JSON.stringify(applied)), hasDraft: !!draft, ref: { docId, page, objId } };
}

export function saveDraft(ref, state) {
  return db.put('kv', { state: JSON.parse(JSON.stringify(state)), updated: Date.now() }, draftKey(ref.docId, ref.objId));
}
export function discardDraft(ref) {
  return db.del('kv', draftKey(ref.docId, ref.objId));
}
/** Ids of embeds in a document that have unapplied changes. */
export async function draftIds(docId) {
  const prefix = `embed-draft:${docId}:`;
  return new Set((await db.keys('kv')).filter((k) => String(k).startsWith(prefix)).map((k) => String(k).slice(prefix.length)));
}

async function writeLink(link, state) {
  if (!link) return;
  const row0 = link.store === 'circuits' ? null : await db.get(link.store, link.id);
  if (link.store === 'circuits' || (state.kind === 'scene' && (!row0 || row0.kind === 'scene'))) await db.put(link.store, { ...JSON.parse(JSON.stringify(state)), id: link.id, updated: Date.now() });
  else { const row = (await db.get(link.store, link.id)) || { id: link.id, kind: 'plc-shared' }; await db.put(link.store, { ...row, state: JSON.parse(JSON.stringify(state)), updated: Date.now() }); }
}

/** Bring every other embed that is linked to the same original up to date. */
async function refreshLinked(link, fresh, skip) {
  if (!link) return 0;
  let n = 0;
  for (const docId of await db.keys('annotations')) {
    const ann = await db.get('annotations', docId);
    let touched = false;
    for (const [pg, objs] of Object.entries(ann.pages || {})) {
      for (const o of objs) {
        if (o.type !== 'embed' || !o.link || o.link.store !== link.store || o.link.id !== link.id) continue;
        if (docId === skip.docId && String(pg) === String(skip.page) && o.id === skip.objId) continue;
        Object.assign(o, { state: JSON.parse(JSON.stringify(fresh.state)), snapshot: fresh.snapshot, imgW: fresh.imgW, imgH: fresh.imgH, table: fresh.table, version: (o.version || 1) + 1 });
        o.h = embedHeight(o);
        touched = true;
        n++;
      }
    }
    if (touched) await db.put('annotations', ann, docId);
  }
  return n;
}

/**
 * Put the edited simulation into the document.
 * mode 'apply'       → update the embedded object (snapshot, state, table)
 *      'new-version' → keep the object and add the edited one next to it
 * The change is recorded in the document's undo history.
 */
export async function applyEmbed(ref, fresh, mode = 'apply') {
  const { ann, obj } = await findEmbed(ref.docId, ref.page, ref.objId);
  if (!obj) throw new Error('The embedded object no longer exists in the document.');
  const list = ann.pages[ref.page];
  const before = JSON.stringify(list);
  let target = obj;
  if (mode === 'new-version') {
    const base = (obj.title || '').replace(/ \(v\d+\)$/, '');
    target = { ...JSON.parse(JSON.stringify(obj)), id: uid('o'), link: null, x: obj.x + 14, y: obj.y + 14, title: `${base} (v${(obj.version || 1) + 1})` };
    list.push(target);
  }
  Object.assign(target, { state: JSON.parse(JSON.stringify(fresh.state)), snapshot: fresh.snapshot, imgW: fresh.imgW, imgH: fresh.imgH, table: fresh.table, version: (obj.version || 1) + 1 });
  target.h = embedHeight(target);
  const after = JSON.stringify(list);
  await saveAnnotations(ref.docId, ann);
  const meta = await getDoc(ref.docId);
  if (meta) await updateDoc(meta);
  pushUndo(ref.docId, { i: +ref.page, before, after });
  let others = 0;
  if (mode === 'apply' && target.link) {
    await writeLink(target.link, fresh.state);
    others = await refreshLinked(target.link, fresh, ref);
  }
  await discardDraft(ref);
  return { id: target.id, others };
}

/** After undo/redo in the document: linked originals follow the restored state. */
export async function syncLinksAfterHistory(docId, page, objs) {
  for (const o of objs) {
    if (o.type !== 'embed' || !o.link) continue;
    await writeLink(o.link, o.state);
    await refreshLinked(o.link, o, { docId, page, objId: o.id });
  }
}
