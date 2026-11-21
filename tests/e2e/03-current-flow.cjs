// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
const { chromium } = require('playwright');
const assert = require('assert');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message + (e.stack || '').split('\n').slice(0, 3).join(' ')));
  page.on('console', (m) => { if (m.type() === 'error' || /falls back/.test(m.text())) errs.push(m.text()); });
  const log = (...a) => console.log('✓', ...a);
  const open = async (id) => { await page.goto(BASE + '#/circuit/' + id); await page.waitForFunction((id) => window.__ce && window.__ce.doc.templateId === id, id); await page.waitForTimeout(500); };
  const setParam = (name, key, v) => page.evaluate(([name, key, v]) => { const { doc, editor } = window.__ce; doc.parts.find((p) => p.name === name).params[key] = v; editor.commit('test'); }, [name, key, v]);
  const count = async () => { await page.waitForTimeout(200); return page.evaluate(() => window.__ce.particles.count); };

  await open('led');
  assert.equal(await page.evaluate(() => window.__ce.particles.webgl), true); log('particles are drawn with WebGL point sprites (one draw call)');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ce-flow').length), 1);
  const cOn = await count(); assert.ok(cOn > 20, 'particles ' + cOn);
  await page.screenshot({ path: OUT + '/led-flow.png' });
  await setParam('S1', 'closed', false); const cOff = await count(); assert.equal(cOff, 0); log(`LED circuit: ${cOn} particles with current, ${cOff} with the switch open`);
  await setParam('S1', 'closed', true);
  // logarithmic scaling: µA and A both visible, more current = more particles
  const counts = [];
  for (const R of [9e6, 9e3, 90, 9]) { await page.evaluate(() => { window.__ce.sim.burnOut = false; }); await setParam('R1', 'R', R); await setParam('D1', 'Imax', 100); counts.push(await count()); }
  assert.ok(counts[0] > 0 && counts[0] < counts[1] && counts[1] < counts[2] && counts[2] < counts[3], counts.join()); log('particle count for ~0.8 µA / 0.8 mA / 75 mA / 0.6 A:', counts.join(' < '));
  // sensitivity slider hides small currents
  await setParam('R1', 'R', 9e6); await page.evaluate(() => { window.__ce.flow.sensitivity = 3; }); assert.equal(await count(), 0); await page.evaluate(() => { window.__ce.flow.sensitivity = 7; }); assert.ok(await count() > 0); log('sensitivity 1 mA hides the µA current, 100 nA shows it');
  await setParam('R1', 'R', 390); await setParam('D1', 'Imax', 0.03);
  // direction: conventional leaves V1+ (pin at 4,7 → upward); electron flow reversed
  const dirOf = () => page.evaluate(async () => {
    const g = window.__ce.flowGraph; const e = g.edges.find((x) => Math.abs(x.a.x - 4) < 0.01 && Math.abs(x.b.x - 4) < 0.01 && Math.max(x.a.y, x.b.y) <= 7.01);
    const pos = () => { const t = e.phase / e.len; return e.a.y + (e.b.y - e.a.y) * t; };
    const y0 = pos(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const y1 = pos(); return Math.sign(y1 - y0); });
  let d1 = 0; for (let k = 0; k < 6 && !d1; k++) d1 = await dirOf();
  await page.evaluate(() => { window.__ce.flow.electron = true; }); let d2 = 0; for (let k = 0; k < 6 && !d2; k++) d2 = await dirOf();
  assert.equal(d1, -1, 'conventional: up from +'); assert.equal(d2, 1, 'electron: reversed'); log('conventional current moves away from the + terminal; electron flow is reversed');
  await page.evaluate(() => { window.__ce.flow.electron = false; });
  // menu controls work
  await page.click('text=⚡ Flow ▾'); await page.locator('.flow-menu label:has-text("Colour wires by voltage") input').check(); await page.locator('.flow-menu label:has-text("Heat glow by power") input').check(); await page.mouse.click(700, 500); await page.waitForTimeout(400);
  const cols = await page.evaluate(() => [...document.querySelectorAll('.ce-wires polyline')].map((p) => p.style.stroke));
  assert.ok(cols.some((c) => /255, 59, 48/.test(c)) && cols.some((c) => /43, 108, 255/.test(c)), cols.join(' | ')); log('potential overlay: + rail red, ground blue');
  assert.ok(await page.evaluate(() => document.querySelectorAll('.ce-heat').length) >= 2); log('power overlay: heat glow on dissipating parts; legend:', (await page.locator('.ce-legend').innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: OUT + '/overlays.png' });
  // overload → red flash → burn-out → replace
  await page.evaluate(() => { window.__ce.sim.burnOut = true; }); await setParam('R1', 'R', 100); await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => document.querySelector('.ce-part[data-id="D1"]').classList.contains('overload'))); log('LED at 2.4× its limit flashes red');
  await page.screenshot({ path: OUT + '/overload.png' });
  await page.waitForFunction(() => window.__ce.sim.burned.has('D1'), null, { timeout: 6000 }); await page.waitForTimeout(300);
  const b = await page.evaluate(() => ({ cls: document.querySelector('.ce-part[data-id="D1"]').className.baseVal, i: window.__ce.sim.partResult(window.__ce.doc.parts.find((p) => p.name === 'R1')).i, diag: window.__ce.sim.diagnostics.map((d) => d.code), n: window.__ce.particles.count }));
  assert.ok(/burned/.test(b.cls) && Math.abs(b.i) < 1e-6 && b.diag.includes('burned') && b.n === 0, JSON.stringify(b)); log('…then burns out: open circuit, no particles, problem listed');
  await page.screenshot({ path: OUT + '/burned.png' });
  await setParam('R1', 'R', 390); await page.evaluate(() => window.__ce.editor.select(['D1'])); await page.click('text=Replace burned part'); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => !window.__ce.sim.burned.has('D1') && window.__ce.sim.partResult(window.__ce.doc.parts.find((p) => p.name === 'D1')).i > 0.01)); log('"Replace burned part" repairs it');
  // fuse
  // ---- performance: 200 parts
  await page.goto(BASE + '#/circuit/new'); await page.waitForFunction(() => window.__ce && location.hash.includes('c_')); await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const { doc, editor } = window.__ce; let n = 0; const id = (p) => p + (++n);
    const P = (type, x, y, rot, params) => doc.parts.push({ id: id('p'), type, name: type + n, x, y, rot, mirror: false, params });
    const W = (...pts) => doc.wires.push({ id: id('w'), pts });
    // 10 rows × (10 series R + 10 shunt LED/R branches) fed from one source = 200 parts + source
    P('V', -8, 30, 1, { V: 24, wave: 'dc', freq: 50, offset: 0, Imax: 50 }); doc.parts.push({ id: 'g', type: 'GND', name: '', x: -8, y: 64, rot: 0, mirror: false, params: {} });
    W([-8, 28], [-8, -2], [-4, -2], [-4, 56]); W([-8, 32], [-8, 64]); W([-6, 0], [-6, 62], [-8, 62]);
    for (let r = 0; r < 10; r++) {
      const y = r * 6;
      W([-4, y], [0, y]); W([62, y + 5.5], [-6, y + 5.5]);
      for (let c = 0; c < 10; c++) {
        const x = 2 + c * 6;
        P('R', x, y, 0, { R: 100 + 10 * c, Pmax: 5 }); W([x + 2, y], [x + 4, y]); W([x + 3, y], [x + 3, y + 1]);
        P(c % 2 ? 'R' : 'LED', x + 3, y + 3, 1, c % 2 ? { R: 2200, Pmax: 5 } : { model: 'red', Is: 0, n: 0, Irated: 0.02, Imax: 1 });
        W([x + 3, y + 5], [x + 3, y + 5.5]);
      }
    }
    editor.commit('bulk'); editor.fit();
    return { parts: doc.parts.length, wires: doc.wires.length, nodes: window.__ce.sim.circuit.nodeNames.length, ok: window.__ce.sim.result.ok, diag: window.__ce.sim.diagnostics.filter((d) => d.level === 'error').map((d) => d.code) };
  });
  assert.ok(info.parts >= 200 && info.ok, JSON.stringify(info));
  await page.evaluate(() => { window.__ce.stats.ms = 0; }); await page.waitForTimeout(3000);
  const perf = await page.evaluate(async () => { const f0 = window.__ce.stats.frames; const t0 = performance.now(); await new Promise((r) => setTimeout(r, 2000)); return { ms: window.__ce.stats.ms, fps: (window.__ce.stats.frames - f0) / ((performance.now() - t0) / 1000), particles: window.__ce.particles.count }; });
  log(`200-part circuit (${info.parts} parts, ${info.wires} wires, ${info.nodes} nodes): ${perf.ms.toFixed(2)} ms of work per frame, ${perf.particles} particles, ${perf.fps.toFixed(0)} fps in this headless software renderer`);
  assert.ok(perf.ms < 8, 'frame work ' + perf.ms); assert.ok(perf.particles > 500, 'particles ' + perf.particles);
  await page.screenshot({ path: OUT + '/200.png' });
  // dragging a part in the big circuit
  const t = await page.evaluate(() => { const { editor, doc } = window.__ce; const t0 = performance.now(); for (let k = 0; k < 20; k++) { doc.parts[5].x += 0.05; editor.renderAll(); } return (performance.now() - t0) / 20; });
  log(`full redraw of the 200-part schematic (as during a drag): ${t.toFixed(1)} ms`);
  console.log('errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
