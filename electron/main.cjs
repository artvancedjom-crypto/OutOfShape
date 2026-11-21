// Electron main process for OutOfShape Lab.
//
// Responsibilities:
//  - decide where user data lives (portable: next to the executable, installed: per-user profile)
//  - serve the static web build from a private app:// origin (no dev server, no file:// quirks)
//  - native integration: window state, menu, file dialogs, opening PDFs passed on the command line
//  - optional update check against GitHub Releases (off by default)
//
// The renderer is the unmodified web app; it only talks to this file through the
// narrow API exposed in preload.cjs.
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, screen, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const pkg = require('../package.json');

const APP_NAME = 'OutOfShape Lab';
const ORIGIN = 'app://local';
const DIST = path.join(__dirname, '..', 'dist');
const OPENABLE = /\.(pdf|png|jpe?g|webp|gif|txt|md|markdown)$/i;

// ---------------------------------------------------------------------------
// 1. Data location. Must be settled before the app is ready.
// ---------------------------------------------------------------------------
function findPortableRoot() {
  // Explicit override, used by tests and by people who want the data elsewhere.
  if (process.env.OOS_DATA_DIR) return { dataDir: path.resolve(process.env.OOS_DATA_DIR), reason: 'OOS_DATA_DIR' };
  // Single-file portable .exe (electron-builder "portable" target): the real exe
  // is unpacked to a temp folder, the launcher tells us where the user started it.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return { dataDir: path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data'), reason: 'portable-exe' };
  }
  // Portable folder / ZIP: a marker file sits next to the executable.
  const exeDir = path.dirname(process.execPath);
  if (app.isPackaged && fs.existsSync(path.join(exeDir, 'portable.flag'))) {
    return { dataDir: path.join(exeDir, 'data'), reason: 'portable-folder' };
  }
  return null;
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

app.setName(APP_NAME);
const portable = findPortableRoot();
let portableFallback = null; // set when the portable data folder is not writable
if (portable) {
  if (isWritable(portable.dataDir)) {
    app.setPath('userData', portable.dataDir);
    app.setAppLogsPath(path.join(portable.dataDir, 'logs'));
  } else {
    portableFallback = portable.dataDir;
  }
}
const isPortable = !!portable && !portableFallback;

// The app:// scheme behaves like https: ES modules, workers, fetch, IndexedDB
// and a stable origin, so stored data does not depend on the install path.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

// ---------------------------------------------------------------------------
// 2. Small JSON files in the data folder: settings + window state
// ---------------------------------------------------------------------------
const jsonPath = (name) => path.join(app.getPath('userData'), name);
function readJson(name, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(jsonPath(name), 'utf8')) };
  } catch {
    return { ...fallback };
  }
}
function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(jsonPath(name), JSON.stringify(value, null, 2));
  } catch (e) {
    console.error(`Could not write ${name}:`, e.message);
  }
}
const DEFAULT_SETTINGS = { checkUpdatesOnStart: false };
const getSettings = () => readJson('settings.json', DEFAULT_SETTINGS);

function loadWindowState() {
  const s = readJson('window-state.json', { width: 1440, height: 900, maximized: false });
  // Drop a remembered position that is no longer on any screen (e.g. another PC or monitor).
  if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 80 && s.x + s.width > a.x + 80 && s.y >= a.y - 10 && s.y < a.y + a.height - 80;
    });
    if (!visible) { delete s.x; delete s.y; }
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  s.width = Math.max(900, Math.min(s.width, area.width));
  s.height = Math.max(600, Math.min(s.height, area.height));
  return s;
}

// ---------------------------------------------------------------------------
// 3. Static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream', '.map': 'application/json',
};
// Everything is local: no remote scripts, styles, fonts or connections.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function registerAppProtocol() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' };
      if (file.endsWith('.html')) headers['content-security-policy'] = CSP;
      return new Response(body, { headers });
    } catch {
      return new Response(`Not found: ${rel}`, { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Files handed to the app (command line, "Open with", drop on the icon)
// ---------------------------------------------------------------------------
let win = null;
let rendererReady = false;
const pendingFiles = [];

function filesFromArgv(argv, cwd) {
  const out = [];
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-') || !OPENABLE.test(arg)) continue;
    const p = path.resolve(cwd || process.cwd(), arg);
    try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* not a file */ }
  }
  return out;
}

function readForRenderer(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      if (st.size > 300 * 1024 * 1024) throw new Error('file is larger than 300 MB');
      out.push({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) });
    } catch (e) {
      out.push({ name: path.basename(p), error: e.message });
    }
  }
  return out;
}

function deliverFiles(paths) {
  if (!paths.length) return;
  const files = readForRenderer(paths);
  if (win && rendererReady) win.webContents.send('open-files', files);
  else pendingFiles.push(...files);
}

