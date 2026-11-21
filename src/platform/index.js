// Platform abstraction: the one place where "browser" and "desktop shell" differ.
// Views call these functions and never touch Electron or <input type=file> directly.
//
//   web     → file inputs, download links, no native menu
//   desktop → native dialogs and menu through window.desktop (see electron/preload.cjs)
import { h, download } from '../core/dom.js';

/* global __APP_VERSION__ */
const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
const WEB_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const toFiles = (list) => list.filter((f) => !f.error).map((f) => new File([f.bytes], f.name, { type: guessType(f.name) }));

function guessType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', zip: 'application/zip',
  }[ext] || 'application/octet-stream';
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data));
}

export const platform = {
  isDesktop: !!desktop,

  /** {name, version, mode: 'web'|'portable'|'installed', dataPath, ...} */
  async info() {
    if (!desktop) return { name: 'OutOfShape Lab', version: WEB_VERSION, mode: 'web', dataPath: 'Browser storage (IndexedDB) for this site' };
    const i = await desktop.info();
    return { ...i, mode: i.portable ? 'portable' : 'installed' };
  },

  /**
   * Let the user choose files. Resolves with File objects ([] when cancelled).
   * @param {{accept?: string, multiple?: boolean, title?: string, filters?: Array<{name:string, extensions:string[]}>}} opts
   */
  async pickFiles(opts = {}) {
    if (desktop) {
      const list = await desktop.openFiles({ multiple: !!opts.multiple, title: opts.title, filters: opts.filters });
      return toFiles(list);
    }
    return new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: opts.accept || '', multiple: !!opts.multiple, style: { display: 'none' } });
      input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      document.body.append(input);
      input.click();
    });
  },

  /** Save bytes under a suggested name. Resolves true when written (desktop) or handed to the browser. */
  async saveFile(name, data, { mime, filters } = {}) {
    const bytes = await toBytes(data);
    if (desktop) return !!(await desktop.saveFile(name, bytes, filters));
    download(new Blob([bytes], { type: mime || guessType(name) }), name);
    return true;
  },

  /** Files handed to the app from outside (command line, "Open with", second launch). */
  onOpenFiles(cb) {
    if (!desktop) return () => {};
    desktop.takePendingFiles().then((list) => { if (list.length) cb(toFiles(list)); });
    return desktop.onOpenFiles((list) => cb(toFiles(list)));
  },

  /** Native menu commands: 'open' | 'export-data' | 'import-data' | 'check-updates' | 'about' */
  onMenu(cb) {
    return desktop ? desktop.onMenu(cb) : () => {};
  },

  onUpdateAvailable(cb) {
    return desktop ? desktop.onUpdateAvailable(cb) : () => {};
  },
  getSettings: () => (desktop ? desktop.getSettings() : Promise.resolve({})),
  setSettings: (patch) => (desktop ? desktop.setSettings(patch) : Promise.resolve({})),
  checkForUpdates: () => (desktop ? desktop.checkForUpdates() : Promise.resolve({ ok: false, error: 'Only available in the desktop app' })),
  openDataFolder: () => (desktop ? desktop.openDataFolder() : Promise.resolve()),
  openExternal(url) {
    if (desktop) return desktop.openExternal(url);
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  },
};
