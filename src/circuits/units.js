// Engineering notation: parse "4k7", "100n", "2.2u", "1M", "10 mA", "0.5", "1e-3"
// and format numbers with SI prefixes.
const MULT = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, R: 1 };

/**
 * @param {string|number} input
 * @returns {number} NaN when the text is not a number
 */
export function parseSI(input) {
  if (typeof input === 'number') return input;
  let s = String(input).trim().replace(',', '.');
  if (!s) return NaN;
  // drop a trailing unit (Ω, ohm, V, A, F, H, Hz, W, s, %) but keep prefixes
  s = s.replace(/\s+/g, '').replace(/(Ω|ohms?|Ohm|Hz|[VAFHWs%])$/u, '');
  // "4k7" / "2R2" / "1M5": prefix used as decimal point
  let m = /^([+-]?\d+)([fpnuµμmkKMGTR])(\d+)$/u.exec(s);
  if (m) return parseFloat(`${m[1]}.${m[3]}`) * MULT[m[2]];
  m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([fpnuµμmkKMGT]?)$/u.exec(s);
  if (m) return parseFloat(m[1]) * (m[2] ? MULT[m[2]] : 1);
  return NaN;
}

const PREFIXES = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];

export function formatSI(v, unit = '', digits = 3) {
  if (v == null || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return (v < 0 ? '−' : '') + '∞ ' + unit;
  const a = Math.abs(v);
  if (a === 0) return `0 ${unit}`.trim();
  if (a < 1e-15) return `${v.toExponential(2)} ${unit}`.trim();
  for (const [m, p] of PREFIXES) {
    if (a >= m * 0.99995) return `${+(v / m).toPrecision(digits)} ${p}${unit}`.trim();
  }
  return `${v.toExponential(2)} ${unit}`.trim();
}

/** Compact text for value fields, round-trips through parseSI: 4700 → "4.7k" */
export function editSI(v) {
  if (v == null || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a < 1e-15) return v.toExponential(4);
  for (const [m, p] of PREFIXES) {
    if (a >= m * 0.99995) return `${+(v / m).toPrecision(6)}${p === 'µ' ? 'u' : p}`;
  }
  return String(v);
}
