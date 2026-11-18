import { h, clear, toast, modal, prompt } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { listDocs, importFile, importPdfBytes, deleteDoc, getThumb, updateDoc, ACCEPT } from '../docs/store.js';
import { blankNotebook } from '../docs/pdf.js';
import { SAMPLES, sampleBytes } from '../docs/samples.js';
import { launchUrl } from './launch.js';

export async function libraryView(root) {
  clear(root);
  document.getElementById('crumb').textContent = '';
  const fileInput = h('input', { type: 'file', accept: ACCEPT, multiple: true, style: { display: 'none' } });
  const grid = h('div', { class: 'doc-grid' });
  const search = h('input', { class: 'input', placeholder: 'Search documents (name or text)…', oninput: () => refresh() });

  const page = h('div', { class: 'page library' },
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Library'), h('p', { class: 'muted' }, 'Import PDFs, images or text notes. Documents are analysed locally and linked to matching simulations.')),
      h('div', { class: 'row gap' },
        search,
        h('button', { class: 'btn', onclick: newNotebook }, '＋ Notebook'),
        h('button', { class: 'btn', onclick: loadSamples }, '✨ Sample documents'),
        h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '⬆ Import'),
      )),
    h('div', { class: 'dropzone', id: 'dropzone' }, h('div', {}, h('b', {}, 'Drop files here'), ' — PDF, PNG/JPG/WebP images, TXT or Markdown')),
    grid,
    fileInput,
  );
  root.append(page);

  fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
  const dz = page.querySelector('#dropzone');
  const over = (e) => { e.preventDefault(); dz.classList.add('over'); };
  root.addEventListener('dragover', over);
  root.addEventListener('dragleave', () => dz.classList.remove('over'));
  root.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFiles([...(e.dataTransfer.files || [])]);
  });

  async function handleFiles(files) {
    for (const f of files) {
      const t = h('div', { class: 'doc-card loading' }, h('div', { class: 'spinner' }), h('div', { class: 'doc-meta' }, `Importing ${f.name}…`));
      grid.prepend(t);
      try {
        const meta = await importFile(f);
        toast(`Imported “${meta.name}” (${meta.pageCount} pages)`, 'ok');
      } catch (e) {
        console.error(e);
        toast(`Import failed: ${e.message}`, 'err', 5000);
      }
    }
    refresh();
  }

  async function newNotebook() {
    const sel = h('select', { class: 'input' }, ['ruled', 'grid', 'dots', 'plain'].map((s) => h('option', { value: s }, s)));
    const pages = h('input', { class: 'input', type: 'number', value: 4, min: 1, max: 50 });
    const name = h('input', { class: 'input', value: 'Notebook ' + new Date().toLocaleDateString() });
    const r = await modal('New notebook', h('div', { class: 'form' }, h('label', {}, 'Name', name), h('label', {}, 'Paper', sel), h('label', {}, 'Pages', pages)), [
      { label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }]);
    if (!r) return;
    const bytes = await blankNotebook(Math.max(1, Math.min(50, +pages.value || 4)), sel.value);
    const meta = await importPdfBytes(name.value + '.pdf', bytes, 'notebook');
    navigate('/doc/' + meta.id);
  }

  async function loadSamples() {
    for (const s of SAMPLES) {
      const bytes = await sampleBytes(s);
      await importPdfBytes(s.name + '.pdf', bytes, 'sample');
    }
    toast(`${SAMPLES.length} sample documents added`, 'ok');
    refresh();
  }

  async function refresh() {
    const docs = await listDocs();
    const q = search.value.trim().toLowerCase();
    const shown = q ? docs.filter((d) => d.name.toLowerCase().includes(q) || (d.pagesText || []).some((p) => p.toLowerCase().includes(q))) : docs;
    clear(grid);
    if (!docs.length) {
      grid.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-art' }, '📄🧱'),
        h('h3', {}, 'Your library is empty'),
        h('p', { class: 'muted' }, 'Import a PDF or add the sample documents to see how documents become interactive simulations.'),
        h('button', { class: 'btn primary', onclick: loadSamples }, '✨ Add sample documents')));
      return;
    }
    for (const d of shown) grid.append(await card(d));
  }

  async function card(d) {
    const thumb = await getThumb(d.id);
    const top = (d.analysis && d.analysis.overall || []).filter((m) => m.confidence >= 0.35).slice(0, 2);
    const linkN = (d.links || []).length;
    const el = h('div', { class: 'doc-card' },
      h('div', { class: 'thumb', onclick: () => navigate('/doc/' + d.id) }, thumb ? h('img', { src: thumb, alt: '' }) : h('div', { class: 'thumb-ph' }, '📄')),
      h('div', { class: 'doc-meta' },
        h('div', { class: 'doc-title', title: d.name }, d.name),
        h('div', { class: 'muted small' }, `${d.pageCount} page${d.pageCount === 1 ? '' : 's'} · ${new Date(d.updated).toLocaleDateString()}`),
        h('div', { class: 'chips' },
          top.map((m) => h('a', { class: 'chip match', href: '#' + launchUrl(m.kind, m.id, { docId: d.id, params: Object.fromEntries(m.params.map((p) => [p.key, p.value])) }), title: `Confidence ${(m.confidence * 100).toFixed(0)}% – click to launch` }, `${m.icon} ${m.name} · ${(m.confidence * 100).toFixed(0)}%`)),
          linkN ? h('span', { class: 'chip' }, `🔗 ${linkN} linked`) : null),
        h('div', { class: 'row gap card-actions' },
          h('button', { class: 'btn small primary', onclick: () => navigate('/doc/' + d.id) }, 'Open'),
          h('button', { class: 'btn small', onclick: async () => { const n = await prompt('Rename document', d.name); if (n) { await updateDoc({ ...d, name: n }); refresh(); } } }, 'Rename'),
          h('button', { class: 'btn small danger', onclick: async () => {
            const ok = await modal('Delete document?', h('p', {}, `“${d.name}” and all its annotations will be removed from this browser.`), [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }]);
            if (ok) { await deleteDoc(d.id); refresh(); }
          } }, 'Delete'))));
    return el;
  }

  refresh();
  return { destroy() {} };
}
