// IEC 61131-3 Structured Text lexer.
// Produces tokens {t: type, v: value, line, col}. Identifiers and keywords are
// case-insensitive (as in the standard); keywords are normalised to upper case.

export const KEYWORDS = new Set([
  'PROGRAM', 'END_PROGRAM', 'VAR', 'VAR_INPUT', 'VAR_OUTPUT', 'VAR_IN_OUT', 'VAR_GLOBAL', 'VAR_TEMP',
  'CONSTANT', 'RETAIN', 'END_VAR', 'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE',
  'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT',
  'RETURN', 'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE', 'AT',
]);

export class StSyntaxError extends Error {
  constructor(msg, line, col) {
    super(msg);
    this.line = line;
    this.col = col;
  }
}

/** Parse an IEC time literal body such as "1h2m3s500ms" or "1.5s" into milliseconds. */
export function parseTimeLiteral(body, line, col) {
  const s = body.toLowerCase().replace(/_/g, '');
  const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
  let m;
  let total = 0;
  let consumed = 0;
  const mult = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
  while ((m = re.exec(s))) {
    total += parseFloat(m[1]) * mult[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.length || consumed === 0) {
    // allow a plain number meaning ms
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    throw new StSyntaxError(`Invalid time literal "T#${body}"`, line, col);
  }
  return total;
}

export function formatTime(ms) {
  if (ms == null || isNaN(ms)) return 'T#0s';
  ms = Math.round(ms);
  if (ms === 0) return 'T#0s';
  let out = 'T#';
  const neg = ms < 0;
  if (neg) { out += '-'; ms = -ms; }
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  if (h) out += h + 'h';
  if (m) out += m + 'm';
  if (s) out += s + 's';
  if (ms) out += ms + 'ms';
  return out;
}

export function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;
  const adv = (k = 1) => {
    for (let j = 0; j < k; j++) {
      if (src[i] === '\n') { line++; col = 1; } else col++;
      i++;
    }
  };
  const push = (t, v, l, c) => toks.push({ t, v, line: l, col: c });

  while (i < n) {
    const ch = src[i];
    const l = line;
    const c = col;
    // whitespace
    if (/\s/.test(ch)) { adv(); continue; }
    // comments
    if (ch === '(' && src[i + 1] === '*') {
      adv(2);
      while (i < n && !(src[i] === '*' && src[i + 1] === ')')) adv();
      if (i >= n) throw new StSyntaxError('Unterminated comment', l, c);
      adv(2);
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') adv();
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      adv(2);
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv();
      if (i >= n) throw new StSyntaxError('Unterminated comment', l, c);
      adv(2);
      continue;
    }
    // identifiers / keywords / typed literals
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const up = word.toUpperCase();
      // time literals: T#..., TIME#..., LT#...
      if (src[j] === '#' && (up === 'T' || up === 'TIME' || up === 'LT' || up === 'LTIME')) {
        let k = j + 1;
        let neg = false;
        if (src[k] === '-') { neg = true; k++; }
        while (k < n && /[0-9A-Za-z_.]/.test(src[k])) k++;
        const body = src.slice(j + 1 + (neg ? 1 : 0), k);
        const v = parseTimeLiteral(body, l, c);
        adv(k - i);
        push('time', neg ? -v : v, l, c);
        continue;
      }
      // typed literal e.g. INT#5, BOOL#1  -> just skip the prefix
      if (src[j] === '#' && /^(BOOL|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL|BYTE|WORD|DWORD)$/.test(up)) {
        adv(j - i + 1);
        continue;
      }
      adv(j - i);
      if (KEYWORDS.has(up)) push('kw', up, l, c);
      else push('id', word, l, c);
      continue;
    }
    // numbers (incl. based 16#FF, 2#1010, floats, exponents, underscores)
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9_]/.test(src[j])) j++;
      if (src[j] === '#') {
        const base = parseInt(src.slice(i, j).replace(/_/g, ''), 10);
        let k = j + 1;
        while (k < n && /[0-9A-Fa-f_]/.test(src[k])) k++;
        const v = parseInt(src.slice(j + 1, k).replace(/_/g, ''), base);
        if (isNaN(v)) throw new StSyntaxError('Invalid based number', l, c);
        adv(k - i);
        push('num', v, l, c);
        continue;
      }
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) {
        isFloat = true;
        j++;
        while (j < n && /[0-9_]/.test(src[j])) j++;
      }
      if (/[eE]/.test(src[j] || '') && /[-+0-9]/.test(src[j + 1] || '')) {
        isFloat = true;
        j++;
        if (/[-+]/.test(src[j])) j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      const text = src.slice(i, j).replace(/_/g, '');
      adv(j - i);
      push('num', isFloat ? parseFloat(text) : parseInt(text, 10), l, c);
      if (isFloat) toks[toks.length - 1].real = true;
      continue;
    }
    // strings
    if (ch === "'" || ch === '"') {
      const q = ch;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== q) {
        if (src[j] === '$' && j + 1 < n) { s += src[j + 1]; j += 2; continue; }
        s += src[j];
        j++;
      }
      if (j >= n) throw new StSyntaxError('Unterminated string', l, c);
      adv(j - i + 1);
      push('str', s, l, c);
      continue;
    }
    // multi-char operators
    const two = src.slice(i, i + 2);
    if ([':=', '=>', '<=', '>=', '<>', '**', '..'].includes(two)) {
      adv(2);
      push('op', two, l, c);
      continue;
    }
    if ('+-*/()=<>;:,.[]&'.includes(ch)) {
      adv();
      push('op', ch === '&' ? 'AND' : ch, l, c);
      if (ch === '&') toks[toks.length - 1].t = 'kw';
      continue;
    }
    throw new StSyntaxError(`Unexpected character '${ch}'`, l, c);
  }
  push('eof', null, line, col);
  return toks;
}
