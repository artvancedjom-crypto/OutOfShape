// SVG schematic renderer with live readouts, glowing loads and animated
// current flow along wires (dash offset proportional to branch current).
import { fmt } from '../core/dom.js';

const U = 24; // px per grid unit
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

const P = (p) => [p[0] * U, p[1] * U];

function valueText(c) {
  switch (c.type) {
    case 'R': return fmt(c.R, 'Ω');
    case 'V': return fmt(c.V, 'V');
    case 'C': return fmt(c.C, 'F');
    case 'LED': return `LED (${c.model})`;
    case 'LAMP': return `${c.Prated} W lamp`;
    case 'NPN': return `β=${c.beta}`;
    case 'RELAY': return `${c.Vrated} V, ${fmt(c.Rcoil, 'Ω')}`;
    default: return '';
  }
}

/** Two-terminal group: local frame from (0,0) to (L,0). */
function twoTerm(svg, a, b) {
  const [x1, y1] = P(a);
  const [x2, y2] = P(b);
  const L = Math.hypot(x2 - x1, y2 - y1);
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const g = el('g', { transform: `translate(${x1},${y1}) rotate(${ang})` }, svg);
  return { g, L, ang, mid: [(x1 + x2) / 2, (y1 + y2) / 2], vertical: Math.abs(Math.abs(ang) - 90) < 1 };
}

function lead(g, x1, x2) {
  el('line', { x1, y1: 0, x2, y2: 0, class: 'w' }, g);
}

const SYMBOLS = {
  R(g, L) {
    const bw = Math.min(L - 8, 2.2 * U);
    const s = (L - bw) / 2;
    lead(g, 0, s);
    lead(g, s + bw, L);
    let d = `M${s},0`;
    const n = 6;
    for (let i = 0; i < n; i++) d += ` L${s + (bw * (i + 0.5)) / n},${i % 2 ? 7 : -7}`;
    d += ` L${s + bw},0`;
    el('path', { d, class: 'sym' }, g);
  },
  V(g, L) {
    const c = L / 2;
    lead(g, 0, c - 5);
    lead(g, c + 5, L);
    el('line', { x1: c - 5, y1: -16, x2: c - 5, y2: 16, class: 'sym thick' }, g);
    el('line', { x1: c + 5, y1: -9, x2: c + 5, y2: 9, class: 'sym thick' }, g);
    const t = el('text', { x: c - 16, y: -14, class: 'plus' }, g);
    t.textContent = '+';
  },
  C(g, L) {
    const c = L / 2;
    lead(g, 0, c - 4);
    lead(g, c + 4, L);
    el('line', { x1: c - 4, y1: -14, x2: c - 4, y2: 14, class: 'sym thick' }, g);
    el('line', { x1: c + 4, y1: -14, x2: c + 4, y2: 14, class: 'sym thick' }, g);
  },
  D(g, L, c, refs) {
    const m = L / 2;
    lead(g, 0, m - 10);
    lead(g, m + 10, L);
    el('path', { d: `M${m - 10},-11 L${m - 10},11 L${m + 10},0 Z`, class: 'sym fillsym' }, g);
    el('line', { x1: m + 10, y1: -11, x2: m + 10, y2: 11, class: 'sym thick' }, g);
    if (c.type === 'LED') {
      refs.glow = el('circle', { cx: m, cy: 0, r: 22, class: 'glow', fill: ledColor(c.model) }, g);
      g.insertBefore(refs.glow, g.firstChild);
      for (const o of [-4, 6]) {
        el('path', { d: `M${m + o},-14 l8,-10 m-5,0 l5,0 l0,5`, class: 'sym thin' }, g);
      }
    }
  },
  SW(g, L, c, refs) {
    const a = L * 0.28;
    const b = L * 0.72;
    lead(g, 0, a);
    lead(g, b, L);
    el('circle', { cx: a, cy: 0, r: 3, class: 'term' }, g);
    el('circle', { cx: b, cy: 0, r: 3, class: 'term' }, g);
    refs.blade = el('line', { x1: a, y1: 0, x2: b, y2: 0, class: 'sym thick blade' }, g);
    refs.bladeLen = b - a;
    refs.bladeA = a;
    if (c.momentary) {
      refs.cap = el('path', { d: `M${(a + b) / 2},-6 L${(a + b) / 2},-18 M${(a + b) / 2 - 8},-18 L${(a + b) / 2 + 8},-18`, class: 'sym thin' }, g);
    }
    el('rect', { x: -4, y: -26, width: L + 8, height: 44, class: 'hit' }, g);
  },
  LAMP(g, L, c, refs) {
    const m = L / 2;
    lead(g, 0, m - 13);
    lead(g, m + 13, L);
    refs.glow = el('circle', { cx: m, cy: 0, r: 26, class: 'glow', fill: c.color || '#ffd23f' }, g);
    el('circle', { cx: m, cy: 0, r: 13, class: 'sym bg' }, g);
    el('path', { d: `M${m - 9},-9 L${m + 9},9 M${m - 9},9 L${m + 9},-9`, class: 'sym thin' }, g);
  },
  COIL(g, L) {
    const m = L / 2;
    lead(g, 0, m - 18);
    lead(g, m + 18, L);
    el('rect', { x: m - 18, y: -11, width: 36, height: 22, class: 'sym bg' }, g);
  },
};
SYMBOLS.LED = SYMBOLS.D;

