import './styles.css';
import { h } from './core/dom.js';
import { route, startRouter } from './core/router.js';
import { applyTheme, getTheme, toggleTheme } from './core/theme.js';
import { bus } from './core/bus.js';
import { libraryView } from './views/library.js';
import { labView } from './views/lab.js';
import { sceneView } from './views/scene.js';
import { circuitView } from './views/circuit.js';
import { editorView } from './views/editor.js';
import { appMenuButton, initAppIntegration } from './app-menu.js';

applyTheme(getTheme());

function topbar() {
  const bar = document.getElementById('topbar');
  const link = (href, label, icon) => h('a', { href: '#' + href, class: 'nav-link', 'data-path': href }, h('span', { class: 'nav-ico' }, icon), label);
  const themeBtn = h('button', { class: 'icon-btn', title: 'Toggle dark / light theme', onclick: toggleTheme }, getTheme() === 'dark' ? '☀️' : '🌙');
  bus.on('theme', (t) => { themeBtn.textContent = t === 'dark' ? '☀️' : '🌙'; });
  bar.append(
    h('a', { class: 'brand', href: '#/library' }, h('span', { class: 'brand-brick' }, h('i'), h('i')), h('span', {}, 'OutOfShape', h('b', {}, ' Lab'))),
    h('nav', {}, link('/library', 'Library', '📚'), link('/lab', 'Simulation Lab', '🧪')),
    h('div', { class: 'spacer' }),
    h('span', { id: 'crumb', class: 'crumb' }),
    appMenuButton(),
    themeBtn,
  );
  const mark = () => {
    const p = location.hash.slice(1);
    for (const a of bar.querySelectorAll('.nav-link')) {
      const ap = a.dataset.path;
      const active = p.startsWith(ap) || (ap === '/lab' && /^\/(plc|circuit)\//.test(p)) || (ap === '/library' && p.startsWith('/doc/'));
      a.classList.toggle('active', active);
    }
  };
  window.addEventListener('hashchange', mark);
  mark();
}

const viewEl = () => document.getElementById('view');
route('/library', () => libraryView(viewEl()));
route('/lab', (p, q) => labView(viewEl(), q));
route('/plc/:id', (p, q) => sceneView(viewEl(), p.id, q));
route('/circuit/:id', (p, q) => circuitView(viewEl(), p.id, q));
route('/doc/:id', (p, q) => editorView(viewEl(), p.id, q));

topbar();
initAppIntegration();
startRouter();
