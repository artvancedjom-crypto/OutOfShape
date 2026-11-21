// Copies the PDF.js character maps and standard fonts into public/pdfjs so they
// are bundled with every build (web and desktop) instead of being fetched from a CDN.
// Runs automatically before `npm run dev` and `npm run build`.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

if (!existsSync(src)) {
  console.error('pdfjs-dist is not installed. Run "npm install" first.');
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(join(src, dir), join(dest, dir), { recursive: true });
  console.log(`pdfjs/${dir}: ${readdirSync(join(dest, dir)).length} files`);
}
