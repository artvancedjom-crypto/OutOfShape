// Tiny DOM helpers – the UI is written in plain JS modules without a framework.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function toast(msg, kind = 'info', ms = 2600) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(null); } },
      h('div', { class: 'modal' },
        h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', onclick: () => close(null), title: 'Close' }, '✕')),
        h('div', { class: 'modal-body' }, body),
        actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: () => close(a.value) }, a.label))) : null,
      ));
    document.body.append(back);
  });
}

export async function prompt(title, value = '') {
  const input = h('input', { class: 'input', value, style: { width: '100%' } });
  setTimeout(() => input.focus(), 0);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.closest('.modal').querySelector('.btn.primary').click(); });
  const r = await modal(title, input, [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }]);
  return r ? input.value : null;
}

export function fmt(v, unit = '', digits = 3) {
  if (v == null || isNaN(v)) return '—';
  const a = Math.abs(v);
  const pre = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
  if (a === 0) return `0 ${unit}`;
  for (const [m, p] of pre) {
    if (a >= m * 0.9999) return `${+(v / m).toPrecision(digits)} ${p}${unit}`;
  }
  return `${v.toExponential(2)} ${unit}`;
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
