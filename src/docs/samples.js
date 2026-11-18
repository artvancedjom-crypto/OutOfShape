// Built-in sample documents (generated client-side) to demo the PDF → simulation flow.
import { PDFDocument } from 'pdf-lib';
import { textToPdf } from './pdf.js';

export { SAMPLES } from './samples-data.js';

export async function sampleBytes(sample) {
  if (sample.pages) {
    const out = await PDFDocument.create();
    for (const p of sample.pages) {
      const src = await PDFDocument.load(await textToPdf(p, ''));
      const [pg] = await out.copyPages(src, [0]);
      out.addPage(pg);
    }
    return out.save();
  }
  return textToPdf(sample.text, '');
}
