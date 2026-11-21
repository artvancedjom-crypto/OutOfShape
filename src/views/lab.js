import { h, clear } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { db } from '../core/db.js';
import { SCENARIOS, DIFFICULTY_ORDER, getScenario } from '../scenarios/index.js';
import { CIRCUITS } from '../circuits/library.js';
import { listUserCircuits, modifiedTemplates } from '../circuits/store.js';

export async function labView(root, q = {}) {
  clear(root);
  document.getElementById('crumb').textContent = '';
  let tab = q.tab || 'plc';
  let diff = 'All';
  const body = h('div');
  const tabs = h('div', { class: 'tabs big' });
  const page = h('div', { class: 'page lab' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Simulation Lab'), h('p', { class: 'muted' }, 'Program PLC scenarios in a 3D toy world, or explore standard electronic circuits.')),
    ),
    tabs, body);
  root.append(page);

  const drawTabs = () => {
    clear(tabs);
    for (const [k, label] of [['plc', '🏭 PLC scenarios'], ['circuits', '🔌 Circuits'], ['programs', '💾 My programs']]) {
      tabs.append(h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; drawTabs(); draw(); } }, label));
    }
  };

  const diffBadge = (d) => h('span', { class: `badge diff-${d.toLowerCase()}` }, d);

  async function draw() {
    clear(body);
    if (tab === 'plc') {
      const filt = h('div', { class: 'row gap filter' }, ['All', 'Beginner', 'Intermediate', 'Advanced'].map((d) => h('button', { class: 'pill' + (diff === d ? ' active' : ''), onclick: () => { diff = d; draw(); } }, d)));
      body.append(filt);
      const grid = h('div', { class: 'scn-grid' });
      const progs = await db.all('programs');
      [...SCENARIOS].sort((a, b) => DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty])
        .filter((s) => diff === 'All' || s.difficulty === diff)
        .forEach((s) => {
          const n = progs.filter((p) => p.scenarioId === s.id).length;
          grid.append(h('div', { class: 'scn-card', onclick: () => navigate('/plc/' + s.id) },
            h('div', { class: 'scn-art' }, h('span', {}, s.icon)),
            h('div', { class: 'scn-body' },
              h('div', { class: 'row between' }, h('h3', {}, s.name), diffBadge(s.difficulty)),
              h('p', { class: 'muted' }, s.summary),
              h('div', { class: 'row gap small muted' }, `⏱ ~${s.minutes} min`, `· ${s.io.inputs.length} inputs / ${s.io.outputs.length} outputs`, n ? `· 💾 ${n} saved` : ''),
            )));
        });
      body.append(grid);
    } else if (tab === 'circuits') {
      const edited = await modifiedTemplates();
      const mine = await listUserCircuits();
      body.append(h('div', { class: 'row between section-h' }, h('h3', {}, 'Templates'), h('button', { class: 'btn primary', onclick: () => navigate('/circuit/new') }, '＋ New empty circuit')),
        h('p', { class: 'muted small' }, 'Every template opens as your own editable copy. “File → Reset to template” restores the original.'));
      const grid = h('div', { class: 'scn-grid' });
      for (const c of CIRCUITS) {
        grid.append(h('div', { class: 'scn-card', onclick: () => navigate('/circuit/' + c.id) },
          h('div', { class: 'scn-art circuit' }, h('span', {}, c.icon)),
          h('div', { class: 'scn-body' },
            h('div', { class: 'row between' }, h('h3', {}, c.name), diffBadge(c.difficulty)),
            h('p', { class: 'muted' }, c.summary),
            h('div', { class: 'small muted' }, edited.has(c.id) ? '✏️ edited copy' : 'editable template'))));
      }
      body.append(grid, h('div', { class: 'section-h' }, h('h3', {}, `My circuits (${mine.length})`)));
      if (!mine.length) body.append(h('p', { class: 'muted small' }, 'Nothing saved yet. Start with “New empty circuit”, or open a template and use “File → Save as…”.'));
      const list = h('div', { class: 'prog-list' });
      for (const c of mine) {
        list.append(h('div', { class: 'prog-row' },
          h('div', { class: 'prog-ico' }, '🔌'),
          h('div', { class: 'grow' }, h('b', {}, c.name), h('div', { class: 'small muted' }, `${c.parts.filter((p) => p.type !== 'GND').length} parts · ${new Date(c.updated).toLocaleString()}${c.basedOn ? ' · based on ' + c.basedOn : ''}`)),
          h('button', { class: 'btn small primary', onclick: () => navigate('/circuit/' + c.id) }, 'Open')));
      }
      body.append(list);
    } else {
      const progs = (await db.all('programs')).filter((p) => !p.autosave).sort((a, b) => b.updated - a.updated);
      if (!progs.length) {
        body.append(h('div', { class: 'empty' }, h('h3', {}, 'No saved programs yet'), h('p', { class: 'muted' }, 'Open a scenario, edit its logic and press “Save as…”.')));
        return;
      }
      const list = h('div', { class: 'prog-list' });
      for (const p of progs) {
        const s = getScenario(p.scenarioId);
        list.append(h('div', { class: 'prog-row' },
          h('div', { class: 'prog-ico' }, s ? s.icon : '?'),
          h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'small muted' }, `${s ? s.name : p.scenarioId} · ${p.lang === 'LD' ? 'Ladder' : 'Structured Text'} · ${new Date(p.updated).toLocaleString()}`)),
          h('button', { class: 'btn small primary', onclick: () => navigate(`/plc/${p.scenarioId}?program=${p.id}`) }, 'Open'),
          h('button', { class: 'btn small danger', onclick: async () => { await db.del('programs', p.id); draw(); } }, 'Delete')));
      }
      body.append(list);
    }
  }
  drawTabs();
  draw();
  return { destroy() {} };
}
