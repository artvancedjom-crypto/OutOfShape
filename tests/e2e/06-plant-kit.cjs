// End-to-end test, driven by Playwright against a running dev server.
// Run all of them with:  npm run test:e2e   (see tests/e2e/README.md)
const BASE = process.env.E2E_BASE || 'http://localhost:5173/';
const OUT = process.env.E2E_OUT || require('path').join(__dirname, 'out');
require('fs').mkdirSync(OUT, { recursive: true });
// Phase 5 end-to-end: build a plant from the kit in the 3D view (button → motor,
// light barrier → counter), check the automatic addresses, run the logic, operate
// it in the scene, then edit the I/O map, inject faults, force, watch/trace,
// groups, own element types, templates and persistence.
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message + ' ' + (e.stack || '').split('\n').slice(0, 3).join(' ')));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  const log = (...a) => console.log('✓', ...a);
  const wait = (ms) => page.waitForTimeout(ms);
  const K = (fn, arg) => page.evaluate(fn, arg);
  /** Screen position of a point in the 3D scene. */
  const scr = (x, z, y = 0) => K(([x, y, z]) => { const s = window.__kit.stage; const c = s.world.camera; c.updateMatrixWorld(); const v = c.position.clone().set(x, y, z).project(c); const r = s.world.renderer.domElement.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }, [x, y, z]);
  /** Point on the baseplate under a screen position. */
  const ground = (sx, sy) => K(([sx, sy]) => { const p = window.__kit.stage._groundPoint({ clientX: sx, clientY: sy }); return [p.x, p.z]; }, [sx, sy]);
  const els = () => K(() => window.__kit.doc.elements.map((e) => ({ name: e.name, type: e.type, x: e.x, z: e.z, y: e.y || 0, rot: e.rot || 0 })));
  const el = async (name) => (await els()).find((e) => e.name === name);
  const io = () => K(() => { const o = {}; for (const e of window.__kit.doc.elements) for (const k of Object.keys(e.io || {})) o[e.io[k].tag] = e.io[k].addr; return o; });
  const place = async (type, x, z, { rot = 0, y = 0 } = {}) => {
    await page.click(`.ce-pal-item[data-type="${type}"]`);
    const [sx, sy] = await scr(x, z, y);
    await page.mouse.move(sx - 30, sy - 20); await page.mouse.move(sx, sy, { steps: 3 });
    for (let i = 0; i < rot; i++) await page.keyboard.press('r');
    await page.mouse.move(sx + 1, sy); await wait(60);
    await page.mouse.click(sx, sy); await wait(80);
    await page.keyboard.press('Escape'); await wait(60);
  };
  const clickEl = async (name, opts) => { const e = await el(name); const h = await K((n) => { const d = window.__kit.doc.elements.find((x) => x.name === n); return window.__kit.stage.height(d); }, name); const [sx, sy] = await scr(e.x, e.z, e.y + h * 0.6); if (opts && opts.shift) await page.keyboard.down('Shift'); await page.mouse.click(sx, sy); if (opts && opts.shift) await page.keyboard.up('Shift'); await wait(120); };
  const tab = async (t) => { await page.click(`.tabs .tab:has-text("${t}")`); await wait(120); };
  const answer = async (text) => { await page.waitForSelector('.modal-back .input'); await page.fill('.modal-back .input', text); await page.keyboard.press('Enter'); await wait(250); };
  const sim = (name) => K((n) => { const k = window.__kit; const e = k.doc.elements.find((x) => x.name === n); return JSON.parse(JSON.stringify(k.sim.st[e.id])); }, name);
  const out = (t) => K((t) => window.__kit.rt.getOutput(t), t);

  // ---- a new, empty plant ---------------------------------------------------------------
  await page.goto(BASE + '#/plc/new');
  await page.waitForFunction(() => window.__kit && location.hash.startsWith('#/plc/s_'));
  await wait(600);
  assert.equal((await els()).length, 0);
  const cats = (await page.locator('.kit-palette .menu-h').allInnerTexts()).map((s) => s.toUpperCase());
  for (const c of ['ACTUATORS', 'SENSORS', 'OPERATING', 'MATERIAL FLOW']) assert.ok(cats.includes(c), 'palette category ' + c + ' in ' + cats);
  const nItems = await page.locator('.kit-palette .ce-pal-item').count();
  assert.ok(nItems >= 40, 'palette items ' + nItems);
  log(`new empty plant; palette has ${nItems} elements in: ${cats.join(', ')}`);

  // ---- build: button → motor, light barrier → counter -------------------------------------
  // zoom out with the mouse wheel so the whole working area is in view
  { const r = await page.locator('.viewport canvas').boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 240); await wait(60); } await wait(500); }
  await place('button', -8.5, 5.5);
  await place('button', -6.5, 5.5);
  await place('motor', -8.5, -6.5);
  await place('spawner', -4, 0);
  await place('conveyor', 0, 0);
  await place('lightbarrier', 0.5, -1.5, { rot: 1 });
  await place('sink', 4.5, 0);
  let list = await els();
  assert.deepEqual(list.map((e) => e.name), ['Btn1', 'Btn2', 'Mot1', 'Src1', 'Conv1', 'LB1', 'Bin1']);
  assert.deepEqual([list[4].x, list[4].z, list[5].x, list[5].z, list[5].rot], [0, 0, 0.5, -1.5, 1], JSON.stringify(list));
  assert.deepEqual(await io(), { Btn1: '%I0.0', Btn2: '%I0.1', Mot1_OK: '%I0.2', LB1: '%I0.3', Mot1_Run: '%Q0.0', Conv1_Run: '%Q0.1' });
  log('placed 7 elements by clicking on the baseplate; addresses assigned automatically:', JSON.stringify(await io()));

  // a spot that is taken is refused
  await page.click('.ce-pal-item[data-type="lamp"]');
  { const [sx, sy] = await scr(0, 0, 0); await page.mouse.move(sx, sy, { steps: 3 }); await page.mouse.click(sx, sy); await wait(100); }
  assert.equal((await els()).length, 7, 'nothing placed on the conveyor');
  await page.keyboard.press('Escape');
  log('placing on an occupied spot is refused');

  // stop button is normally closed: set in the inspector
  await clickEl('Btn2');
  await tab('Element');
  assert.ok(/Push button/.test(await page.locator('.tab-body').innerText()));
  await page.locator('.tab-body .field:has-text("Contact") select').selectOption('NC');
  await page.locator('.tab-body .field:has-text("Colour") select, .tab-body .field:has-text("Color") select').first().selectOption('red');
  assert.equal(await K(() => window.__kit.doc.elements[1].params.contact), 'NC');
  // faster parts
  await clickEl('Src1');
  const cyc = page.locator('.tab-body .field:has-text("Cycle") input');
  await cyc.fill('0'); await cyc.dispatchEvent('change');
  assert.ok(/Between/.test(await page.locator('.tab-body').innerText()), 'range validation');
  await cyc.fill('2'); await cyc.dispatchEvent('change');
  assert.equal(await K(() => window.__kit.doc.elements[3].params.cycle), 2);
  log('inspector: parameters edited with validation (0 s cycle refused, 2 s accepted)');

  // ---- program: the new tags are known ------------------------------------------------------
  await tab('Program');
  const tags = await page.locator('.tag-cloud code').allTextContents();
  assert.deepEqual(tags.sort(), ['Btn1', 'Btn2', 'Conv1_Run', 'LB1', 'Mot1_OK', 'Mot1_Run']);
  await page.fill('.code-editor textarea', `VAR Count : CTU; Parts : INT; END_VAR
Mot1_Run := (Btn1 OR Mot1_Run) AND Btn2 AND Mot1_OK;
Conv1_Run := Mot1_Run;
Count(CU := LB1, R := FALSE, PV := 100);
Parts := Count.CV;`);
  await page.click('text=⬇ Download & run'); await wait(400);
  assert.equal(await page.locator('#cpu-state').innerText(), 'RUN', (await page.locator('.console').innerText()).slice(0, 300));
  assert.equal(await out('Mot1_Run'), false);
  log('ST program using the new tags compiles and runs');

  // ---- operate in the scene -------------------------------------------------------------------
  await page.click('button:has-text("Operate")');
  await wait(1200);
  assert.ok((await sim('Mot1')).speed < 0.01 && (await sim('Conv1')).v === 0, 'everything stands before start');
  await clickEl('Btn1');
  await wait(1500);
  assert.equal(await out('Mot1_Run'), true, 'motor latched');
  assert.ok((await sim('Mot1')).speed > 0.5, 'motor spins in the scene');
  assert.ok((await sim('Conv1')).v > 2.5, 'belt runs');
  log('clicking the start button in the 3D scene latches the motor: motor spins, belt runs');
  await tab('Watch');
  await page.locator('.watch-pane select').first().selectOption('Parts');
  await page.locator('.watch-pane select').first().selectOption('LB1');
  await page.locator('.watch-pane select').first().selectOption('Mot1_Run');
  await page.selectOption('.toolbar select', '4');
  await page.waitForFunction(() => window.__kit.rt.get('Parts') >= 3, null, { timeout: 30000 });
  const made = (await sim('Src1')).made; const parts = await K(() => window.__kit.rt.get('Parts'));
  assert.ok(parts <= made && parts >= made - 3, `made ${made}, counted ${parts}`);
  const wt = await page.locator('.watch-pane .io-table').innerText();
  assert.ok(/Parts\s+\d+/.test(wt) && /Mot1_Run\s+TRUE/.test(wt), wt);
  const ink = await K(() => { const c = document.querySelector('canvas.trace'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 300) n++; return n; });
  assert.ok(ink > 400, 'trace drawn: ' + ink);
  const samples = await K(() => window.__kit.watch.samples.length);
  assert.ok(samples > 20, 'trace samples ' + samples);
  await page.screenshot({ path: OUT + '/kit-running.png' });
  log(`light barrier → CTU counter: ${made} workpieces made, ${parts} counted; watch table shows live values, trace recorded ${samples} samples`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ CSV')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(csv.startsWith('time_s;Parts;LB1;Mot1_Run') && csv.split('\n').length > 20, csv.slice(0, 80));
  log('trace exported as CSV');

  // stop button (NC)
  await clickEl('Btn2'); await wait(500);
  assert.equal(await out('Mot1_Run'), false, 'stopped');
  log('clicking the NC stop button stops motor and belt');

  // ---- forcing ---------------------------------------------------------------------------------
  await tab('I/O map');
  const row = (tag) => page.locator(`.kit-io-table tbody tr:has(input.tag[value="${tag}"])`);
  await row('Mot1_Run').locator('.force').click(); await wait(400);
  assert.equal(await out('Mot1_Run'), true);
  assert.ok((await row('Mot1_Run').getAttribute('class')).includes('forced'));
  assert.ok(await page.locator('#forced-badge').isVisible(), 'FORCED badge in the toolbar');
  assert.ok((await sim('Mot1')).target !== 0 || (await sim('Mot1')).speed > 0, 'forced output drives the motor');
  await row('Mot1_Run').locator('.force').click(); await row('Mot1_Run').locator('.force').click(); await wait(300);
  assert.ok(!(await page.locator('#forced-badge').isVisible()));
  assert.equal(await out('Mot1_Run'), false);
  log('forcing an output: row and toolbar are marked FORCED, the motor follows, force removed again');

  // ---- fault injection ----------------------------------------------------------------------------
  await page.click('button:has-text("Operate")'); await clickEl('Btn1'); await wait(400);
  await page.click('button:has-text("Build")');
  await clickEl('LB1'); await tab('Element');
  const faultSel = page.locator('.tab-body .field:has-text("Sensor fault") select');
  const faults = await faultSel.locator('option').allInnerTexts();
  assert.ok(faults.length >= 4, faults.join('|'));
  await faultSel.selectOption('stuck0'); await wait(400);
  const before = await K(() => window.__kit.rt.get('Parts')); const bin0 = (await sim('Bin1')).n;
  await wait(4000);
  const during = await K(() => window.__kit.rt.get('Parts'));
  assert.equal(during, before, `counter must freeze with the sensor stuck at 0 (${before} → ${during})`);
  assert.ok((await sim('Bin1')).n > bin0, 'parts keep arriving in the bin');
  await faultSel.selectOption(''); await wait(2500);
  assert.ok(await K(() => window.__kit.rt.get('Parts')) > during, 'counts again after the fault is cleared');
  await clickEl('Mot1');
  const aFault = page.locator('.tab-body .field:has-text("Actuator fault") select');
  assert.ok((await sim('Mot1')).speed > 0.9 && await out('Mot1_Run') === true, 'motor runs before the fault');
  await aFault.selectOption('jam');
  await page.waitForFunction(() => { const k = window.__kit; const e = k.doc.elements.find((x) => x.name === 'Mot1'); return k.sim.st[e.id].tripped; }, null, { timeout: 20000 });
  await wait(1500);
  const jam = await sim('Mot1');
  assert.ok(jam.speed < 0.05, 'the jammed motor stands: ' + jam.speed);
  assert.equal(await K(() => window.__kit.rt.effectiveInput('Mot1_OK')), false, 'thermal contact opened');
  assert.equal(await out('Mot1_Run'), false, 'the program drops the contactor when Mot1_OK goes away');
  await aFault.selectOption(''); await wait(300);
  log(`fault injection: sensor stuck at 0 freezes the counter (${before} → ${during}) while parts keep arriving; a jammed motor stalls, overheats, its thermal contact opens and the program switches it off; faults: ${faults.join(' / ')}`);
  await page.selectOption('.toolbar select', '1');

  // ---- I/O map: rename a tag, move an address ---------------------------------------------------------
  await tab('I/O map');
  const t = row('LB1').locator('input.tag');
  await t.fill('Btn1'); await t.dispatchEvent('change');
  assert.ok(/already|used/i.test(await row('LB1').innerText()), 'duplicate tag refused: ' + await row('LB1').innerText());
  await page.locator('.kit-io-table input.tag.bad').fill('PE_Count'); await page.locator('.kit-io-table input.tag.bad').dispatchEvent('change'); await wait(200);
  assert.equal((await io()).PE_Count, '%I0.3');
  assert.ok(/CU := PE_Count/.test(await K(() => window.__kit.doc.program.source)), 'program follows the rename');
  assert.equal(await page.locator('#cpu-state').innerText(), 'RUN', 'still running after the rename');
  const a = row('PE_Count').locator('input.addr');
  await a.fill('%I0.0'); await a.dispatchEvent('change');
  assert.ok(/used|taken|already/i.test(await row('PE_Count').innerText()), 'address clash refused');
  await page.locator('.kit-io-table input.addr.bad').fill('%Q1.0'); await page.locator('.kit-io-table input.addr.bad').dispatchEvent('change');
  assert.ok(/input|%I/i.test(await page.locator('.kit-io-table tr:has(input.addr.bad)').innerText()), 'an input cannot sit on an output address');
  await page.locator('.kit-io-table input.addr.bad').fill('%I2.5'); await page.locator('.kit-io-table input.addr.bad').dispatchEvent('change'); await wait(200);
  assert.equal((await io()).PE_Count, '%I2.5');
  await page.keyboard.press('Control+z'); await wait(200);
  assert.equal((await io()).PE_Count, '%I0.3', 'undo of the address change');
  await page.keyboard.press('Control+z'); await wait(200);
  assert.equal((await io()).LB1, '%I0.3'); assert.ok(/CU := LB1/.test(await K(() => window.__kit.doc.program.source)), 'undo of the rename restores the program');
  await page.keyboard.press('Control+Shift+z'); await wait(200);
  assert.equal((await io()).PE_Count, '%I0.3');
  log('I/O map: duplicate tag and clashing/wrong-area address refused; rename updates the program; address moved to %I2.5; undo/redo');

  // ---- move, rotate, stack, duplicate, delete, undo ------------------------------------------------------
  await page.click('button:has-text("Stop")');
  const m0 = await el('Mot1');
  { const [x0, y0] = await scr(m0.x, m0.z, 1.5); const g = await ground(x0, y0); const [x1, y1] = await scr(g[0] + 4, g[1], 0);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); await wait(150); }
  const m1 = await el('Mot1');
  assert.ok(m1.x === m0.x + 4 && m1.z === m0.z, `moved ${JSON.stringify(m0)} → ${JSON.stringify(m1)}`);
  await page.keyboard.press('Control+z'); await wait(150);
  assert.deepEqual(await el('Mot1'), m0, 'undo of the move');
  await page.keyboard.press('Control+y'); await wait(150);
  assert.deepEqual(await el('Mot1'), m1, 'redo of the move');
  // drag onto another element is refused
  { const b = await el('Btn1'); const [x0, y0] = await scr(m1.x, m1.z, 1.5); const g = await ground(x0, y0); const [x1, y1] = await scr(g[0] + b.x - m1.x, g[1] + b.z - m1.z, 0);
    await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up(); await wait(150); }
  assert.deepEqual(await el('Mot1'), m1, 'a move onto an occupied spot snaps back');
  await clickEl('LB1'); await page.keyboard.press('r'); await wait(100);
  assert.equal((await el('LB1')).rot, 2);
  await page.keyboard.press('Control+z'); assert.equal((await el('LB1')).rot, 1);
  log('drag to move (snaps to studs), move onto another element refused, rotate with R, undo/redo');

  await place('brick', 8, 6);
  const b1 = await el('Brick1');
  const bh = await K(() => { const d = window.__kit.doc.elements.find((x) => x.name === 'Brick1'); return window.__kit.stage.height(d); });
  await place('brick', b1.x, b1.z, { y: bh });
  const b2 = await el('Brick2');
  assert.ok(b2 && b2.x === b1.x && b2.z === b1.z && Math.abs(b2.y - bh) < 1e-6, 'brick stacked on brick: ' + JSON.stringify(b2));
  await place('lamp', b1.x - 0.5, b1.z - 0.5, { y: bh * 2 });
  const l1 = await el('Lamp1');
  assert.ok(l1 && Math.abs(l1.y - bh * 2) < 1e-6, 'lamp on top of the tower: ' + JSON.stringify(l1));
  assert.equal((await io()).Lamp1, '%Q0.2');
  log(`stacking: brick on brick (y = ${b2.y}), lamp on the tower (y = ${l1.y}) gets %Q0.2`);

  await clickEl('Lamp1'); await page.keyboard.press('Control+d'); await wait(150);
  assert.equal((await io()).Lamp2, '%Q0.3', 'duplicate gets its own address');
  await page.keyboard.press('Delete'); await wait(150);
  assert.ok(!(await el('Lamp2')) && !('Lamp2' in await io()));
  await page.keyboard.press('Control+z'); assert.ok(await el('Lamp2'));
  await page.keyboard.press('Control+y'); assert.ok(!(await el('Lamp2')));
  log('duplicate (Ctrl+D) gets the next free address, delete frees it, undo/redo');

  // ---- cables to the PLC rack --------------------------------------------------------------------------
  await page.click('button:has-text("View")'); await page.click('.menu button:has-text("Cables")'); await wait(200);
  const wires = await K(() => window.__kit.stage.wiring.children.length);
  assert.ok(wires >= 7, 'one cable per signal: ' + wires);
  await page.screenshot({ path: OUT + '/kit-wiring.png' });
  log(`cables to the PLC rack shown: ${wires} for 7 signals`);
  await page.click('button:has-text("View")'); await page.click('.menu button:has-text("Cables")');

  // ---- group -----------------------------------------------------------------------------------------------
  await clickEl('Brick2'); await clickEl('Lamp1', { shift: true });
  { const e = await el('Brick1'); const [sx, sy] = await scr(e.x + 0.9, e.z + 1.9, bh * 0.5); await page.keyboard.down('Shift'); await page.mouse.click(sx, sy); await page.keyboard.up('Shift'); await wait(100); }
  assert.equal(await K(() => window.__kit.stage.sel.size), 3);
  await tab('Element');
  await page.click('text=Save as group…'); await answer('Signal tower');
  assert.ok(await page.locator('.ce-pal-item[data-group]:has-text("Signal tower")').count() === 1, 'group in the palette');
  await page.click('.ce-pal-item[data-group]:has-text("Signal tower")');
  { const [sx, sy] = await scr(8, -6); await page.mouse.move(sx - 20, sy); await page.mouse.move(sx, sy, { steps: 3 }); await page.mouse.click(sx, sy); await wait(150); await page.keyboard.press('Escape'); }
  list = await els();
  assert.equal(list.filter((e) => e.type === 'brick').length, 4); assert.equal(list.filter((e) => e.type === 'lamp').length, 2);
  const l3 = list.filter((e) => e.type === 'lamp')[1];
  assert.ok(Math.abs(l3.y - bh * 2) < 1e-6, 'the group keeps its stacking');
  assert.ok(Object.values(await io()).filter((v) => v === '%Q0.3').length === 1, 'the group lamp gets the next free output');
  log('three selected elements saved as group “Signal tower”; placed again from the palette with stacking and a fresh address');

  // ---- own element type ----------------------------------------------------------------------------------------
  await page.click('text=🧩 My elements…'); await page.click('text=＋ New element type…');
  await page.waitForSelector('.kit-variant');
  await page.locator('.kit-variant select').first().selectOption('leveltx'); await page.waitForTimeout(200);
  await page.locator('.kit-variant label:has-text("Name") input').first().fill('Radar level 0-10 V');
  await page.locator('.kit-variant label:has-text("Tag prefix") input').fill('LR');
  await page.locator('.kit-variant .field[data-key="signal"] select').selectOption('0-10 V');
  const noise = page.locator('.kit-variant .field[data-key="noise"] input');
  await noise.fill('999'); await page.click('.modal-foot .btn.primary'); await wait(150);
  assert.ok(await page.locator('.kit-variant').isVisible(), 'invalid parameter blocks saving');
  await noise.fill('0');
  await page.locator('.kit-variant input[type=checkbox]').last().check();
  await page.locator('.kit-variant .row.gap select').nth(0).selectOption('cylinder');
  await page.locator('.kit-variant .row.gap select').nth(1).selectOption('purple');
  await page.click('.modal-foot .btn.primary'); await wait(300);
  const mine = page.locator('.ce-pal-item:has-text("Radar level 0-10 V")');
  assert.equal(await mine.count(), 1, 'own type in the palette');
  const vtype = await mine.getAttribute('data-type');
  await place(vtype, -8.5, 0.5);
  assert.equal((await io()).LR1, '%IW64', JSON.stringify(await io()));
  assert.equal(await K(() => window.__kit.doc.elements.find((e) => e.name === 'LR1').params.signal), '0-10 V');
  log('own element type “Radar level 0-10 V” (behaviour: analog level transmitter, own look) created with validation, placed → LR1 at %IW64');

  // export / import of my kit elements
  await page.click('text=🧩 My elements…');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=⬇ Export all')]);
  const kitJson = fs.readFileSync(await dl2.path(), 'utf8');
  const parsed = JSON.parse(kitJson);
  assert.ok(JSON.stringify(parsed).includes('Signal tower') && JSON.stringify(parsed).includes('Radar level'), kitJson.slice(0, 200));
  await page.locator('.modal-head .icon-btn').click();
  log('my kit elements exported as catalog JSON (group + element type)');

  // ---- persistence + save as ---------------------------------------------------------------------------------------
  await page.locator('.doc-name').fill('Counting line'); await page.locator('.doc-name').dispatchEvent('change');
  const n = (await els()).length;
  await wait(900);
  const url = page.url();
  await page.reload(); await page.waitForFunction(() => window.__kit && window.__kit.doc.name === 'Counting line'); await wait(500);
  assert.equal((await els()).length, n, 'plant restored after reload');
  assert.equal((await io()).PE_Count, '%I0.3'); assert.equal((await io()).LR1, '%IW64');
  assert.equal(await page.locator('.ce-pal-item:has-text("Radar level 0-10 V")').count(), 1, 'own type restored');
  assert.equal(await page.locator('#cpu-state').innerText(), 'RUN');
  log(`after a reload: ${n} elements, edited tags, program and own element type are back`);
  await page.goto(BASE + '#/lab'); await page.waitForSelector('text=Counting line');
  log('the plant is listed in the lab under its name');

  // import the kit JSON into a fresh profile
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errs.push('PAGEERROR(2) ' + e.message));
  await p2.goto(BASE + '#/plc/new'); await p2.waitForFunction(() => window.__kit && location.hash.startsWith('#/plc/s_')); await p2.waitForTimeout(400);
  assert.equal(await p2.locator('.ce-pal-item:has-text("Radar level 0-10 V")').count(), 0);
  await p2.click('text=🧩 My elements…');
  const [fc] = await Promise.all([p2.waitForEvent('filechooser'), p2.click('text=⬆ Import JSON…')]);
  await fc.setFiles({ name: 'kit.catalog.json', mimeType: 'application/json', buffer: Buffer.from(kitJson) });
  await p2.waitForSelector('.ce-pal-item:has-text("Radar level 0-10 V")');
  assert.equal(await p2.locator('.ce-pal-item[data-group]:has-text("Signal tower")').count(), 1);
  await ctx2.close();
  log('catalog JSON imported in a fresh browser profile: group and element type appear in the palette');

  // ---- templates are editable and can be reset ---------------------------------------------------------------------------
  await page.goto(BASE + '#/plc/tank'); await page.waitForFunction(() => window.__kit && window.__kit.doc.name.includes('Tank')); await wait(800);
  assert.equal(await page.locator('.badge').first().innerText(), 'Template');
  const n0 = (await els()).length;
  assert.equal(await page.locator('#cpu-state').innerText(), 'RUN');
  await page.selectOption('.toolbar select', '4');
  await page.waitForFunction(() => { const k = window.__kit; const e = k.doc.elements.find((x) => x.type === 'tank'); return k.sim.st[e.id].vol > e.params.capacity * 0.5; }, null, { timeout: 40000 });
  log('tank template runs as a kit plant: the pump fills the tank through the pipes');
  await page.selectOption('.toolbar select', '1');
  await page.click('button:has-text("Build")');
  { const r = await page.locator('.viewport canvas').boundingBox(); await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 240); await wait(60); } await wait(500); }
  await place('lamp', 0.5, 9.5);
  assert.equal((await els()).length, n0 + 1);
  await wait(800);
  await page.reload(); await page.waitForFunction(() => window.__kit); await wait(600);
  assert.equal((await els()).length, n0 + 1); assert.ok(/edited/.test(await page.locator('.badge').first().innerText()));
  await page.click('button:has-text("File")'); await page.click('.menu button:has-text("Save as")'); await answer('My tank');
  await page.waitForFunction(() => window.__kit && window.__kit.doc.name === 'My tank'); await wait(300);
  assert.equal((await els()).length, n0 + 1); assert.equal(await page.locator('.badge').first().innerText(), 'My plant');
  await page.goto(BASE + '#/plc/tank'); await page.waitForFunction(() => window.__kit && window.__kit.doc.name.includes('Tank')); await wait(500);
  await page.click('button:has-text("File")'); await page.click('.menu button:has-text("Reset to template")'); await page.click('.modal-foot .btn.primary'); await wait(500);
  assert.equal((await els()).length, n0); assert.equal(await page.locator('.badge').first().innerText(), 'Template');
  log('template: edited copy survives a reload, “Save as…” makes it my plant, “Reset to template” restores the original');

  // ---- first person -----------------------------------------------------------------------------------------------------------
  await page.goto(BASE + '#/plc/motor'); await page.waitForFunction(() => window.__kit && window.__kit.doc.elements.length > 3); await wait(600);
  await page.keyboard.press('c'); await wait(300);
  assert.equal(await K(() => window.__kit.stage.world.mode), 'fps');
  const p0 = await K(() => window.__kit.stage.world.camera.position.toArray());
  await page.keyboard.down('w'); await wait(700); await page.keyboard.up('w');
  const p1 = await K(() => window.__kit.stage.world.camera.position.toArray());
  assert.ok(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 1, 'walked');
  await page.screenshot({ path: OUT + '/kit-first-person.png' });
  await page.keyboard.press('c'); await wait(200);
  assert.equal(await K(() => window.__kit.stage.world.mode), 'overview');
  log('first-person mode: C toggles, W walks');

  for (const id of ['traffic', 'conveyor', 'bottling', 'elevator']) {
    await page.goto(BASE + '#/plc/' + id); await page.waitForFunction((id) => window.__kit && window.__kit.doc.templateId === id, id); await wait(700);
    assert.equal(await page.locator('#cpu-state').innerText(), 'RUN', id + ' runs');
    await page.screenshot({ path: OUT + `/kit-${id}.png` });
  }
  log('traffic, conveyor, bottling and elevator templates open and run');

  assert.deepEqual(errs, [], 'no console errors:\n' + errs.join('\n'));
  await browser.close();
  console.log('\nPlant kit end-to-end test passed.');
})().catch((e) => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
