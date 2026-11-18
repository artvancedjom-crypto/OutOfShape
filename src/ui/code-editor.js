// Lightweight Structured Text editor: textarea over a syntax-highlighted <pre>,
// line-number gutter and error-line marking.
import { h } from '../core/dom.js';

const KW = /\b(PROGRAM|END_PROGRAM|VAR|VAR_INPUT|VAR_OUTPUT|VAR_IN_OUT|VAR_GLOBAL|VAR_TEMP|CONSTANT|RETAIN|END_VAR|IF|THEN|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|FOR|TO|BY|DO|END_FOR|WHILE|END_WHILE|REPEAT|UNTIL|END_REPEAT|EXIT|RETURN|AND|OR|XOR|NOT|MOD|AT)\b/gi;
const TYPES = /\b(BOOL|INT|DINT|SINT|LINT|UINT|UDINT|REAL|LREAL|TIME|STRING|BYTE|WORD|DWORD|TON|TOF|TP|CTU|CTD|CTUD|R_TRIG|F_TRIG|SR|RS)\b/gi;
const FUNCS = /\b(ABS|SQRT|MIN|MAX|LIMIT|SEL|TRUNC|ROUND|MOVE|EXP|LN|SIN|COS|[A-Z]+_TO_[A-Z]+)(?=\s*\()/gi;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightST(src, ioNames = []) {
  // tokenise comments/strings first so keywords inside them are not coloured
  const parts = [];
  const re = /(\(\*[\s\S]*?(\*\)|$)|\/\/[^\n]*|\/\*[\s\S]*?(\*\/|$)|'[^']*'?|"[^"]*"?)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) parts.push({ code: src.slice(last, m.index) });
    parts.push({ lit: m[0], cls: m[0][0] === "'" || m[0][0] === '"' ? 'str' : 'com' });
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push({ code: src.slice(last) });
  const ioRe = ioNames.length ? new RegExp(`\\b(${ioNames.join('|')})\\b`, 'g') : null;
  return parts.map((p) => {
    if (p.lit != null) return `<span class="t-${p.cls}">${esc(p.lit)}</span>`;
    let s = esc(p.code);
    // placeholders avoid re-highlighting inside generated spans
    const store = [];
    const put = (cls) => (x) => { store.push(`<span class="t-${cls}">${x}</span>`); return `\u0001${String.fromCharCode(0xe000 + store.length - 1)}\u0001`; };
    s = s.replace(/\b(T|TIME|LT)#-?[0-9a-z_.]+/gi, put('time'));
    s = s.replace(/\b(TRUE|FALSE)\b/gi, put('num'));
    s = s.replace(/\b\d+(\.\d+)?([eE][-+]?\d+)?\b|\b\d+#[0-9A-Fa-f_]+/g, put('num'));
    s = s.replace(KW, put('kw'));
    s = s.replace(TYPES, put('type'));
    s = s.replace(FUNCS, put('fn'));
    if (ioRe) s = s.replace(ioRe, put('io'));
    return s.replace(/\u0001([\ue000-\uf8ff])\u0001/g, (_, c) => store[c.charCodeAt(0) - 0xe000]);
  }).join('');
}

export function codeEditor({ value = '', ioNames = [], onChange, onSubmit } = {}) {
  const gutter = h('div', { class: 'gutter' });
  const pre = h('pre', { class: 'hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'code-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off' });
  ta.value = value;
  const wrap = h('div', { class: 'code-editor' }, gutter, h('div', { class: 'code-area' }, pre, ta));
  let errLines = new Set();

  function render() {
    const src = ta.value;
    pre.innerHTML = highlightST(src, ioNames) + '\n';
    const n = src.split('\n').length;
    let g = '';
    for (let i = 1; i <= n; i++) g += `<div class="${errLines.has(i) ? 'err' : ''}">${i}</div>`;
    gutter.innerHTML = g;
    syncScroll();
  }
  function syncScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  }
  ta.addEventListener('input', () => { render(); onChange && onChange(ta.value); });
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.setRangeText('  ', s, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit && onSubmit();
    } else if (e.key === 'Enter') {
      // keep indentation
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^\s*/.exec(ta.value.slice(lineStart, s))[0];
      e.preventDefault();
      ta.setRangeText('\n' + indent, s, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    e.stopPropagation();
  });
  ta.addEventListener('keyup', (e) => e.stopPropagation());
  render();
  return {
    el: wrap,
    get value() { return ta.value; },
    set value(v) { ta.value = v; render(); },
    setErrors(lines) { errLines = new Set(lines); render(); },
    goto(line) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
      ta.scrollTop = Math.max(0, (line - 4) * 19);
    },
  };
}
