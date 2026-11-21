// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const S = (x, y) => page.evaluate(([x, y]) => { const e = window.__ce.editor; const r = e.svg.getBoundingClientRect(); return [r.left + e.pan[0] + x * 20 * e.zoom, r.top + e.pan[1] + y * 20 * e.zoom]; }, [x, y]);
  const click = async (x, y) => { const [cx, cy] = await S(x, y); await page.mouse.click(cx, cy); await page.waitForTimeout(60); };
  const log = (...a) => console.log('✓', ...a);
  await page.goto(BASE + '#/circuit/new'); await page.waitForFunction(() => window.__ce && location.hash.includes('c_')); await page.waitForTimeout(400);
  // Alt = free placement
  await page.click('.ce-pal-item:has-text("Resistor")');
  const [ax, ay] = await S(5.37, 3.62); await page.keyboard.down('Alt'); await page.mouse.move(ax, ay); await page.mouse.click(ax, ay); await page.keyboard.up('Alt');
  await click(12, 8); await page.keyboard.press('Escape');
  const pos = await page.evaluate(() => window.__ce.doc.parts.map((p) => [p.x, p.y]));
  assert.ok(pos[0][0] % 1 !== 0 && pos[1][0] % 1 === 0, JSON.stringify(pos)); log('Alt places off-grid', JSON.stringify(pos[0]), 'normal click snaps', JSON.stringify(pos[1]));
  // right-angle routing option
  await page.click('text=Routing: manual'); await page.keyboard.press('w'); await click(14, 8); await click(18, 12); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  let w = await page.evaluate(() => window.__ce.doc.wires[0].pts); assert.equal(w.length, 3); assert.ok(w[1][0] === w[0][0] || w[1][1] === w[0][1]); log('right-angle routing inserts the corner:', JSON.stringify(w));
  await page.click('text=Routing: right-angle'); await page.keyboard.press('w'); await click(14, 10); await click(18, 14); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  w = await page.evaluate(() => window.__ce.doc.wires[1].pts); assert.equal(w.length, 2); log('manual routing keeps the free diagonal:', JSON.stringify(w));
  // pan with right drag
  const p0 = await page.evaluate(() => window.__ce.editor.pan.slice()); const [px, py] = await S(20, 5); await page.mouse.move(px, py); await page.mouse.down({ button: 'right' }); await page.mouse.move(px + 80, py + 40, { steps: 3 }); await page.mouse.up({ button: 'right' });
  const p1 = await page.evaluate(() => window.__ce.editor.pan.slice()); assert.ok(Math.abs(p1[0] - p0[0] - 80) < 2 && Math.abs(p1[1] - p0[1] - 40) < 2); log('right-drag pans');
  // values from a document land on the template
  await page.goto(BASE + '#/circuit/rc?params=' + encodeURIComponent(JSON.stringify({ R: 22000, C: 4.7e-5, V: 9 }))); await page.waitForFunction(() => window.__ce && window.__ce.doc.templateId === 'rc'); await page.waitForTimeout(300);
  const v = await page.evaluate(() => { const d = window.__ce.doc; const g = (n) => d.parts.find((p) => p.name === n).params; return [g('R1').R, g('C1').C, g('V1').V]; });
  assert.deepEqual(v, [22000, 4.7e-5, 9]); log('document parameters applied to the template parts:', v.join(', '));
  // push button held: momentary, no undo entry
  await page.goto(BASE + '#/circuit/relay'); await page.waitForFunction(() => window.__ce && window.__ce.doc.templateId === 'relay'); await page.waitForTimeout(400);
  const on = () => page.evaluate(() => window.__ce.sim.result.comp.K1.on);
  const u0 = await page.evaluate(() => window.__ce.editor.undoStack.length);
  let [bx, by] = await S(8, 10); await page.mouse.move(bx, by); await page.mouse.down(); await page.waitForTimeout(250); const held = await on(); await page.mouse.up(); await page.waitForTimeout(250);
  assert.equal(held, true); assert.equal(await on(), true); log('START held → relay pulls in and holds after release');
  [bx, by] = await S(8, 5); await page.mouse.move(bx, by); await page.mouse.down(); await page.waitForTimeout(250); await page.mouse.up(); await page.waitForTimeout(250);
  assert.equal(await on(), false); assert.equal(await page.evaluate(() => window.__ce.editor.undoStack.length), u0); log('STOP releases it; button presses add no undo steps');
  await page.screenshot({ path: OUT + '/relay2.png' });
  // backup contains circuits
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('button[title="Data, backup and about"]'); await page.click('text=⬇ Export all data (ZIP)…'); })()]);
  await dl.saveAs(OUT + '/backup.zip');
  const { unzipSync, strFromU8 } = require('fflate');
  const z = unzipSync(new Uint8Array(require('fs').readFileSync(OUT + '/backup.zip')));
  const circuits = JSON.parse(strFromU8(z['circuits.json'])); const man = JSON.parse(strFromU8(z['manifest.json']));
  assert.ok(circuits.length >= 2 && man.format === 2 && man.counts.circuits === circuits.length); log('backup ZIP (format 2) contains', circuits.length, 'circuits');
  const page2 = await (await browser.newContext()).newPage();
  await page2.goto(BASE + '#/library'); await page2.waitForTimeout(500);
  const [fc] = await Promise.all([page2.waitForEvent('filechooser'), (async () => { await page2.click('button[title="Data, backup and about"]'); await page2.click('text=⬆ Import data…'); })()]);
  await fc.setFiles(OUT + '/backup.zip'); await page2.click('.modal-foot >> text=Merge'); await page2.waitForTimeout(1500);
  await page2.goto(BASE + '#/lab?tab=circuits'); await page2.waitForTimeout(600);
  assert.ok(await page2.locator('.prog-row').count() >= 1); log('imported into a fresh profile: circuits are back');
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
