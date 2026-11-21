// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
// Phase 4 end-to-end: embed → jump in → change → apply → back at the same place,
// plus undo/redo, unapplied marker, discard, new version, linked embeds, PLC scene, PDF export.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' ')));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const log = (...a) => console.log('✓', ...a);
  let lastView = null; // where the user was at the moment of jumping into the simulation
  const embeds = () => page.evaluate(() => Object.entries(window.__ed.ann.pages).flatMap(([pg, objs]) => objs.filter((o) => o.type === 'embed').map((o) => ({ pg: +pg, id: o.id, title: o.title, kind: o.kind, snapLen: o.snapshot.length, snapHash: o.snapshot.length + ':' + o.snapshot.slice(-60), table: o.table, R: o.kind === 'circuit' ? (o.state.parts.find((p) => p.name === 'R1') || { params: {} }).params.R : null, capacity: o.kind === 'plc' ? (o.state.elements.find((x) => x.type === 'tank') || { params: {} }).params.capacity : null, link: o.link, x: o.x, y: o.y, w: o.w, h: o.h }))));
  const view = () => page.evaluate(() => ({ zoom: window.__ed.st.zoom, top: window.__ed.scroller.scrollTop, left: window.__ed.scroller.scrollLeft, page: window.__ed.st.current, undo: window.__ed.undo.length, drafts: [...window.__ed.drafts] }));
  const waitEditor = async () => { await page.waitForFunction(() => window.__ed && document.querySelector('.ann-c')); await page.waitForTimeout(700); };
  const dblOn = async (o) => { await page.evaluate((o) => { const ed = window.__ed; const p = ed.pages[o.pg]; ed.scroller.scrollTop = Math.max(0, p.wrap.offsetTop + o.y * ed.st.zoom - 120); }, o); await page.waitForTimeout(350); lastView = await view(); const r = await page.evaluate((o) => { const p = window.__ed.pages[o.pg]; const b = p.wrap.getBoundingClientRect(); const z = window.__ed.st.zoom; return [b.left + (o.x + o.w / 2) * z, b.top + (o.y + o.h / 2) * z]; }, o); await page.mouse.dblclick(r[0], r[1]); };
  const insert = async (value, linked) => { await page.click('button[title^="Insert simulation"]'); await page.waitForSelector('.modal select'); await page.selectOption('.modal select', value); if (linked) await page.locator('.modal input[type=radio]').nth(1).check(); await page.click('.modal-foot .btn.primary'); await page.waitForSelector('.modal', { state: 'detached', timeout: 30000 }); await page.waitForTimeout(500); };
  const setR = async (text) => { const [x, y] = await page.evaluate(() => { const { editor, doc } = window.__ce; const p = doc.parts.find((q) => q.name === 'R1'); const r = editor.svg.getBoundingClientRect(); return [r.left + editor.pan[0] + p.x * 20 * editor.zoom, r.top + editor.pan[1] + p.y * 20 * editor.zoom]; }); await page.mouse.dblclick(x, y); await page.waitForSelector('.modal .field:has-text("Resistance") input'); await page.fill('.modal .field:has-text("Resistance") input', text); await page.click('.modal-foot .btn.primary'); await page.waitForTimeout(500); };
  const back = async (choice) => { await page.click('#embed-back'); if (choice) { await page.waitForSelector('.modal-foot'); await page.click(`.modal-foot button[data-value="${choice}"]`); } await waitEditor(); };
  const openEmbed = async (o) => { await page.keyboard.press('v'); await dblOn(o); await page.waitForFunction(() => location.hash.startsWith('#/circuit/embed') || location.hash.startsWith('#/plc/embed')); };

  // ---- set up: sample documents, open the two-page handout on page 2, zoomed and scrolled
  await page.goto(BASE + '#/library'); await page.waitForTimeout(600);
  await page.click('text=✨ Sample documents'); await page.waitForTimeout(5000);
  await page.click('.doc-card:has-text("Handout") >> text=Open'); await waitEditor();
  await page.keyboard.press('PageDown'); await page.keyboard.press('+'); await page.waitForTimeout(400);
  await page.evaluate(() => { window.__ed.scroller.scrollTop += 137; }); await page.waitForTimeout(300);

  // ---- 1. embed a circuit
  await insert('circuit:led', false);
  let e = await embeds(); assert.equal(e.length, 1); const A = e[0];
  assert.equal(A.pg, 1); assert.equal(A.R, 390); assert.ok(A.snapLen > 5000); assert.equal(A.table.length, 2); assert.ok(/18\.4 mA/.test(A.table[0].value), JSON.stringify(A.table));
  log(`embedded "${A.title}" on page ${A.pg + 1}: snapshot ${(A.snapLen / 1024).toFixed(0)} kB, table: ${A.table.map((r) => r.label + ' = ' + r.value).join(', ')}`);
  await page.keyboard.press('Escape'); await page.mouse.move(5, 5);
  await page.screenshot({ path: OUT + '/doc-embedded.png' });
  const v0 = await view();
  const docUrl = page.url().split('?')[0];

  // ---- 2. jump in, change the resistor, apply, come back
  const t0 = Date.now(); await openEmbed(A); await page.waitForFunction(() => window.__ce); const tJump = Date.now() - t0; await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__ce.doc.parts.find((p) => p.name === 'R1').params.R), 390);
  assert.ok(/Embedded in document/.test(await page.locator('.embed-banner').innerText()));
  await setR('1k');
  assert.ok(/unapplied changes/.test(await page.locator('.embed-banner').innerText())); log(`jumped into the simulation in ${tJump} ms (incl. zoom animation); changed R1 to 1 kΩ → banner "unapplied changes"`);
  await page.screenshot({ path: OUT + '/sim-embedded.png' });
  await back('apply');
  const v1 = await view(); e = await embeds(); const A2 = e[0];
  assert.equal(v1.zoom, lastView.zoom); assert.ok(Math.abs(v1.top - lastView.top) <= 1 && v1.left === lastView.left, `scroll ${v1.top} vs ${lastView.top}`); assert.equal(v1.page, lastView.page); assert.ok(v1.top > 500 && v1.page === 1);
  assert.equal(A2.R, 1000); assert.notEqual(A2.snapHash, A.snapHash); assert.ok(/7\.2\d mA/.test(A2.table[0].value), JSON.stringify(A2.table)); assert.equal(v1.drafts.length, 0);
  log(`applied and back: same page (${v1.page + 1}), zoom ${Math.round(v1.zoom * 100)} %, scroll ${v1.top}px; snapshot replaced, table now ${A2.table[0].label} = ${A2.table[0].value}`);
  await page.waitForTimeout(400); await page.screenshot({ path: OUT + '/doc-applied.png' });

  // ---- 3. undo / redo of the apply
  assert.ok(v1.undo >= 2);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300); e = await embeds(); assert.equal(e[0].R, 390); assert.equal(e[0].snapHash, A.snapHash); assert.ok(/18\.4 mA/.test(e[0].table[0].value));
  await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(300); e = await embeds(); assert.equal(e[0].R, 1000); assert.equal(e[0].snapHash, A2.snapHash);
  log('undo in the document restores the old snapshot, table and simulation; redo re-applies');

  // ---- 4. the template itself is untouched
  await page.waitForTimeout(600);
  await page.goto(BASE + '#/circuit/led'); await page.waitForFunction(() => window.__ce && window.__ce.doc.templateId === 'led');
  assert.equal(await page.evaluate(() => window.__ce.doc.parts.find((p) => p.name === 'R1').params.R), 390); log('the LED template still has 390 Ω: the embed is its own instance');
  await page.goBack(); await waitEditor();

  // ---- 5. unapplied marker: leave without the back button, then discard
  e = await embeds();  await openEmbed(e[0]); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(400);
  await setR('2k'); await page.waitForTimeout(500);
  await page.goto(BASE + '#/library'); await page.waitForTimeout(400); await page.goto(docUrl); await waitEditor();
  let v = await view(); assert.equal(v.drafts.length, 1); e = await embeds(); assert.equal(e[0].R, 1000);
  await page.screenshot({ path: OUT + '/doc-marker.png' }); log('left the simulation without applying → the object carries the "unapplied changes" marker, document unchanged');
  await openEmbed(e[0]); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__ce.doc.parts.find((p) => p.name === 'R1').params.R), 2000); log('reopening continues with the draft (2 kΩ)');
  await back('discard'); v = await view(); e = await embeds(); assert.equal(v.drafts.length, 0); assert.equal(e[0].R, 1000); log('"Discard" drops the draft; marker gone');

  // ---- 6. save as new version
  await openEmbed(e[0]); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(400);
  await setR('220'); await back('new-version'); e = await embeds();
  assert.equal(e.length, 2); assert.equal(e[0].R, 1000); assert.equal(e[1].R, 220); assert.ok(/\(v\d+\)/.test(e[1].title)); log(`"Save as new version": the original stays at 1 kΩ, new object "${e[1].title}" has 220 Ω`);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(300); assert.equal((await embeds()).length, 1); await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(300);

  // ---- 7. linked embeds: two objects share one simulation
  await page.keyboard.press('PageUp'); await page.waitForTimeout(300);
  await insert('circuit:divider', true); await page.keyboard.press('Escape');
  await page.keyboard.press('PageDown'); await page.waitForTimeout(300);
  await insert('circuit:divider', true); await page.keyboard.press('Escape');
  e = (await embeds()).filter((o) => o.link); assert.equal(e.length, 2); assert.deepEqual(e[0].link, e[1].link);
  await openEmbed(e[1]); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(400);
  await setR('3k3'); await back('apply');
  e = (await embeds()).filter((o) => o.link); assert.equal(e[0].R, 3300); assert.equal(e[1].R, 3300); assert.equal(e[0].snapHash, e[1].snapHash); assert.deepEqual(e[0].table, e[1].table);
  await page.waitForTimeout(500);
  const tpl = await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('outofshape-lab'); q.onsuccess = () => { const t = q.result.transaction('circuits').objectStore('circuits').get('tpl_divider'); t.onsuccess = () => r(t.result.parts.find((p) => p.name === 'R1').params.R); }; }));
  assert.equal(tpl, 3300); log('linked: applying in one place updated the other embed (page 1) and the original circuit (3.3 kΩ everywhere)');

  // ---- 8. PLC scene
  await insert('plc:tank', false); await page.keyboard.press('Escape');
  e = await embeds(); const P = e.find((o) => o.kind === 'plc'); assert.ok(P && P.snapLen > 20000 && P.table.length >= 3); log(`embedded PLC scene "${P.title}": 3D snapshot ${(P.snapLen / 1024).toFixed(0)} kB, table: ${P.table.map((r) => r.label + ' = ' + r.value).join('; ')}`);
  await page.screenshot({ path: OUT + '/doc-plc.png' });
  const pickTank = async () => { await page.evaluate(() => { const k = window.__kit; k.stage.setMode('build'); k.stage.select([k.doc.elements.find((x) => x.type === 'tank').id]); }); await page.click('.tabs .tab:has-text("Element")'); await page.waitForTimeout(150); return page.locator('.tab-body .field:has-text("Capacity") input'); };
  await openEmbed(P); await page.waitForFunction(() => window.__kit); await page.waitForTimeout(1500);
  assert.ok(/Embedded in document/.test(await page.locator('.embed-banner').innerText()));
  let cap = await pickTank(); assert.equal(await cap.inputValue(), '1000'); await cap.fill('2500'); await cap.dispatchEvent('change'); await page.waitForTimeout(600);
  assert.ok(/unapplied/.test(await page.locator('.embed-banner').innerText()));
  await back('apply'); e = await embeds(); const P2 = e.find((o) => o.kind === 'plc');
  assert.equal(P2.capacity, 2500); assert.notEqual(P2.snapHash, P.snapHash); log('PLC plant: opened from the document as an editable kit plant, tank capacity changed to 2500 L, applied → object updated');
  // reopen: state is what was applied
  await openEmbed(P2); await page.waitForFunction(() => window.__kit); await page.waitForTimeout(800);
  cap = await pickTank(); assert.equal(await cap.inputValue(), '2500'); await back(null); log('reopening the plant starts with the applied state; leaving unchanged needs no dialog');
  // the template itself is untouched by the embedded copy
  assert.equal(await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('outofshape-lab'); q.onsuccess = () => { const t = q.result.transaction('scenes').objectStore('scenes').get('tpl_tank'); t.onsuccess = () => r(t.result ? 'changed' : 'untouched'); }; })), 'untouched');
  log('own copy: the tank template in the lab is untouched');

  // ---- 9. PDF export: snapshot as image, table as text
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Export PDF')]);
  await dl.saveAs(OUT + '/embedded.pdf');
  const text = execFileSync('pdftotext', ['-raw', OUT + '/embedded.pdf', '-'], { encoding: 'utf8' });
  assert.ok(/Circuit: LED with Series Resistor/.test(text) && /LED current/.test(text) && /7\.2\d mA/.test(text) && /PLC scene: Tank Level Control/.test(text), text.slice(0, 600));
  const imgs = execFileSync('pdfimages', ['-list', OUT + '/embedded.pdf'], { encoding: 'utf8' }).trim().split('\n').length - 2;
  assert.ok(imgs >= 4, 'images ' + imgs); execFileSync('pdftoppm', ['-r', '70', '-png', '-f', '2', '-l', '2', OUT + '/embedded.pdf', OUT + '/pdf']);
  log(`exported PDF: ${imgs} snapshot images, titles and value tables are real text ("LED current … mA" found by pdftotext)`);

  // ---- 10. everything survives a reload
  await page.waitForTimeout(700); await page.reload(); await waitEditor(); e = await embeds(); assert.equal(e.length, 5); log('after reload: all 5 embedded objects are still in the document');
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message.slice(0, 900)); process.exit(1); });
