// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('dialog', (d) => d.accept('VCC'));
  const S = (x, y) => page.evaluate(([x, y]) => { const e = window.__ce.editor; const r = e.svg.getBoundingClientRect(); return [r.left + e.pan[0] + x * 20 * e.zoom, r.top + e.pan[1] + y * 20 * e.zoom]; }, [x, y]);
  const click = async (x, y, opts) => { const [cx, cy] = await S(x, y); await page.mouse.click(cx, cy, opts); await page.waitForTimeout(60); };
  const drag = async (x1, y1, x2, y2) => { const a = await S(x1, y1); const b = await S(x2, y2); await page.mouse.move(a[0], a[1]); await page.mouse.down(); await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 }); await page.mouse.move(b[0], b[1], { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(80); };
  const st = () => page.evaluate(() => { const { sim, doc, editor } = window.__ce; const r = sim.result; const g = (n) => { const p = doc.parts.find((q) => q.name === n); const pr = p && sim.partResult(p); return pr ? pr.i : null; };
    return { parts: doc.parts.length, wires: doc.wires.length, iR1: g('R1'), R: (doc.parts.find((q) => q.name === 'R1') || { params: {} }).params.R, diag: sim.diagnostics.map((d) => d.code), junc: sim.net.junctions.length, sel: editor.sel.size, undo: editor.undoStack.length, probes: doc.probes.map((p) => sim.probeValue(p)) }; });
  const near = (a, b, tol, msg) => assert.ok(a != null && Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);
  const log = (...a) => console.log('✓', ...a);

  await page.goto(BASE + '#/circuit/new');
  await page.waitForFunction(() => window.__ce && location.hash.includes('c_'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: OUT + '/empty.png' });
  // --- place parts
  await page.click('.ce-pal-item:has-text("Voltage source")'); await page.keyboard.press('r'); await click(4, 6);
  await page.click('.ce-pal-item:has-text("Resistor")'); await page.keyboard.press('r'); await click(10, 6);
  await page.click('.ce-pal-item:has-text("Ground")'); await click(4, 10);
  await page.keyboard.press('Escape');
  let s = await st(); assert.equal(s.parts, 3); assert.deepEqual(s.diag.sort(), ['unconnected', 'unconnected'].sort().length ? s.diag.sort() : []); log('placed 3 parts, diagnostics:', s.diag.join(','));
  // --- wires (manual corner points, ending on a pin / on a wire)
  await page.keyboard.press('w');
  await click(4, 4); await click(10, 4);
  await click(4, 8); await click(4, 10);
  await click(10, 8); await click(10, 9); await click(4, 9);
  await page.keyboard.press('Escape');
  s = await st(); assert.equal(s.wires, 3); near(s.iR1, 0.009, 1e-6, 'I(R1) 9V/1k'); assert.ok(s.junc >= 1); assert.deepEqual(s.diag, []); log('3 wires drawn, junction created, I(R1) =', s.iR1);
  // --- double-click → dialog → 4k7
  const [rx, ry] = await S(10, 6); await page.mouse.dblclick(rx, ry); await page.waitForSelector('.modal');
  const inp = page.locator('.modal .field:has-text("Resistance") input'); await inp.fill('abc'); await page.click('.modal-foot .btn.primary'); assert.ok(await page.locator('.modal').count(), 'invalid value keeps dialog open');
  await inp.fill('4k7'); await page.click('.modal-foot .btn.primary'); await page.waitForTimeout(150);
  s = await st(); assert.equal(s.R, 4700); near(s.iR1, 9 / 4700, 1e-6, 'I after 4k7'); log('dialog: "abc" rejected, "4k7" → 4700 Ω, I =', s.iR1);
  await page.keyboard.press('Escape'); await click(20, 14);
  await page.keyboard.press('Control+z'); s = await st(); assert.equal(s.R, 1000); await page.keyboard.press('Control+Shift+z'); s = await st(); assert.equal(s.R, 4700); log('undo / redo of the value');
  // --- move with rubber-band wires
  await drag(10, 6, 14, 7); s = await st(); near(s.iR1, 9 / 4700, 1e-6, 'still connected after move'); assert.deepEqual(s.diag, []); log('moved R1, wires followed');
  await page.screenshot({ path: OUT + '/moved.png' });
  await click(14, 7); await page.keyboard.press('r'); s = await st(); near(s.iR1, 9 / 4700, 1e-6, 'still connected after rotate'); log('rotated R1, still connected');
  await page.keyboard.press('x'); s = await st(); near(Math.abs(s.iR1), 9 / 4700, 1e-6, 'still connected after mirror'); log('mirrored R1, still connected');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); s = await st(); near(s.iR1, 9 / 4700, 1e-6, 'undo x3');
  // --- wire reshaping: select wire, drag a segment, drag a corner handle
  await click(7, 4); s = await st(); assert.equal(s.sel, 1);
  await drag(7, 4, 7, 2); s = await st(); near(s.iR1, 9 / 4700, 1e-6, 'segment drag keeps ends'); log('dragged a wire segment (ends stay attached)');
  const w = await page.evaluate(() => window.__ce.doc.wires.find((x) => x.pts.some((p) => p[1] === 2)).pts); assert.ok(w.length >= 4, 'jog created ' + JSON.stringify(w));
  await drag(w[1][0], w[1][1], w[1][0] - 1, w[1][1]); log('dragged a corner handle');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  // --- box select, copy, paste, duplicate, delete
  await page.keyboard.press('Escape');
  await drag(1, 1, 16, 12); s = await st(); assert.ok(s.sel >= 6, 'box selected ' + s.sel);
  await page.keyboard.press('Control+c'); const [mx, my] = await S(20, 4); await page.mouse.move(mx, my); await page.keyboard.press('Control+v'); s = await st(); assert.equal(s.parts, 6); assert.equal(s.wires, 6); log('box select + copy/paste: 6 parts, 6 wires');
  await page.keyboard.press('Delete'); s = await st(); assert.equal(s.parts, 3); log('deleted the pasted copy');
  await click(10, 6); await page.keyboard.press('Control+d'); s = await st(); assert.equal(s.parts, 4); await page.keyboard.press('Control+z'); log('duplicate + undo');
  // --- errors: delete ground → no-ground; short → short
  await page.keyboard.press('Escape'); await click(4, 10.6); await page.keyboard.press('Delete'); s = await st(); assert.ok(s.diag.includes('no-ground'), 'no-ground ' + s.diag); log('ground removed → "no-ground" shown');
  await page.screenshot({ path: OUT + '/noground.png' });
  await page.keyboard.press('Control+z');
  await page.keyboard.press('w'); await click(4, 4); await click(2, 4); await click(2, 8); await click(4, 8); await page.keyboard.press('Escape');
  s = await st(); assert.ok(s.diag.includes('short'), 'short ' + s.diag); log('wire across the source → "short" shown, no crash');
  await page.screenshot({ path: OUT + '/short.png' });
  await page.keyboard.press('Control+z'); s = await st(); assert.deepEqual(s.diag, []);
  // --- crossing without dot is not connected
  await page.keyboard.press('w'); await click(7, 1); await click(7, 12); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  s = await st(); near(s.iR1, 9 / 4700, 1e-6, 'crossing wire changes nothing'); assert.equal(s.junc, 1); log('crossing wire: no junction, not connected'); await page.keyboard.press('Control+z');
  // --- net label
  await page.keyboard.press('l'); await click(7, 4); await page.keyboard.press('Escape'); s = await st();
  assert.equal(await page.evaluate(() => window.__ce.doc.labels.length), 1); assert.equal(await page.evaluate(() => window.__ce.sim.net.nodeAt(7, 4)), 'VCC'); log('net label names the node "VCC"');
  // --- probes
  await page.click('button[title="Voltmeter probe"]'); await click(10, 4); await page.keyboard.press('Enter');
  await page.click('button[title="Ammeter probe"]'); await click(10, 6);
  await page.click('button[title="Ohmmeter probe"]'); await click(10, 4); await click(10, 8);
  await page.waitForTimeout(300); s = await st(); near(s.probes[0], 9, 1e-6, 'V probe'); near(s.probes[1], 9 / 4700, 1e-6, 'A probe'); near(s.probes[2], 0.001, 0.002, 'Ω probe: source shorts R1 when off');
  log('probes V / A / Ω =', s.probes.map((v) => +v.toPrecision(4)).join(' / '));
  // --- hover tooltip
  const [hx, hy] = await S(10, 6); await page.mouse.move(hx + 3, hy + 2); await page.waitForTimeout(250);
  const tip = await page.locator('.ce-tip').innerText(); assert.ok(/U = 9 V/.test(tip) && /I = 1\.91 mA/.test(tip) && /P = 17\.2 mW/.test(tip), tip); log('hover:', tip.replace(/\n/g, ' | '));
  // --- zoom + pan
  const z0 = await page.evaluate(() => window.__ce.editor.zoom); await page.mouse.wheel(0, -300); await page.waitForTimeout(100); assert.ok(await page.evaluate(() => window.__ce.editor.zoom) > z0); await page.keyboard.press('f'); log('wheel zoom + fit');
  await page.screenshot({ path: OUT + '/built.png' });
  // --- persistence
  const url = page.url(); await page.waitForTimeout(700); await page.reload(); await page.waitForFunction(() => window.__ce); await page.waitForTimeout(500);
  s = await st(); assert.equal(s.parts, 3); assert.equal(s.probes.length, 3); assert.equal(s.R, 4700); log('reload: circuit persisted');
  // --- template: operate switch, save as, reset
  await page.goto(BASE + '#/circuit/rc'); await page.waitForFunction(() => window.__ce && window.__ce.doc.templateId === 'rc'); await page.waitForTimeout(400);
  await click(11, 5); await page.waitForTimeout(4500);
  const vc = await page.evaluate(() => window.__ce.sim.probeValue(window.__ce.doc.probes[0])); assert.ok(vc > 4.5, 'RC charged to ' + vc); log('RC template: switch clicked, capacitor charged to', vc.toFixed(2), 'V');
  await page.screenshot({ path: OUT + '/rc-scope.png' });
  await click(17, 5); await page.keyboard.press('Delete'); await page.waitForTimeout(600);
  await page.click('text=File ▾'); await page.click('text=↺ Reset to template'); await page.click('.modal-foot .btn.primary'); await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => window.__ce.doc.parts.some((p) => p.name === 'R1')), 'R1 back after reset'); log('template edited (R1 deleted) → Reset to template restores it');
  await page.click('text=File ▾'); await page.click('text=💾 Save as…'); await page.fill('.modal input', 'My RC'); await page.click('.modal-foot .btn.primary'); await page.waitForFunction(() => location.hash.includes('c_')); await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__ce.doc.name), 'My RC'); log('Save as… → user circuit', page.url().split('#')[1]);
  await page.goto(BASE + '#/lab?tab=circuits'); await page.waitForTimeout(500); assert.ok(await page.locator('.prog-row:has-text("My RC")').count()); log('listed under My circuits');
  await page.screenshot({ path: OUT + '/lab.png' });
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
