import { bus } from './bus.js';
const KEY = 'oos-theme';
export function getTheme() {
  try { return localStorage.getItem(KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch { return 'light'; }
}
export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  bus.emit('theme', t);
}
export function toggleTheme() {
  applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