// ---------------------------------------------------------------------------
// 5. Update check (manual, or at start when the user enabled it)
// ---------------------------------------------------------------------------
function repoSlug() {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
  const m = /github(?:\.com)?[:/]([^/]+\/[^/#.]+)/.exec(r || '');
  return m ? m[1] : null;
}
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
async function checkForUpdates() {
  const slug = repoSlug();
  const current = app.getVersion();
  if (!slug) return { ok: false, current, error: 'No GitHub repository configured in package.json' };
  try {
    const res = await net.fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'desktop-update-check' },
    });
    if (res.status === 404) return { ok: false, current, error: 'No public release found (private repository or nothing published yet)' };
    if (!res.ok) return { ok: false, current, error: `GitHub answered ${res.status}` };
    const rel = await res.json();
    return { ok: true, current, latest: rel.tag_name, available: newer(rel.tag_name, current), url: rel.html_url };
  } catch (e) {
    return { ok: false, current, error: `Offline or blocked: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// 6. Window + menu
// ---------------------------------------------------------------------------
function buildMenu() {
  const send = (action) => () => win && win.webContents.send('menu', action);
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open document…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Export all data (backup)…', click: send('export-data') },
        { label: 'Import data…', click: send('import-data') },
        { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' }, { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Check for updates…', click: send('check-updates') },
        { label: `About ${APP_NAME}`, click: send('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    x: state.x, y: state.y, width: state.width, height: state.height,
    minWidth: 900, minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#f4f6fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  let saveTimer = null;
  const save = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const maximized = win.isMaximized();
    const b = maximized ? readJson('window-state.json', win.getBounds()) : win.getBounds();
    writeJson('window-state.json', { x: b.x, y: b.y, width: b.width, height: b.height, maximized });
  };
  const later = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); };
  win.on('resize', later);
  win.on('move', later);
  win.on('close', () => { clearTimeout(saveTimer); save(); });
  win.on('closed', () => { win = null; rendererReady = false; });

  // Keep the document title set by the app shell.
  win.on('page-title-updated', (e) => e.preventDefault());
  // Never leave the app: links open in the default browser, dropped files don't navigate.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN) && !(process.env.OOS_DEV_URL && url.startsWith(process.env.OOS_DEV_URL))) e.preventDefault();
  });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (e.g. reload during load)
    dialog.showErrorBox(APP_NAME, `The app could not be loaded (${code} ${desc}).\n${url}\n\nIf you built it yourself, run "npm run build" first.`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    if (details.reason !== 'clean-exit') dialog.showErrorBox(APP_NAME, `The window crashed (${details.reason}). Your data is saved; please restart the app.`);
  });

  // OOS_DEV_URL=http://localhost:5173 loads the Vite dev server instead (hot reload).
  win.loadURL(process.env.OOS_DEV_URL || `${ORIGIN}/index.html`);
}

// ---------------------------------------------------------------------------
// 7. IPC surface (see preload.cjs)
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    portable: isPortable,
    dataPath: app.getPath('userData'),
    os: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    updateRepo: repoSlug(),
  }));
  ipcMain.handle('files:pending', () => {
    rendererReady = true;
    return pendingFiles.splice(0);
  });
  ipcMain.handle('dialog:open', async (e, opts = {}) => {
    const res = await dialog.showOpenDialog(win, {
      title: opts.title || 'Open document',
      properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])],
      filters: opts.filters || [
        { name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : readForRenderer(res.filePaths);
  });
  ipcMain.handle('dialog:save', async (e, { name, bytes, filters }) => {
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), String(name || 'export').replace(/[\\/:*?"<>|]/g, '_')),
      filters: filters || [{ name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.promises.writeFile(res.filePath, Buffer.from(bytes));
    return res.filePath;
  });
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (e, patch) => {
    const next = { ...getSettings() };
    if (patch && typeof patch.checkUpdatesOnStart === 'boolean') next.checkUpdatesOnStart = patch.checkUpdatesOnStart;
    writeJson('settings.json', next);
    return next;
  });
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('shell:openDataFolder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('shell:openExternal', (e, url) => (/^https:\/\//.test(url) ? shell.openExternal(url) : null));
}

// ---------------------------------------------------------------------------
// 8. Lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, cwd) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    deliverFiles(filesFromArgv(argv, cwd));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); deliverFiles([p]); }); // macOS

  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(DIST, 'index.html')) && !process.env.OOS_DEV_URL) {
      dialog.showErrorBox(APP_NAME, `The web build is missing (${DIST}).\nRun "npm run build" and start again.`);
      app.quit();
      return;
    }
    registerAppProtocol();
    registerIpc();
    buildMenu();
    pendingFiles.push(...readForRenderer(filesFromArgv(process.argv)));
    createWindow();
    if (portableFallback) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: APP_NAME,
        message: 'The portable data folder is not writable',
        detail: `${portableFallback}\n\nYour data is stored in your Windows user profile for this session instead:\n${app.getPath('userData')}\n\nMove the app to a writable folder (not a read-only drive or a protected folder such as Program Files) to keep the data next to it.`,
      });
    }
    if (getSettings().checkUpdatesOnStart) {
      const r = await checkForUpdates();
      if (r.ok && r.available && win) win.webContents.send('update-available', r);
    }
  });

  app.on('window-all-closed', () => app.quit());
}
