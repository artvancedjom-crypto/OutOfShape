// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
// Phase 3 end-to-end: catalog browsing, variant with validation + curve, favourites,
// subcircuit, JSON export/import, persistence.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' ')));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', (d) => d.accept(d.defaultValue()));
  const log = (...a) => console.log('✓', ...a);
  const S = (x, y) => page.evaluate(([x, y]) => { const e = window.__ce.editor; const r = e.svg.getBoundingClientRect(); return [r.left + e.pan[0] + x * 20 * e.zoom, r.top + e.pan[1] + y * 20 * e.zoom]; }, [x, y]);
  const click = async (x, y) => { const [cx, cy] = await S(x, y); await page.mouse.click(cx, cy); await page.waitForTimeout(60); };
  const inkOf = (sel) => page.evaluate((sel) => { const c = document.querySelector(sel); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 100) n++; return n; }, sel);

  await page.goto(BASE + '#/circuit/led');
  await page.waitForFunction(() => window.__ce && window.__ce.doc.templateId === 'led');
  await page.waitForTimeout(400);

  // ---- browse the catalog
  const cats = await page.locator('.ce-pal-list .menu-h').allInnerTexts();
  for (const c of ['SOURCES', 'PASSIVE', 'SEMICONDUCTORS', 'SWITCHES & RELAYS', 'DISPLAYS & LAMPS', 'MOTORS', 'PROTECTION', 'INSTRUMENTS']) assert.ok(cats.map((x) => x.toUpperCase()).includes(c), 'category ' + c);
  log('palette shows all 8 categories:', cats.join(', '));
  await page.fill('.ce-palette input', 'mosfet'); assert.equal(await page.locator('.ce-pal-item').count(), 2); await page.fill('.ce-palette input', ''); log('search "mosfet" → 2 parts');
  await page.click('text=📚 Catalog…'); await page.waitForSelector('.cat-manager');
  await page.click('.cat-row[data-type="LED"]'); await page.waitForTimeout(200);
  const detail = await page.locator('.cat-detail').innerText();
  assert.ok(/Shockley/.test(detail) && /Rated current/.test(detail) && /rated limit/.test(detail) && /A · K/.test(detail), detail.slice(0, 300));
  assert.ok(await inkOf('.cat-detail canvas.curve') > 50, 'curve drawn'); log('catalog detail for LED: symbol, pins, parameters with units, rated limit, model, characteristic curve');
  await page.screenshot({ path: OUT + '/manager.png' });

  // ---- new variant with validation and live curve
  await page.click('text=＋ New variant of this model'); await page.waitForSelector('.variant-form');
  await page.fill('.variant-form .field:has-text("Name") input', 'Cree blue 3.2V');
  const irated = page.locator('.variant-form .field[data-key="Irated"] input');
  await irated.fill('lots'); await page.click('text=Save to catalog'); await page.waitForTimeout(150);
  assert.ok(await page.locator('.variant-form').count(), 'invalid form stays open'); assert.ok(/Not a number/.test(await page.locator('.variant-form .field[data-key="Irated"] .field-err').innerText()));
  await irated.fill('-1'); assert.ok(/at least/.test(await page.locator('.variant-form .field[data-key="Irated"] .field-err').innerText())); log('validation: "lots" and "-1" are rejected with a reason');
  await irated.fill('20m');
  await page.selectOption('.variant-form .field[data-key="model"] select', 'blue');
  const before = await page.evaluate(() => document.querySelector('.variant-form canvas').toDataURL());
  const hl = page.locator('.variant-form .helper input'); await hl.nth(0).fill('3.2'); await hl.nth(1).fill('20m'); await hl.nth(2).fill('2.2'); await page.click('text=Calculate Is'); await page.waitForTimeout(200);
  const after = await page.evaluate(() => document.querySelector('.variant-form canvas').toDataURL());
  assert.notEqual(before, after, 'curve preview changed'); assert.ok(await inkOf('.variant-form canvas') > 50);
  await page.screenshot({ path: OUT + '/variant.png' });
  await page.click('text=Save to catalog'); await page.waitForSelector('.variant-form', { state: 'detached' });
  log('variant "Cree blue 3.2V" saved; Is fitted from the datasheet point, curve preview updated');
  const badge = await page.locator('.cat-detail .badge').innerText(); assert.equal(badge, 'My part');
  // favourite
  await page.click('text=☆ Add to favourites'); await page.waitForTimeout(150);
  await page.click('.modal-foot .btn'); await page.waitForTimeout(300);
  assert.ok(/favourites/i.test(await page.locator('.ce-pal-list .menu-h').first().innerText())); assert.ok(await page.locator('.ce-pal-item:has-text("Cree blue 3.2V")').count() >= 2); log('favourite appears at the top of the palette and under Semiconductors, marked "mine"');

  // ---- use it: replace the LED in the template
  const type = await page.evaluate(() => Object.keys(window.__ce.editor.constructor ? {} : {}).length || null);
  await click(21, 9); await page.keyboard.press('Delete');
  await page.locator('.ce-pal-item:has-text("Cree blue 3.2V")').first().click(); await page.keyboard.press('r'); await click(21, 9); await page.keyboard.press('Escape');
  await page.evaluate(() => { const { doc, editor } = window.__ce; doc.parts.find((p) => p.name === 'R1').params.R = 290; editor.commit('t'); }); await page.waitForTimeout(300);
  const led = await page.evaluate(() => { const { doc, sim } = window.__ce; const p = doc.parts.find((q) => q.type.startsWith('u_')); const r = sim.partResult(p); return { v: r.v, i: r.i, diag: sim.diagnostics.map((d) => d.code) }; });
  assert.ok(Math.abs(led.v - 3.2) < 0.02 && Math.abs(led.i - 0.02) < 0.0005, JSON.stringify(led)); log(`placed in a circuit: 9 V, 290 Ω → ${led.v.toFixed(2)} V at ${(led.i * 1000).toFixed(1)} mA (datasheet: 3.2 V at 20 mA)`);

  // ---- subcircuit: build a divider with labelled pins, save as a part
  await page.goto(BASE + '#/circuit/new'); await page.waitForFunction(() => window.__ce && location.hash.includes('c_')); await page.waitForTimeout(300);
  await page.evaluate(() => {
    const { doc, editor } = window.__ce;
    const P = (id, type, x, y, rot, params) => doc.parts.push({ id, type, name: id, x, y, rot, mirror: false, params });
    P('Ra', 'R', 4, 0, 0, { R: 1000, Pmax: 0.25 }); P('Rb', 'R', 8, 3, 1, { R: 3000, Pmax: 0.25 }); doc.parts.push({ id: 'G', type: 'GND', name: '', x: 8, y: 7, rot: 0, mirror: false, params: {} });
    doc.wires.push({ id: 'a', pts: [[0, 0], [2, 0]] }, { id: 'b', pts: [[6, 0], [8, 0], [8, 1]] }, { id: 'c', pts: [[8, 0], [12, 0]] }, { id: 'd', pts: [[8, 5], [8, 7]] });
    doc.labels.push({ id: 'l1', x: 0, y: 0, text: 'IN' }, { id: 'l2', x: 12, y: 0, text: 'OUT' });
    doc.name = 'Divider 1 to 4'; editor.commit('t');
  });
  await page.click('text=File ▾'); await page.click('text=🧩 Save as catalog part (subcircuit)…'); await page.waitForSelector('.variant-form');
  assert.equal(await page.locator('.variant-form tbody tr').count(), 2); await page.screenshot({ path: OUT + '/subcircuit.png' });
  await page.click('text=Save to catalog'); await page.waitForSelector('.variant-form', { state: 'detached' }); await page.waitForTimeout(300);
  assert.ok(await page.locator('.ce-pal-item:has-text("Divider 1 to 4")').count()); log('circuit saved as subcircuit part with outer pins IN, OUT (from its net labels)');
  // use the subcircuit in a new circuit
  await page.goto(BASE + '#/circuit/new'); await page.waitForFunction(() => window.__ce && window.__ce.doc.parts.length === 0); await page.waitForTimeout(300);
  await page.click('.ce-pal-item:has-text("Voltage source")'); await page.keyboard.press('r'); await click(0, 4);
  await page.click('.ce-pal-item:has-text("Divider 1 to 4")'); await click(8, 2);
  await page.click('.ce-pal-item:has-text("Ground")'); await click(0, 8); await page.keyboard.press('Escape');
  await page.keyboard.press('w'); await click(0, 2); await click(5, 2); await click(0, 6); await click(0, 8); await click(11, 2); await click(14, 2); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => { const { sim, doc } = window.__ce; const x = doc.parts.find((p) => p.type.startsWith('u_')); return { v: sim.nodeVoltage(14, 2), i: sim.partResult(x).pinI[0], diag: sim.diagnostics.map((d) => d.code + ':' + d.message) }; });
  assert.ok(out.v && Math.abs(out.v.v - 6.75) < 1e-6 && Math.abs(out.i - 9 / 4000) < 1e-9, JSON.stringify(out)); log(`subcircuit in a new circuit: 9 V in → ${out.v.v} V out, ${(out.i * 1000).toFixed(2)} mA into IN (hand: 6.75 V, 2.25 mA)`);
  await page.screenshot({ path: OUT + '/sub-used.png' });

  // ---- export, then import into a fresh profile
  await page.click('text=📚 Catalog…'); await page.waitForSelector('.cat-manager');
  await page.selectOption('.cat-left select', 'My parts'); assert.equal(await page.locator('.cat-row').count(), 2);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Export my parts')]);
  await dl.saveAs(OUT + '/my-parts.catalog.json');
  const file = JSON.parse(fs.readFileSync(OUT + '/my-parts.catalog.json', 'utf8')); assert.equal(file.entries.length, 2); log('exported', file.entries.map((e) => `${e.name} (${e.kind})`).join(', '));
  await page.click('.modal-foot .btn');
  // persistence across reload (stored in the data folder / IndexedDB)
  await page.reload(); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(500);
  assert.ok(await page.locator('.ce-pal-item:has-text("Cree blue 3.2V")').count() && await page.evaluate(() => window.__ce.doc.parts.some((p) => p.type.startsWith('u_')))); log('after reload: catalog entries and the circuit using them are still there');
  const stored = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('outofshape-lab'); q.onsuccess = () => { const t = q.result.transaction('catalog').objectStore('catalog').getAll(); t.onsuccess = () => r(t.result.length); }; })); assert.equal(stored, 2);

  const p2 = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  p2.on('pageerror', (e) => errs.push('P2 ' + e.message));
  await p2.goto(BASE + '#/circuit/new'); await p2.waitForFunction(() => window.__ce && location.hash.includes('c_')); await p2.waitForTimeout(300);
  assert.equal(await p2.locator('.ce-pal-item:has-text("Cree blue")').count(), 0);
  await p2.click('text=📚 Catalog…');
  const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('text=⬆ Import JSON…')]);
  await fc.setFiles(OUT + '/my-parts.catalog.json'); await p2.waitForTimeout(600); await p2.click('.modal-foot .btn'); await p2.waitForTimeout(300);
  assert.ok(await p2.locator('.ce-pal-item:has-text("Cree blue 3.2V")').count() && await p2.locator('.ce-pal-item:has-text("Divider 1 to 4")').count()); log('imported the JSON into a fresh profile: both parts appear in its palette');
  // bad file
  fs.writeFileSync(OUT + '/bad.json', JSON.stringify({ file: 'outofshape-catalog', entries: [{ kind: 'variant', name: 'x', base: 'NOPE' }] }));
  await p2.click('text=📚 Catalog…'); const [fc2] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('text=⬆ Import JSON…')]); await fc2.setFiles(OUT + '/bad.json'); await p2.waitForTimeout(400);
  assert.ok(/unknown model/.test(await p2.locator('.toast.err').innerText())); log('a broken catalog file is refused with a readable reason');
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
