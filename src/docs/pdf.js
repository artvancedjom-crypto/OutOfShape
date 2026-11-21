// PDF loading (pdf.js) and conversion of other formats into PDF (pdf-lib),
// so the editor always works on a PDF base layer.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

/** pdf.js detaches the buffer it receives, so always hand it a copy. */
export function loadPdf(bytes) {
  // CMaps and the 14 standard fonts ship with the app (copied to public/pdfjs by
  // scripts/copy-pdf-assets.mjs), so CJK PDFs and PDFs without embedded fonts
  // render offline and nothing is fetched from a CDN.
  const base = new URL('pdfjs/', document.baseURI).href;
  return pdfjs.getDocument({
    data: new Uint8Array(bytes).slice(),
    isEvalSupported: false,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
  }).promise;
}

/** Extract text per page, with simple line reconstruction. */
export async function extractText(pdf) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let lastY = null;
    let text = '';
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
      else if (text && !text.endsWith(' ') && it.str && !it.str.startsWith(' ')) text += ' ';
      text += it.str;
      lastY = y;
      if (it.hasEOL) { text += '\n'; lastY = null; }
    }
    pages.push(text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  }
  return pages;
}

export async function renderThumb(pdf, width = 180) {
  const page = await pdf.getPage(1);
  const vp0 = page.getViewport({ scale: 1, rotation: 0 });
  const vp = page.getViewport({ scale: width / vp0.width, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas.toDataURL('image/jpeg', 0.75);
}

const A4 = [595.28, 841.89];

/** WinAnsi-safe text for standard fonts */
export function winAnsi(s) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/Ω/g, 'Ohm')
    .replace(/µ/g, 'u')
    .replace(/τ/g, 'tau')
    .replace(/[≈]/g, '~')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (measure(test) > maxWidth && line.trim()) {
        lines.push(line.trimEnd());
        line = w.trimStart();
        // hard-break very long words
        while (measure(line) > maxWidth && line.length > 1) {
          let k = line.length;
          while (k > 1 && measure(line.slice(0, k)) > maxWidth) k--;
          lines.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = test;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Plain text / markdown → simple paginated PDF. */
export async function textToPdf(text, title = '') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 56;
  const width = A4[0] - margin * 2;
  let page = doc.addPage(A4);
  let y = A4[1] - margin;
  const newPage = () => { page = doc.addPage(A4); y = A4[1] - margin; };
  const write = (str, f, size, gap = 4) => {
    const lines = wrapText(winAnsi(str), width, (s) => f.widthOfTextAtSize(s, size));
    for (const ln of lines) {
      if (y < margin + size) newPage();
      page.drawText(ln, { x: margin, y: y - size, size, font: f, color: rgb(0.1, 0.1, 0.12) });
      y -= size + gap;
    }
  };
  if (title) { write(title, bold, 18, 10); y -= 6; }
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (m) { y -= 6; write(m[2], bold, [18, 15, 13][m[1].length - 1], 6); continue; }
    if (!raw.trim()) { y -= 8; continue; }
    write(raw.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^[-*]\s+/, '•  '.replace('•', '-')), font, 11);
  }
  return doc.save();
}

/** Image file → single-page PDF sized to the image (max A4-ish). */
export async function imageToPdf(bytes, mime) {
  const doc = await PDFDocument.create();
  let img;
  if (mime === 'image/png') img = await doc.embedPng(bytes);
  else if (mime === 'image/jpeg') img = await doc.embedJpg(bytes);
  else {
    // convert other image types via canvas to PNG
    const png = await reencodeImage(new Blob([bytes], { type: mime }), 'image/png');
    img = await doc.embedPng(png);
  }
  const scale = Math.min(1, A4[0] / img.width, A4[1] / img.height) || 1;
  const w = img.width * scale;
  const h = img.height * scale;
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return doc.save();
}

export async function reencodeImage(blob, type = 'image/png', maxDim = 2400) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, maxDim / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise((res) => c.toBlob(res, type, 0.9));
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Blank notebook with ruled/grid/plain pages */
export async function blankNotebook(pages = 4, style = 'ruled') {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage(A4);
    const c = rgb(0.75, 0.82, 0.9);
    if (style === 'ruled') {
      for (let y = A4[1] - 90; y > 40; y -= 24) p.drawLine({ start: { x: 40, y }, end: { x: A4[0] - 40, y }, thickness: 0.5, color: c });
      p.drawLine({ start: { x: 80, y: 30 }, end: { x: 80, y: A4[1] - 30 }, thickness: 0.6, color: rgb(0.95, 0.6, 0.6) });
    } else if (style === 'grid') {
      for (let y = A4[1] - 30; y > 30; y -= 18) p.drawLine({ start: { x: 30, y }, end: { x: A4[0] - 30, y }, thickness: 0.3, color: c });
      for (let x = 30; x < A4[0] - 29; x += 18) p.drawLine({ start: { x, y: 30 }, end: { x, y: A4[1] - 30 }, thickness: 0.3, color: c });
    } else if (style === 'dots') {
      for (let y = A4[1] - 30; y > 30; y -= 18) for (let x = 30; x < A4[0] - 29; x += 18) p.drawCircle({ x, y, size: 0.7, color: c });
    }
  }
  return doc.save();
}
