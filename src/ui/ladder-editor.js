// Visual Ladder Diagram editor with live power-flow highlighting.
import { h, clear } from '../core/dom.js';
import { newRung, CONTACT_TYPES, OUTPUT_TYPES } from '../plc/ladder.js';

const CONTACT_SYM = { NO: '┤ ├', NC: '┤/├', P: '┤P├', N: '┤N├' };
const OUT_SYM = { COIL: '( )', NCOIL: '(/)', SET: '(S)', RESET: '(R)', TON: 'TON', TOF: 'TOF', TP: 'TP', CTU: 'CTU', CTD: 'CTD' };
const OUT_HELP = {
  COIL: 'Coil – output follows rung', NCOIL: 'Negated coil', SET: 'Set (latch) coil', RESET: 'Reset (unlatch) coil',
  TON: 'On-delay timer', TOF: 'Off-delay timer', TP: 'Pulse timer', CTU: 'Up counter', CTD: 'Down counter',
};

export function ladderEditor({ ladder, names = [], onChange }) {
  const root = h('div', { class: 'ladder' });
  const listId = 'ld-names-' + Math.random().toString(36).slice(2, 7);
  const datalist = h('datalist', { id: listId }, names.map((n) => h('option', { value: n })));
  let live = null; // function(name) -> value
  const elems = []; // for live update: {el, kind, get}

  function changed() {
    onChange && onChange(ladder);
  }

  function varInput(obj, key, placeholder = 'address') {
    const inp = h('input', { class: 'ld-var', value: obj[key] || '', placeholder, list: listId, spellcheck: false });
    inp.addEventListener('input', () => { obj[key] = inp.value.trim(); changed(); });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return inp;
  }

  function contactEl(rung, bi, ci) {
    const c = rung.branches[bi][ci];
    const sym = h('button', { class: 'ld-sym', title: 'Click to change contact type (NO / NC / rising / falling edge)' }, CONTACT_SYM[c.type]);
    sym.addEventListener('click', () => {
      c.type = CONTACT_TYPES[(CONTACT_TYPES.indexOf(c.type) + 1) % CONTACT_TYPES.length];
      sym.textContent = CONTACT_SYM[c.type];
      changed();
    });
    const del = h('button', { class: 'ld-x', title: 'Remove contact', onclick: () => {
      rung.branches[bi].splice(ci, 1);
      if (!rung.branches[bi].length && rung.branches.length > 1) rung.branches.splice(bi, 1);
      changed(); draw();
    } }, '×');
    const el = h('div', { class: 'ld-el contact' }, del, sym, varInput(c, 'var'));
    elems.push({ el, kind: 'contact', c });
    return el;
  }

  function outputEl(rung) {
    const o = rung.out;
    const sel = h('select', { class: 'ld-outsel', title: OUT_HELP[o.type] }, OUTPUT_TYPES.map((t) => h('option', { value: t, selected: t === o.type }, `${OUT_SYM[t]} ${t}`)));
    sel.addEventListener('change', () => { o.type = sel.value; changed(); draw(); });
    const fields = [varInput(o, 'var', /^(TON|TOF|TP|CTU|CTD)$/.test(o.type) ? 'instance, e.g. T1' : 'output / marker')];
    if (/^(TON|TOF|TP)$/.test(o.type)) fields.push(h('label', { class: 'ld-sub' }, 'PT', varInput(o, 'preset', 'T#2s')));
    if (/^(CTU|CTD)$/.test(o.type)) {
      fields.push(h('label', { class: 'ld-sub' }, 'PV', varInput(o, 'preset', '5')));
      fields.push(h('label', { class: 'ld-sub' }, o.type === 'CTU' ? 'R' : 'LD', varInput(o, 'reset', 'reset input')));
    }
    const el = h('div', { class: 'ld-el output' }, sel, ...fields);
    elems.push({ el, kind: 'out', o });
    return el;
  }

  function draw() {
    clear(root);
    elems.length = 0;
    root.append(datalist);
    ladder.rungs.forEach((rung, ri) => {
      const comment = h('input', { class: 'ld-comment', value: rung.comment || '', placeholder: 'Rung comment…' });
      comment.addEventListener('input', () => { rung.comment = comment.value; changed(); });
      comment.addEventListener('keydown', (e) => e.stopPropagation());
      const branches = h('div', { class: 'ld-branches' });
      rung.branches.forEach((br, bi) => {
        const row = h('div', { class: 'ld-branch' + (bi > 0 ? ' parallel' : '') });
        br.forEach((_, ci) => row.append(h('div', { class: 'ld-wire' }), contactEl(rung, bi, ci)));
        row.append(h('div', { class: 'ld-wire' }), h('button', { class: 'ld-add', title: 'Add contact in series', onclick: () => { br.push({ type: 'NO', var: '' }); changed(); draw(); } }, '+'), h('div', { class: 'ld-wire grow' }));
        branches.append(row);
      });
      branches.append(h('button', { class: 'ld-addpar', onclick: () => { rung.branches.push([{ type: 'NO', var: '' }]); changed(); draw(); } }, '+ parallel branch (OR)'));
      const rungEl = h('div', { class: 'ld-rung', 'data-rung': ri },
        h('div', { class: 'ld-head' },
          h('span', { class: 'ld-num' }, String(ri + 1).padStart(3, '0')), comment,
          h('button', { class: 'icon-btn sm', title: 'Move up', disabled: ri === 0, onclick: () => { [ladder.rungs[ri - 1], ladder.rungs[ri]] = [ladder.rungs[ri], ladder.rungs[ri - 1]]; changed(); draw(); } }, '↑'),
          h('button', { class: 'icon-btn sm', title: 'Move down', disabled: ri === ladder.rungs.length - 1, onclick: () => { [ladder.rungs[ri + 1], ladder.rungs[ri]] = [ladder.rungs[ri], ladder.rungs[ri + 1]]; changed(); draw(); } }, '↓'),
          h('button', { class: 'icon-btn sm', title: 'Delete rung', onclick: () => { ladder.rungs.splice(ri, 1); if (!ladder.rungs.length) ladder.rungs.push(newRung()); changed(); draw(); } }, '🗑')),
        h('div', { class: 'ld-body' }, h('div', { class: 'ld-rail' }), branches, h('div', { class: 'ld-wire out' }), outputEl(rung), h('div', { class: 'ld-rail right' })));
      root.append(rungEl);
    });
    root.append(h('button', { class: 'btn small', onclick: () => { ladder.rungs.push(newRung()); changed(); draw(); } }, '+ Add rung'));
    refreshLive();
  }

  function valueOf(name) {
    if (!live || !name) return undefined;
    const [b, m] = name.split('.');
    return live(b, m);
  }

  function refreshLive() {
    if (!live) { for (const e of elems) e.el.classList.remove('on', 'off'); return; }
    for (const e of elems) {
      if (e.kind === 'contact') {
        let v = valueOf(e.c.var);
        if (v === undefined) { e.el.classList.remove('on', 'off'); continue; }
        if (typeof v === 'object') v = v.Q;
        const closed = e.c.type === 'NC' ? !v : !!v;
        e.el.classList.toggle('on', closed);
        e.el.classList.toggle('off', !closed);
      } else {
        let v = valueOf(e.o.var);
        if (v && typeof v === 'object') v = v.Q;
        e.el.classList.toggle('on', !!v);
        e.el.classList.toggle('off', !v);
      }
    }
  }

  draw();
  return {
    el: root,
    setLive(fn) { live = fn; refreshLive(); },
    refreshLive,
    markErrors(rungs) {
      root.querySelectorAll('.ld-rung').forEach((r) => r.classList.toggle('err', rungs.includes(+r.dataset.rung)));
    },
    setLadder(l) { ladder = l; draw(); },
  };
}
