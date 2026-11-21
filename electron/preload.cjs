// Preload: the only bridge between the web app and the desktop shell.
// Runs sandboxed with context isolation; exposes a small, explicit API.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  takePendingFiles: () => ipcRenderer.invoke('files:pending'),
  openFiles: (opts) => ipcRenderer.invoke('dialog:open', opts),
  saveFile: (name, bytes, filters) => ipcRenderer.invoke('dialog:save', { name, bytes, filters }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onOpenFiles: on('open-files'),
  onMenu: on('menu'),
  onUpdateAvailable: on('update-available'),
});