function ledColor(m) {
  return { red: '#ff3b30', green: '#34c759', blue: '#3a7bff', white: '#ffffff', yellow: '#ffd60a' }[m] || '#ff3b30';
}

export function renderSchematic(container, def, circuit, { onSwitch } = {}) {
  container.innerHTML = '';
  const maxX = Math.max(...def.wires.flatMap((w) => w.pts.map((p) => p[0])), 28) + 7;
  const maxY = Math.max(...def.wires.flatMap((w) => w.pts.map((p) => p[1])), 16) + 2;
  const svg = el('svg', { viewBox: `0 0 ${maxX * U} ${maxY * U}`, class: 'schematic' });
  container.append(svg);
  const wireLayer = el('g', {}, svg);
  const flowLayer = el('g', {}, svg);
  const compLayer = el('g', {}, svg);
  const labelLayer = el('g', {}, svg);
  const flows = [];
  for (const w of def.wires) {
    const d = 'M' + w.pts.map((p) => P(p).join(',')).join(' L');
    el('path', { d, class: 'w' }, wireLayer);
    if (w.cur) flows.push({ w, path: el('path', { d, class: 'flow' }, flowLayer), off: 0 });
  }
  for (const d of def.dots || []) {
    const [x, y] = P(d);
    el('circle', { cx: x, cy: y, r: 4, class: 'dot' }, wireLayer);
  }
  const refs = {};
  for (const c of def.components) {
    const r = (refs[c.id] = { c });
    if (c.type === 'NPN') {
      const [x, y] = P(c.sch.at);
      const g = el('g', { transform: `translate(${x},${y})` }, compLayer);
      el('circle', { cx: 0, cy: 0, r: 1.6 * U, class: 'sym bg' }, g);
      el('line', { x1: -2.5 * U, y1: 0, x2: -0.55 * U, y2: 0, class: 'w' }, g);
      el('line', { x1: -0.55 * U, y1: -0.8 * U, x2: -0.55 * U, y2: 0.8 * U, class: 'sym thick' }, g);
      el('path', { d: `M${-0.55 * U},${-0.35 * U} L${U},${-1.3 * U} L${U},${-3 * U}`, class: 'w' }, g);
      el('path', { d: `M${-0.55 * U},${0.35 * U} L${U},${1.3 * U} L${U},${3 * U}`, class: 'w' }, g);
      el('path', { d: `M${0.55 * U},${1.25 * U} L${U},${1.3 * U} L${0.8 * U},${0.85 * U}`, class: 'sym fillsym' }, g);
      r.mid = [x + 2.4 * U, y];
      r.vertical = true;
      addLabels(r, c, x + 1.9 * U, y - 6);
      continue;
    }
    if (c.type === 'RELAY') {
      const t = twoTerm(compLayer, c.sch.coil.a, c.sch.coil.b);
      SYMBOLS.COIL(t.g, t.L);
      r.coil = t;
      r.coilRect = t.g.querySelector('rect');
      r.poles = c.sch.poles.map((p, k) => {
        const pt = twoTerm(compLayer, p.a, p.b);
        const pr = {};
        SYMBOLS.SW(pt.g, pt.L, { momentary: false }, pr);
        pt.g.querySelector('.hit').remove();
        const tx = el('text', { x: pt.L / 2, y: -26, class: 'tiny', 'text-anchor': 'start', transform: `rotate(${-pt.ang} ${pt.L / 2} -26)` }, pt.g);
        tx.textContent = `${c.id}.${k + 1} ${c.poles[k]}`;
        return { ...pr, kind: c.poles[k], t: pt };
      });
      // dashed mechanical link
      const [cx, cy] = t.mid;
      for (const p of r.poles) {
        el('line', { x1: cx + 18, y1: cy, x2: p.t.mid[0], y2: p.t.mid[1], class: 'link' }, labelLayer);
      }
      addLabels(r, c, cx - 36, cy - 2, 'end');
      continue;
    }
    const t = twoTerm(compLayer, c.sch.a, c.sch.b);
    const sym = SYMBOLS[c.type];
    if (sym) sym(t.g, t.L, c, r);
    r.t = t;
    const [mx, my] = t.mid;
    if (t.vertical) addLabels(r, c, mx + 22, my - 4);
    else addLabels(r, c, mx, my - 44, 'middle');
    if (c.type === 'SW') {
      t.g.classList.add('switch');
      const set = (v) => onSwitch && onSwitch(c, v);
      if (c.momentary) {
        t.g.addEventListener('pointerdown', (e) => { e.preventDefault(); set(!c.normally); const up = () => { set(!!c.normally); window.removeEventListener('pointerup', up); }; window.addEventListener('pointerup', up); });
      } else {
        t.g.addEventListener('click', () => set(c.radio ? true : !c.closed));
      }
    }
  }

  function addLabels(r, c, x, y, anchor = 'start') {
    const name = el('text', { x, y, class: 'cname', 'text-anchor': anchor }, labelLayer);
    name.textContent = c.label || c.id;
    r.val = el('text', { x, y: y + 15, class: 'cval', 'text-anchor': anchor }, labelLayer);
    r.live = el('text', { x, y: y + 30, class: 'clive', 'text-anchor': anchor }, labelLayer);
  }

  const probes = (def.probes || []).map((p) => {
    const [x, y] = P(p.at);
    const g = el('g', { transform: `translate(${x},${y})` }, labelLayer);
    const dy = p.below ? 30 : 0; // place the tag under the node when space above is taken
    const rect = el('rect', { x: 6, y: -24 + dy, width: 74, height: 18, rx: 9, class: 'probe' }, g);
    const t = el('text', { x: 43, y: -11 + dy, class: 'probet', 'text-anchor': 'middle' }, g);
    el('circle', { cx: 0, cy: 0, r: 3.5, class: 'probedot' }, g);
    return { p, t, rect };
  });

  function update(res, dtReal = 0.016) {
    if (!res || res.error) return;
    for (const r of Object.values(refs)) {
      const c = r.c;
      const cr = res.comp[c.id];
      if (r.val) r.val.textContent = valueText(c);
      if (!cr) continue;
      if (r.live) {
        if (c.type === 'NPN') r.live.textContent = `${cr.region} · Ic ${fmt(cr.i, 'A')}`;
        else if (c.type === 'SW') r.live.textContent = c.closed ? 'closed' : 'open';
        else if (c.type === 'RELAY') r.live.textContent = `${cr.on ? 'ON' : 'off'} · ${fmt(Math.abs(cr.i), 'A')}`;
        else r.live.textContent = `${fmt(Math.abs(cr.v), 'V')} · ${fmt(Math.abs(cr.i), 'A')}`;
        r.live.classList.toggle('warn', !!cr.overcurrent);
      }
      if (r.glow) {
        const b = Math.max(0, Math.min(1, cr.brightness || 0));
        r.glow.setAttribute('opacity', (b * 0.85).toFixed(3));
        r.glow.setAttribute('r', String(14 + b * 16));
        if (c.type === 'LED') r.glow.setAttribute('fill', cr.overcurrent ? '#ff00ff' : ledColor(c.model));
      }
      if (c.type === 'SW' && r.blade) {
        const open = !c.closed;
        const ang = open ? -28 : 0;
        r.blade.setAttribute('transform', `rotate(${ang} ${r.bladeA} 0)`);
      }
      if (c.type === 'RELAY') {
        r.coilRect.classList.toggle('on', !!cr.on);
        for (const p of r.poles) {
          const closed = p.kind === 'NC' ? !cr.on : cr.on;
          p.blade.setAttribute('transform', `rotate(${closed ? 0 : -28} ${p.bladeA} 0)`);
        }
      }
    }
    for (const f of flows) {
      const cr = res.comp[f.w.cur];
      if (!cr) continue;
      let i = f.w.ie ? cr.i + (cr.ib || 0) : cr.i;
      i *= f.w.sign || 1;
      const speed = Math.sign(i) * Math.min(160, Math.log10(1 + Math.abs(i) * 1e4) * 40);
      f.off -= speed * dtReal;
      f.path.style.strokeDashoffset = f.off.toFixed(1);
      f.path.style.opacity = Math.abs(i) > 1e-6 ? '1' : '0';
    }
    for (const pr of probes) {
      const v = res.nodeV[pr.p.node] ?? 0;
      pr.t.textContent = fmt(v, 'V');
    }
  }
  return { update, svg };
}
