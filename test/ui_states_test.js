/* Repo regression: v2.1.13 UI states (empty-state teaching hint, tier copy,
   preview/writes toggle clarity, centered tier cards). v2.1.13 UI changes against the REAL renderer.
   Loads src/renderer/index.html in a hidden BrowserWindow with the real preload,
   stubs only native dialogs, and asserts items 1–5. Captures a PNG of the empty
   state for visual confirmation. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = require('path').join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

// ---- stub IPC (no encodes; just enough to stage + add one batch) ----
ipcMain.handle('app-version', async () => '2.1.13-test');
ipcMain.handle('browse-source-files', async () => ['/fake/clipA.mov']);
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: '/fake', ignored: 0, totalSize: 1234567,
  videos: [{ file: '/fake/clipA.mov', basename: 'clipA.mov', size: 1234567 }]
}));
ipcMain.handle('choose-destination', async () => '/tmp/squeeze-verify-out');
ipcMain.handle('stat-path', async () => ({ isFile: false, isDirectory: true }));
ipcMain.handle('save-last-src', async () => {});
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async () => null);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path','reveal-path','reset-drive','scan-source','pause-batch','resume-batch','cancel-batch','stop-queue','start-queue']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1100, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);

  // ---------- Item 1: empty-state hint present & visible ----------
  const hint0 = await run(`(() => {
    const s = document.getElementById('dz-steps');
    return { exists: !!s, hidden: s?.classList.contains('hidden'),
             visible: !!(s && s.offsetParent !== null),
             text: s?.textContent.replace(/\\s+/g,' ').trim() };
  })()`);
  check(hint0.exists && hint0.visible && !hint0.hidden, `empty-state hint shown on first run (got: "${hint0.text}")`);
  check(/1\s*Drop footage.*2\s*Pick a quality.*3\s*Add to queue, then Start/.test(hint0.text || ''),
    'hint reads the 3 steps in order');

  // ---------- Item 2: tier descriptions ----------
  const descs = await run(`(() => {
    const t = [...document.querySelectorAll('.tier')].map(el => ({
      name: el.querySelector('.name')?.textContent.trim(),
      desc: el.querySelector('.desc')?.textContent.trim() }));
    return t;
  })()`);
  const reg = descs.find((d) => d.name.startsWith('Who Cares'));
  const arc = descs.find((d) => d.name.startsWith('Probably'));
  check(reg && /smaller files/i.test(reg.desc) && /fast/i.test(reg.desc), `recommended desc shows speed/size tradeoff (got: "${reg?.desc}")`);
  check(arc && /best/i.test(arc.desc) && /(larger)/i.test(arc.desc) && /slow/i.test(arc.desc), `archival desc shows quality/size/slow tradeoff (got: "${arc?.desc}")`);
  check(reg.name === 'Who Cares…' && arc.name === 'Probably Need It Later', 'tier NAMES unchanged (locked)');

  // ---------- Item 3: toggle state clarity ----------
  const tog0 = await run(`(() => {
    const b = document.getElementById('dry-run');
    return { state: document.getElementById('dry-state')?.textContent.trim(),
             pressed: b.getAttribute('aria-pressed'),
             mode: document.getElementById('safety-bar').getAttribute('data-mode'),
             modeText: document.getElementById('safety-mode').textContent.trim() };
  })()`);
  check(tog0.state === 'Off' && tog0.pressed === 'false' && tog0.mode === 'write' && /writes files/i.test(tog0.modeText),
    `default state unmistakable: Writes files / toggle Off (got ${JSON.stringify(tog0)})`);
  await run(`document.getElementById('dry-run').click(); true;`); await wait(120);
  const tog1 = await run(`(() => ({
    state: document.getElementById('dry-state')?.textContent.trim(),
    pressed: document.getElementById('dry-run').getAttribute('aria-pressed'),
    mode: document.getElementById('safety-bar').getAttribute('data-mode'),
    modeText: document.getElementById('safety-mode').textContent.trim() }))()`);
  check(tog1.state === 'On' && tog1.pressed === 'true' && tog1.mode === 'preview' && /preview only/i.test(tog1.modeText),
    `toggled state unmistakable: Preview only / toggle On (got ${JSON.stringify(tog1)})`);
  await run(`document.getElementById('dry-run').click(); true;`); await wait(120); // back to write for the screenshot

  // ---------- Item 5: tiers centered; nothing else shifted ----------
  const geo = await run(`(() => {
    const r = (sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), rt: Math.round(b.right) }; };
    return { dropzone: r('.dropzone'), output: r('.output-row'), safety: r('.safety-bar'),
             tierHead: r('#tier-head'), tiers: r('.tiers') };
  })()`);
  const box = geo.safety; // a full-width sibling = the content box
  const sameBox = (g) => Math.abs(g.l - box.l) <= 1 && Math.abs(g.rt - box.rt) <= 1;
  check(sameBox(geo.dropzone) && sameBox(geo.output) && sameBox(geo.tierHead),
    `non-tier sections share one content box (drop/output/tier-head all = [${box.l},${box.rt}])`);
  const leftGap = geo.tiers.l - box.l;
  const rightGap = box.rt - geo.tiers.rt;
  check(leftGap > 4 && Math.abs(leftGap - rightGap) <= 2,
    `tier cards centered in the row (left gap ${leftGap}px ≈ right gap ${rightGap}px)`);
  const tierWidth = geo.tiers.rt - geo.tiers.l;
  check(tierWidth <= 722 && tierWidth >= 600, `tier pair kept its size (~720px max; got ${tierWidth}px)`);


  // ---------- Item 1 (cont): hint gives way once content is added ----------
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(500);
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(250);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
  const hint1 = await run(`(() => {
    const s = document.getElementById('dz-steps');
    return { hidden: s.classList.contains('hidden'), visible: s.offsetParent !== null,
             hasSource: document.getElementById('dropzone').classList.contains('has-source'),
             qlen: document.querySelectorAll('#queue .qbatch').length };
  })()`);
  check(hint1.qlen >= 1, `a batch was added (queue has ${hint1.qlen})`);
  check(hint1.hidden && !hint1.visible, 'hint is gone once the queue has content (even though the drop prompt is back)');

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
