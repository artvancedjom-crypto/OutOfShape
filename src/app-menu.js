// App-level actions shared by the ⚙ menu in the top bar and the native desktop menu:
// backup export/import, opening documents from outside, update check, About.
import { h, toast, modal } from './core/dom.js';
import { navigate } from './core/router.js';
import { platform } from './platform/index.js';
import { exportAll, importAll, readBackup } from './core/backup.js';
import { importFile, ACCEPT } from './docs/store.js';

const ZIP_FILTER = [{ name: 'OutOfShape Lab backup', extensions: ['zip'] }];

export async function exportData() {
  try {
    const info = await platform.info();
    const { bytes, manifest } = await exportAll(info.version);
    const stamp = new Date().toISOString().slice(0, 10);
    const ok = await platform.saveFile(`OutOfShape-Lab-backup-${stamp}.zip`, bytes, { mime: 'application/zip', filters: ZIP_FILTER });
    if (ok) toast(`Backup written: ${manifest.counts.docs} document(s), ${manifest.counts.programs} program(s), ${(bytes.length / 1048576).toFixed(1)} MB`, 'ok', 4500);
  } catch (e) {
    console.error(e);
    toast('Backup failed: ' + e.message, 'err', 6000);
  }
}

export async function importData() {
  const [file] = await platform.pickFiles({ accept: '.zip,application/zip', title: 'Import backup', filters: ZIP_FILTER });
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { manifest } = readBackup(bytes); // validate before asking
    const mode = await modal('Import data', h('div', {},
      h('p', {}, h('b', {}, file.name)),
      h('p', {}, `Created ${new Date(manifest.created).toLocaleString()} with version ${manifest.appVersion || '?'}: ${manifest.counts.docs} document(s), ${manifest.counts.programs} saved program(s).`),
      h('p', { class: 'small muted' }, 'Merge keeps what is already here and adds the backup; items that exist in both are replaced by the backup copy. Replace deletes everything in this app first.')), [
      { label: 'Cancel', value: null },
      { label: 'Replace everything', value: 'replace' },
      { label: 'Merge', value: 'merge', primary: true },
    ]);
    if (!mode) return;
    const r = await importAll(bytes, mode);
    toast(`Imported ${r.docs} document(s) and ${r.programs} program(s)${r.skipped ? `, skipped ${r.skipped} without a file` : ''}`, 'ok', 4500);
    navigate('/library');
  } catch (e) {
    console.error(e);
    toast('Import failed: ' + e.message, 'err', 7000);
  }
}

/** Import documents that arrive from outside a view (menu, command line, drop on the window). */
export async function openDocuments(files) {
  let last = null;
  for (const f of files) {
    try {
      last = await importFile(f);
      toast(`Imported “${last.name}”`, 'ok');
    } catch (e) {
      console.error(e);
      toast(`Could not open ${f.name}: ${e.message}`, 'err', 6000);
    }
  }
  if (last) navigate('/doc/' + last.id);
}

export async function openDocumentDialog() {
  const files = await platform.pickFiles({ accept: ACCEPT, multiple: true });
  if (files.length) await openDocuments(files);
}

export async function checkUpdates(silent = false) {
  const r = await platform.checkForUpdates();
  if (!r.ok) { if (!silent) toast(`Update check: ${r.error}`, 'err', 6000); return; }
  if (r.available) showUpdate(r);
  else if (!silent) toast(`You have the latest version (${r.current})`, 'ok');
}

export function showUpdate(r) {
  modal('Update available', h('p', {}, `Version ${r.latest} is available (you have ${r.current}). Download the new portable ZIP or installer from the release page. Your data is kept.`), [
    { label: 'Later', value: null }, { label: 'Open release page', value: 'open', primary: true },
  ]).then((v) => { if (v) platform.openExternal(r.url); });
}

export async function about() {
  const info = await platform.info();
  const settings = await platform.getSettings();
  let usage = '';
  try {
    const e = await navigator.storage.estimate();
    usage = `${(e.usage / 1048576).toFixed(1)} MB used`;
  } catch { /* not supported */ }
  const modeText = { web: 'Browser', portable: 'Desktop, portable (data travels with the app)', installed: 'Desktop, installed' }[info.mode];
  const upd = h('input', { type: 'checkbox', checked: !!settings.checkUpdatesOnStart });
  upd.addEventListener('change', () => platform.setSettings({ checkUpdatesOnStart: upd.checked }));
  const row = (k, v) => h('tr', {}, h('td', { class: 'muted', style: { paddingRight: '14px', verticalAlign: 'top', whiteSpace: 'nowrap' } }, k), h('td', { style: { wordBreak: 'break-all' } }, v));
  await modal(`About ${info.name}`, h('div', { class: 'about' },
    h('table', {}, h('tbody', {},
      row('Version', info.version),
      row('Running as', modeText),
      row('Data location', info.dataPath),
      usage ? row('Storage', usage) : null,
      info.electron ? row('Engine', `Electron ${info.electron} (Chromium ${info.chrome})`) : null)),
    platform.isDesktop ? h('div', { class: 'row gap', style: { marginTop: '14px' } },
      h('button', { class: 'btn small', onclick: () => platform.openDataFolder() }, '📂 Open data folder'),
      h('button', { class: 'btn small', onclick: () => checkUpdates() }, 'Check for updates now')) : null,
    platform.isDesktop ? h('label', { class: 'row gap small', style: { marginTop: '12px' } }, upd, `Check for updates when the app starts (contacts api.github.com${info.updateRepo ? '' : '; no repository configured'})`) : null,
    h('p', { class: 'small muted', style: { marginTop: '14px' } }, 'Everything is stored locally. Use “Export all data” to move documents, annotations and PLC programs between the browser, portable and installed versions.')),
  [{ label: 'Close', value: null, primary: true }]);
}

/** ⚙ button for the top bar. */
export function appMenuButton() {
  const btn = h('button', { class: 'icon-btn', title: 'Data, backup and about' }, '⚙️');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.app-menu').forEach((m) => m.remove());
    const menu = h('div', { class: 'menu app-menu' });
    const item = (label, fn) => menu.append(h('button', { onclick: () => { menu.remove(); fn(); } }, label));
    menu.append(h('div', { class: 'menu-h' }, 'Documents'));
    item('📄 Open document…', openDocumentDialog);
    menu.append(h('div', { class: 'menu-h' }, 'Backup'));
    item('⬇ Export all data (ZIP)…', exportData);
    item('⬆ Import data…', importData);
    menu.append(h('div', { class: 'menu-h' }, 'App'));
    if (platform.isDesktop) {
      item('📂 Open data folder', () => platform.openDataFolder());
      item('🔄 Check for updates…', () => checkUpdates());
    }
    item('ℹ About', about);
    const r = btn.getBoundingClientRect();
    Object.assign(menu.style, { top: r.bottom + 4 + 'px', left: Math.max(8, r.right - 260) + 'px' });
    document.body.append(menu);
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
  });
  return btn;
}

/** Wire native menu, externally opened files and window-level drops. Call once. */
export function initAppIntegration() {
  platform.onMenu((action) => ({ open: openDocumentDialog, 'export-data': exportData, 'import-data': importData, 'check-updates': () => checkUpdates(), about }[action] || (() => {}))());
  platform.onOpenFiles(openDocuments);
  platform.onUpdateAvailable(showUpdate);
  // Dropping a file anywhere imports it; views that handle drops themselves call preventDefault first.
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    openDocuments([...e.dataTransfer.files]);
  });
  // Ask the browser not to evict our data under storage pressure (no-op where unsupported).
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
