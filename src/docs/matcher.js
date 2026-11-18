// Transparent document → simulation matcher.
// Scores every PLC scenario and circuit by weighted keyword hits and extracts
// parameters with regular expressions. Everything the score is built from is
// returned so the UI can show *why* something matched.
import { SCENARIOS } from '../scenarios/index.js';
import { CIRCUITS } from '../circuits/library.js';

const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6 };
const DOMAIN = {
  plc: [['plc', 2], ['ladder', 1.5], ['structured text', 2], ['iec 61131', 3], ['programmable logic controller', 3], ['scan cycle', 1], ['input', 0.3], ['output', 0.3], ['timer', 0.6], ['ton', 0.6], ['sensor', 0.5]],
  circuit: [['circuit', 1], ['schematic', 1.5], ['voltage', 0.6], ['current', 0.4], ['ohm', 0.8], ['resistor', 0.8], ['breadboard', 1.5], ['multimeter', 1]],
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countTerm(text, term) {
  const t = term.toLowerCase();
  const re = /^[\w ]+$/.test(t) ? new RegExp(`\\b${escapeRe(t)}s?\\b`, 'g') : new RegExp(escapeRe(t), 'g');
  const m = text.match(re);
  return m ? m.length : 0;
}

function snippet(text, idx, len) {
  const a = Math.max(0, idx - 40);
  const b = Math.min(text.length, idx + len + 40);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

function targets() {
  return [
    ...SCENARIOS.map((s) => ({ kind: 'plc', id: s.id, name: s.name, icon: s.icon, match: s.match, params: s.params })),
    ...CIRCUITS.map((c) => ({ kind: 'circuit', id: c.id, name: c.name, icon: c.icon, match: c.match, params: c.params })),
  ];
}

export function extractParams(t, text) {
  const out = [];
  const seen = new Set();
  for (const rule of t.match.params || []) {
    if (seen.has(rule.key)) continue;
    const m = rule.re.exec(text);
    if (!m) continue;
    const pdef = t.params.find((p) => p.key === rule.key);
    if (!pdef) continue;
    let value;
    if (rule.text) {
      value = m[1].toLowerCase();
      if (pdef.options && !pdef.options.includes(value)) continue;
    } else {
      value = parseFloat(String(m[1]).replace(',', '.'));
      if (rule.unitPrefix) value *= PREFIX[m[2] || ''] ?? 1;
      if (rule.scale) value *= rule.scale;
      if (isNaN(value)) continue;
      const clamped = Math.max(pdef.min, Math.min(pdef.max, value));
      if (clamped !== value) value = clamped;
    }
    seen.add(rule.key);
    out.push({ key: rule.key, label: pdef.label, value, unit: pdef.unit || '', snippet: snippet(text, m.index, m[0].length), pattern: rule.re.source });
  }
  return out;
}

/**
 * @param {string} rawText
 * @returns {Array<{kind,id,name,icon,score,confidence,hits,params}>}
 */
export function matchText(rawText) {
  const text = (rawText || '').toLowerCase();
  const domain = {};
  for (const [k, list] of Object.entries(DOMAIN)) {
    domain[k] = list.reduce((s, [term, w]) => s + Math.min(3, countTerm(text, term)) * w, 0);
  }
  const res = targets().map((t) => {
    const hits = [];
    let score = 0;
    for (const [term, w] of t.match.keywords) {
      const n = countTerm(text, term);
      if (!n) continue;
      const contrib = w * (1 + Math.log2(n));
      hits.push({ term, count: n, weight: w, contrib });
      score += contrib;
    }
    const dom = Math.min(4, domain[t.kind] * 0.5);
    if (score > 0 && dom > 0) hits.push({ term: `${t.kind === 'plc' ? 'PLC' : 'electronics'} context`, count: 1, weight: dom, contrib: dom, domain: true });
    if (score > 0) score += dom;
    const confidence = 1 - Math.exp(-score / 10);
    hits.sort((a, b) => b.contrib - a.contrib);
    return { kind: t.kind, id: t.id, name: t.name, icon: t.icon, score, confidence, hits, params: score > 0 ? extractParams(t, rawText || '') : [] };
  });
  return res.sort((a, b) => b.score - a.score);
}

/** Analyse a whole document: overall ranking + best match per page. */
export function analyseDocument(pages) {
  const all = matchText(pages.join('\n\n'));
  const perPage = pages.map((p, i) => {
    const r = matchText(p).filter((x) => x.confidence >= 0.35);
    return { page: i, best: r[0] || null };
  });
  return { overall: all, perPage, analysedAt: Date.now() };
}

/** All physical quantities found in the text (for transparency). */
export function findQuantities(text) {
  const re = /(\d+(?:[.,]\d+)?)\s*([pnuµmkKM]?)(Ω|ohms?|V|A|F|Hz|W|s|ms|L\/s|L|%|°C)(?![a-z])/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) && out.length < 60) out.push(m[0]);
  return [...new Set(out)];
}
