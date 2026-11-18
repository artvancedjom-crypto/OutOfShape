// Minimal promise-based IndexedDB wrapper. All app data lives locally.
const DB_NAME = 'outofshape-lab';
const DB_VERSION = 1;
const STORES = {
  docs: 'id', // document metadata {id,name,created,updated,pageCount,kind,links,analysis}
  files: null, // docId -> ArrayBuffer (original PDF bytes, never modified)
  annotations: null, // docId -> {pages: {index: [objects]}}
  programs: 'id', // saved PLC programs {id,scenarioId,name,lang,source,updated}
  thumbs: null, // docId -> dataURL of first page
};

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, keyPath ? { keyPath } : undefined);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        const r = fn(s);
        if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
};

export function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
