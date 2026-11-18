// Document persistence + import pipeline (IndexedDB).
import { db, uid } from '../core/db.js';
import { loadPdf, extractText, renderThumb, textToPdf, imageToPdf } from './pdf.js';
import { analyseDocument } from './matcher.js';

export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.markdown';

export async function listDocs() {
  const docs = await db.all('docs');
  return docs.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export const getDoc = (id) => db.get('docs', id);
export const getFile = (id) => db.get('files', id);
export const updateDoc = (meta) => db.put('docs', { ...meta, updated: Date.now() });

export async function getAnnotations(id) {
  return (await db.get('annotations', id)) || { pages: {} };
}
export const saveAnnotations = (id, ann) => db.put('annotations', ann, id);

export async function deleteDoc(id) {
  await db.del('docs', id);
  await db.del('files', id);
  await db.del('annotations', id);
  await db.del('thumbs', id);
}

/** Convert any supported file into PDF bytes. */
export async function fileToPdfBytes(file) {
  const name = file.name.toLowerCase();
  const buf = new Uint8Array(await file.arrayBuffer());
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return { bytes: buf, source: 'pdf' };
  if (file.type.startsWith('image/')) return { bytes: await imageToPdf(buf, file.type), source: 'image' };
  if (/\.(txt|md|markdown)$/.test(name) || file.type.startsWith('text/')) {
    return { bytes: await textToPdf(new TextDecoder().decode(buf), file.name.replace(/\.[^.]+$/, '')), source: 'text' };
  }
  throw new Error(`Unsupported file type: ${file.name}`);
}

export async function importPdfBytes(name, bytes, source = 'pdf') {
  const pdf = await loadPdf(bytes);
  const pagesText = await extractText(pdf);
  const analysis = analyseDocument(pagesText);
  const thumb = await renderThumb(pdf).catch(() => null);
  const id = uid('doc');
  const meta = {
    id,
    name: name.replace(/\.[^.]+$/, ''),
    source,
    created: Date.now(),
    updated: Date.now(),
    pageCount: pdf.numPages,
    pagesText,
    analysis,
    links: [],
  };
  await db.put('files', bytes, id);
  await db.put('thumbs', thumb, id);
  await db.put('annotations', { pages: {} }, id);
  await db.put('docs', meta);
  pdf.destroy();
  return meta;
}

export async function importFile(file) {
  const { bytes, source } = await fileToPdfBytes(file);
  return importPdfBytes(file.name, bytes, source);
}

export const getThumb = (id) => db.get('thumbs', id);
