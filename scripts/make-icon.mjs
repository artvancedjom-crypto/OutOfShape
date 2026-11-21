// Regenerates build/icon.png and build/icon.ico from build/icon.svg.
// Only needed when you change the icon; the generated files are committed.
// Needs Playwright with Chromium:  npm i -D playwright && npx playwright install chromium
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const svg = readFileSync(join(build, 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const browser = await chromium.launch();
const pngs = [];
for (const size of [...SIZES, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  if (size === 512) writeFileSync(join(build, 'icon.png'), png);
  else pngs.push({ size, png });
  await page.close();
}
await browser.close();

// ICO container with PNG-compressed entries (supported since Windows Vista)
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const dir = pngs.map(({ size, png }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size === 256 ? 0 : size, 0);
  e.writeUInt8(size === 256 ? 0 : size, 1);
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  return e;
});
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...dir, ...pngs.map((p) => p.png)]));
console.log(`icon.ico (${SIZES.join(', ')} px) and icon.png written to build/`);
