// Export / import of ALL user data as one ZIP file, so data can move between
// the browser version, the portable version and the installed version.
//
// Layout of the archive:
//   manifest.json      {app, format, created, appVersion, counts}
//   docs.json          document metadata (links, analysis, extracted text)
//   annotations.json   {docId: {layers, pages}}
//   thumbs.json        {docId: dataURL}
//   programs.json      saved PLC programs + working copies
//   settings.json      {theme}
//   circuits.json      user circuits and edited template copies
//   catalog.json       user-defined parts and kit elements
//   scenes.json        user-built PLC scenes
//   kv.json            [[key, value], …] small app values (favourites …)
//   files/<docId>.pdf  original, unmodified PDFs
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db } from './db.js';

export const BACKUP_APP = 'outofshape-lab';
export const BACKUP_FORMAT = 2; // 2: adds circuits, catalog, scenes, kv
// keyed stores that are saved whole: one JSON file each
const RECORD_STORES = ['circuits', 'catalog', 'scenes'];

const json = (v) => strToU8(JSON.stringify(v));

export async function exportAll(appVersion = '') {
  const docs = await db.all('docs');
  const programs = await db.all('programs');
  const annotations = {};
  const thumbs = {};
  const zip = {};
  for (const d of docs) {
    annotations[d.id] = (await db.get('annotations', d.id)) || { pages: {} };
    thumbs[d.id] = (await db.get('thumbs', d.id)) || null;
    const bytes = await db.get('files', d.id);
    // PDFs are already compressed: store them without spending time on deflate
    if (bytes) zip[`files/${d.id}.pdf`] = [new Uint8Array(bytes), { level: 0 }];
  }
  let theme = null;
  try { theme = localStorage.getItem('oos-theme'); } catch { /* ignore */ }
  const manifest = {
    app: BACKUP_APP,
    format: BACKUP_FORMAT,
    created: new Date().toISOString(),
    appVersion,
    counts: { docs: docs.length, programs: programs.filter((p) => !p.autosave).length, files: Object.keys(zip).length },
  };
  zip['docs.json'] = json(docs);
  zip['annotations.json'] = json(annotations);
  zip['thumbs.json'] = json(thumbs);
  zip['programs.json'] = json(programs);
  zip['settings.json'] = json({ theme });
  const extra = {};
  for (const store of RECORD_STORES) { const rows = await db.all(store); extra[store] = rows.length; zip[`${store}.json`] = json(rows); }
  const kv = [];
  for (const k of await db.keys('kv')) kv.push([k, await db.get('kv', k)]);
  zip['kv.json'] = json(kv);
  Object.assign(manifest.counts, extra);
  zip['manifest.json'] = json(manifest);
  return { bytes: zipSync(zip, { level: 6 }), manifest };
}

/** Read and validate a backup without changing anything. */
export function readBackup(bytes) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error('This is not a ZIP file (or it is damaged).');
  }
  const read = (name, fallback) => (entries[name] ? JSON.parse(strFromU8(entries[name])) : fallback);
  const manifest = read('manifest.json', null);
  if (!manifest || manifest.app !== BACKUP_APP) throw new Error('This ZIP is not an OutOfShape Lab backup (manifest.json missing).');
  if (manifest.format > BACKUP_FORMAT) throw new Error(`Backup format ${manifest.format} is newer than this app understands. Update the app first.`);
  return {
    manifest,
    docs: read('docs.json', []),
    annotations: read('annotations.json', {}),
    thumbs: read('thumbs.json', {}),
    programs: read('programs.json', []),
    settings: read('settings.json', {}),
    records: Object.fromEntries(RECORD_STORES.map((st) => [st, read(`${st}.json`, [])])),
    kv: read('kv.json', []),
    file: (id) => entries[`files/${id}.pdf`] || null,
  };
}

/**
 * @param {Uint8Array} bytes
 * @param {'merge'|'replace'} mode  merge: add everything, items with the same id are overwritten
 *                                  replace: wipe local data first
 */
export async function importAll(bytes, mode = 'merge') {
  const b = readBackup(bytes);
  if (mode === 'replace') {
    for (const s of ['docs', 'files', 'annotations', 'thumbs', 'programs', 'kv', ...RECORD_STORES]) await db.clear(s);
  }
  let docs = 0;
  let skipped = 0;
  for (const d of b.docs) {
    const file = b.file(d.id);
    if (!file) { skipped++; continue; } // metadata without its PDF is useless
    await db.put('files', file.slice(), d.id); // copy: don't keep the whole archive buffer alive
    await db.put('annotations', b.annotations[d.id] || { pages: {} }, d.id);
    await db.put('thumbs', b.thumbs[d.id] || null, d.id);
    await db.put('docs', d);
    docs++;
  }
  for (const p of b.programs) await db.put('programs', p);
  let records = 0;
  for (const store of RECORD_STORES) for (const row of b.records[store]) { await db.put(store, row); records++; }
  for (const [k, v] of b.kv) await db.put('kv', v, k);
  return { docs, skipped, records, programs: b.programs.filter((p) => !p.autosave).length, manifest: b.manifest };
}
