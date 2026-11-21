import { h, clear } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { db } from '../core/db.js';
import { platform } from '../platform/index.js';
import { SCENE_TEMPLATES } from '../kit/templates.js';
import { templateScene } from '../kit/templates.js';
import { ioList } from '../kit/model.js';
import { listUserScenes, modifiedSceneTemplates } from '../kit/store.js';
const DIFFICULTY_ORDER = { Beginner: 0, Intermediate: 1, Advanced: 2 };
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
      h('div', {}, h('h1', {}, 'Simulation Lab'), h('p', { class: 'muted' }, 'Build and program PLC plants from a brick kit in 3D, or build and measure electronic circuits.')),
    ),
    tabs, body);
  root.append(page);

  const drawTabs = () => {
    clear(tabs);
    for (const [k, label] of [['plc', '🏭 PLC plants'], ['circuits', '🔌 Circuits']]) {
      tabs.append(h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; drawTabs(); draw(); } }, label));
    }
  };

  const diffBadge = (d) => h('span', { class: `badge diff-${d.toLowerCase()}` }, d);

  async function draw() {
    clear(body);
    if (tab === 'plc') {
      const edited = await modifiedSceneTemplates();
      const mine = await listUserScenes();
      const filt = h('div', { class: 'row gap filter' }, ['All', 'Beginner', 'Intermediate', 'Advanced'].map((d) => h('button', { class: 'pill' + (diff === d ? ' active' : ''), onclick: () => { diff = d; draw(); } }, d)));
      body.append(h('div', { class: 'row between section-h' }, h('h3', {}, 'Templates'), h('button', { class: 'btn primary', onclick: () => navigate('/plc/new') }, '＋ New empty plant')),
        h('p', { class: 'muted small' }, 'Every template is built from kit elements and opens as your own editable copy: move, replace or rewire anything. “File → Reset to template” restores the original.'), filt);
      const grid = h('div', { class: 'scn-grid' });
      [...SCENE_TEMPLATES].sort((a, b) => DIFFICULTY_ORDER[a.difficulty] - DIFFICULTY_ORDER[b.difficulty])
        .filter((s) => diff === 'All' || s.difficulty === diff)
        .forEach((s) => {
          const rows = ioList(templateScene(s.id));
          const ins = rows.filter((r) => r.dir === 'in').length;
          grid.append(h('div', { class: 'scn-card', onclick: () => navigate('/plc/' + s.id) },
            h('div', { class: 'scn-art' }, h('span', {}, s.icon)),
            h('div', { class: 'scn-body' },
              h('div', { class: 'row between' }, h('h3', {}, s.name), diffBadge(s.difficulty)),
              h('p', { class: 'muted' }, s.summary),
              h('div', { class: 'row gap small muted' }, `⏱ ~${s.minutes} min`, `· ${ins} inputs / ${rows.length - ins} outputs`, edited.has(s.id) ? '· ✏️ edited copy' : ''),
            )));
        });
      body.append(grid, h('div', { class: 'section-h' }, h('h3', {}, `My plants (${mine.length})`)));
      if (!mine.length) body.append(h('p', { class: 'muted small' }, 'Nothing saved yet. Start with “New empty plant”, or open a template and use “File → Save as…”.'));
      const list = h('div', { class: 'prog-list' });
      for (const c of mine) {
        list.append(h('div', { class: 'prog-row' },
          h('div', { class: 'prog-ico' }, '🏭'),
          h('div', { class: 'grow' }, h('b', {}, c.name), h('div', { class: 'small muted' }, `${c.elements.length} elements · ${c.program.lang === 'LD' ? 'Ladder' : 'Structured Text'} · ${new Date(c.updated).toLocaleString()}${c.basedOn ? ' · based on ' + c.basedOn : ''}`)),
          h('button', { class: 'btn small primary', onclick: () => navigate('/plc/' + c.id) }, 'Open')));
      }
      body.append(list);
      // programs saved with version 1.0/1.1 were written for the fixed scenarios
      const old = (await db.all('programs')).filter((p) => !p.autosave).sort((a, b) => b.updated - a.updated);
      if (old.length) {
        body.append(h('div', { class: 'section-h' }, h('h3', {}, `Programs saved with an earlier version (${old.length})`)),
          h('p', { class: 'muted small' }, 'These were written for the fixed scenarios of version 1.1. The plants are now built from kit elements with new tag names, so the programs cannot run unchanged. Download them to keep the text and copy what you need into the program editor.'));
        const l2 = h('div', { class: 'prog-list' });
        for (const p of old) {
          l2.append(h('div', { class: 'prog-row' }, h('div', { class: 'prog-ico' }, '💾'),
            h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'small muted' }, `${p.scenarioId} · ${p.lang === 'LD' ? 'Ladder' : 'Structured Text'} · ${new Date(p.updated).toLocaleString()}`)),
            h('button', { class: 'btn small', onclick: () => platform.saveFile(`${p.name}.${p.lang === 'LD' ? 'ladder.json' : 'st'}`, typeof p.source === 'string' ? p.source : JSON.stringify(p.source, null, 2), { mime: 'text/plain' }) }, 'Download'),
            h('button', { class: 'btn small danger', onclick: async () => { await db.del('programs', p.id); draw(); } }, 'Delete')));
        }
        body.append(l2);
      }
    } else {
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
    }
  }
  drawTabs();
  draw();
  return { destroy() {} };
}
