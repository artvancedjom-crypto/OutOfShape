// Hash router: #/library, #/doc/:id, #/lab, #/plc/:scenario, #/circuit/:id
const routes = [];
let current = null;

export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler });
}

export function navigate(path) {
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

export function currentQuery() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

async function render() {
  const raw = (location.hash || '#/library').slice(1);
  const path = raw.split('?')[0];
  if (current && current.destroy) {
    try { current.destroy(); } catch (e) { console.error(e); }
  }
  current = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      current = await r.handler(params, currentQuery());
      return;
    }
  }
  location.hash = '/library';
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  render();
}
