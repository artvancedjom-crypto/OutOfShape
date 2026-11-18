// Live I/O panel: inputs (with manual operation and forcing), outputs,
// internal variables, timers and counters.
import { h, clear } from '../core/dom.js';
import { formatTime } from '../plc/st-lexer.js';

function fmtVal(type, v) {
  if (type === 'BOOL') return v ? 'TRUE' : 'FALSE';
  if (type === 'TIME') return formatTime(v);
  if (type === 'REAL' || type === 'LREAL') return (+v).toFixed(2);
  return String(v);
}

export function ioPanel(rt, scenario) {
  const root = h('div', { class: 'io-panel' });
  const rows = [];
  let internalsHost;
  let fbHost;
  let lastSig = '';

  const forceBtn = (name, type) => {
    const b = h('button', { class: 'force', title: 'Force: none → TRUE → FALSE (overrides field / program)' }, 'F');
    b.addEventListener('click', () => {
      const has = Object.prototype.hasOwnProperty.call(rt.forces, name);
      if (type !== 'BOOL') {
        if (has) rt.force(name, undefined);
        else rt.force(name, rt.getOutput(name) ?? rt.inputs[name] ?? 0);
      } else if (!has) rt.force(name, true);
      else if (rt.forces[name] === true) rt.force(name, false);
      else rt.force(name, undefined);
    });
    return b;
  };

  function inputControl(p) {
    const t = p.type || 'BOOL';
    if (t !== 'BOOL') {
      if (p.ui === 'setpoint' || p.ui === 'analog') {
        const inp = h('input', { class: 'num', type: 'number', step: 'any', title: p.ui === 'analog' ? 'Analog value comes from the process; type to force' : 'HMI setpoint (also adjustable in Parameters)' });
        inp.addEventListener('change', () => {
          const v = t === 'TIME' ? parseFloat(inp.value) * 1000 : parseFloat(inp.value);
          if (p.ui === 'analog') rt.force(p.name, v);
          else rt.setInput(p.name, v);
        });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        return inp;
      }
      return null;
    }
    if (p.ui === 'momentary' || p.ui === 'nc-momentary') {
      const nc = p.ui === 'nc-momentary';
      const b = h('button', { class: 'btn tiny' }, 'press');
      b.addEventListener('pointerdown', () => rt.setInput(p.name, !nc));
      const up = () => rt.setInput(p.name, nc);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', (e) => { if (e.buttons) up(); });
      return b;
    }
    if (p.ui === 'toggle' || p.ui === 'nc-toggle') {
      const b = h('button', { class: 'btn tiny' }, 'toggle');
      b.addEventListener('click', () => rt.setInput(p.name, !rt.inputs[p.name]));
      return b;
    }
    return h('span', { class: 'small muted' }, 'sensor');
  }

  function section(title, list, dir) {
    const tbody = h('tbody');
    for (const p of list) {
      const t = p.type || 'BOOL';
      const lampEl = h('span', { class: 'lamp' });
      const valEl = h('span', { class: 'val' });
      const ctrl = dir === 'input' ? inputControl(p) : null;
      const tr = h('tr', { title: p.desc || '' },
        h('td', {}, t === 'BOOL' ? lampEl : null),
        h('td', { class: 'name' }, p.name, p.desc ? h('div', { class: 'desc' }, p.desc) : null),
        h('td', { class: 'addr' }, p.addr || ''),
        h('td', {}, valEl),
        h('td', { class: 'ctl' }, ctrl, forceBtn(p.name, t)));
      rows.push({ p, t, dir, lampEl, valEl, tr, ctrl });
      tbody.append(tr);
    }
    return h('div', { class: 'io-sec' }, h('h4', {}, title), h('table', { class: 'io-table' }, tbody));
  }

  root.append(section('Inputs', scenario.io.inputs, 'input'), section('Outputs', scenario.io.outputs, 'output'));
  fbHost = h('div', { class: 'io-sec' });
  internalsHost = h('div', { class: 'io-sec' });
  root.append(fbHost, internalsHost);

  function buildInternals() {
    const items = rt.internals();
    const sig = items.map((i) => i.name + i.type).join(',');
    if (sig === lastSig) return;
    lastSig = sig;
    clear(fbHost);
    clear(internalsHost);
    const fbs = items.filter((i) => i.fb && !i.name.startsWith('_'));
    const vars = items.filter((i) => !i.fb);
    if (fbs.length) {
      fbHost.append(h('h4', {}, 'Timers, counters & function blocks'));
      for (const f of fbs) {
        const bar = h('div', { class: 'bar' }, h('i'));
        const info = h('span', { class: 'val' });
        const lampEl = h('span', { class: 'lamp' });
        f._ui = { bar, info, lampEl };
        fbHost.append(h('div', { class: 'fb-row' }, lampEl, h('b', {}, f.name), h('span', { class: 'small muted' }, f.type), bar, info));
      }
    }
    if (vars.length) {
      internalsHost.append(h('h4', {}, 'Internal variables'));
      const tb = h('tbody');
      for (const v of vars) {
        const valEl = h('span', { class: 'val' });
        const lampEl = h('span', { class: 'lamp' });
        v._ui = { valEl, lampEl };
        tb.append(h('tr', {}, h('td', {}, v.type === 'BOOL' ? lampEl : null), h('td', { class: 'name' }, v.name, v.constant ? h('span', { class: 'small muted' }, ' const') : null), h('td', { class: 'addr' }, v.type), h('td', {}, valEl)));
      }
      internalsHost.append(h('table', { class: 'io-table' }, tb));
    }
    root._internals = items;
  }

  function update() {
    for (const r of rows) {
      const v = r.dir === 'input' ? rt.effectiveInput(r.p.name) : rt.getOutput(r.p.name);
      if (r.t === 'BOOL') r.lampEl.classList.toggle('on', !!v);
      r.valEl.textContent = fmtVal(r.t, v);
      r.tr.classList.toggle('forced', Object.prototype.hasOwnProperty.call(rt.forces, r.p.name));
      if (r.ctrl && r.ctrl.tagName === 'INPUT' && document.activeElement !== r.ctrl) {
        r.ctrl.value = r.t === 'TIME' ? (v / 1000).toString() : (+v).toFixed(r.p.ui === 'analog' ? 1 : 1);
      }
    }
    buildInternals();
    const items = root._internals || [];
    const fresh = rt.internals();
    items.forEach((it, i) => {
      const cur = fresh[i];
      if (!cur || !it._ui) return;
      if (it.fb) {
        const fb = cur.fb;
        let frac = 0;
        let txt = '';
        let q = fb.Q ?? fb.Q1 ?? fb.QU;
        if ('PT' in fb) { frac = fb.PT ? fb.ET / fb.PT : 0; txt = `${formatTime(fb.ET)} / ${formatTime(fb.PT)}`; }
        else if ('CV' in fb) { frac = fb.PV ? Math.min(1, Math.abs(fb.CV) / fb.PV) : 0; txt = `CV ${fb.CV} / PV ${fb.PV}`; }
        else txt = q ? 'Q' : '';
        it._ui.bar.firstChild.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        it._ui.info.textContent = txt;
        it._ui.lampEl.classList.toggle('on', !!q);
      } else {
        it._ui.valEl.textContent = fmtVal(it.type, cur.value);
        it._ui.lampEl.classList.toggle('on', !!cur.value);
      }
    });
  }
  return { el: root, update, rebuild() { lastSig = ''; } };
}
