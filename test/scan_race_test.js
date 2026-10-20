/* 3.3.1 Item 2 — overlapping scans never stage the wrong files.
   REAL renderer + REAL preload; main's scan handlers are stubbed so each scan
   resolves when the test says, which makes the out-of-order finish
   deterministic.

   FOLDERS   pick folder "first" (slow scan) then folder "second" (fast scan):
             staged files, srcName and the staging path line all belong to "second".
   FILES     same with two file-list picks (scan-files).
   STAT      "first" is still in its stat-path call (folder or files?) when
             "second" is picked and scanned: first's late stat must not start a
             scan that overwrites second.
   ADD-RESET guard (3.3.0 behaviour): a scan finishing after Add/clear writes nothing.

   FAIL-ON-OLD (3.3.0 / 399c3d2): the stale check compared the shared `current`
   object, which both picks share — first.mov ended up staged under second's name.
   Run: ./node_modules/.bin/electron test/scan_race_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const DELAY = { '/x/first': 600, '/x/second': 50, '/x/first.mov': 600, '/x/second.mov': 50 };
const STAT_DELAY = { '/x/statfirst': 600 };
const scanOf = (names) => ({ rootKind: 'dir', videos: names.map((n) => ({ file: `/x/${n}`, size: 1000, pix_fmt: 'yuv420p' })), ignored: 0, skippedOutputs: 0, totalSize: 1000 * names.length });

ipcMain.handle('app-version', async () => '3.3.1-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('get-history', async () => []);
ipcMain.handle('get-last-dest', async () => null);
ipcMain.handle('get-update-pref', async () => false);
ipcMain.handle('stat-path', async (_e, p) => { await wait(STAT_DELAY[p] || 0); return { ok: true, isDirectory: !/\.mov$/.test(p) }; });
ipcMain.handle('scan-source', async (_e, p) => { await wait(DELAY[p] || 0); return scanOf([`${path.basename(p)}.mov`]); });
ipcMain.handle('scan-files', async (_e, ps) => { await wait(DELAY[ps[0]] || 0); return scanOf(ps.map((p) => path.basename(p))); });
['save-last-src', 'add-reclaimed', 'open-path', 'reveal-path', 'reset-drive', 'free-space', 'delete-orphans', 'recover-orphans'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
  const run = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);
  const staged = () => run(`({ files: current.files.map((f) => f.name), srcName: current.srcName, src: current.src,
    fileSources: current.fileSources, line: document.getElementById('drop-status-path').textContent, count: document.getElementById('drop-status-count').textContent })`);

  // ── FOLDERS ──
  await run(`clearDrop(); stagePicked(['/x/first']); setTimeout(() => stagePicked(['/x/second']), 100); true`);
  await wait(1000);
  let s = await staged();
  check(JSON.stringify(s.files) === '["second.mov"]' && s.srcName === 'second' && s.src === '/x/second' && s.line === '/x/second',
    `FOLDERS: staged files and name both belong to the later pick (${JSON.stringify(s)})`);

  // ── FILES ──
  await run(`clearDrop(); stagePicked(['/x/first.mov', '/x/a.mov']); setTimeout(() => stagePicked(['/x/second.mov', '/x/b.mov']), 100); true`);
  await wait(1000);
  s = await staged();
  check(JSON.stringify(s.files) === '["second.mov","b.mov"]' && JSON.stringify(s.fileSources) === '["/x/second.mov","/x/b.mov"]' && /^second\.mov/.test(s.srcName),
    `FILES: staged files and name both belong to the later pick (${JSON.stringify(s)})`);

  // ── STAT ──
  await run(`clearDrop(); stagePicked(['/x/statfirst']); setTimeout(() => stagePicked(['/x/second']), 100); true`);
  await wait(1100);
  s = await staged();
  check(JSON.stringify(s.files) === '["second.mov"]' && s.srcName === 'second',
    `STAT: a pick still in stat-path never overwrites the later pick (${JSON.stringify(s)})`);

  // ── ADD-RESET guard ──
  await run(`clearDrop(); stagePicked(['/x/first']); setTimeout(() => clearDrop(), 100); true`);
  await wait(900);
  s = await staged();
  check(s.files.length === 0 && !s.src, `ADD-RESET: a scan finishing after clear stages nothing (${JSON.stringify(s)})`);

  console.log(`\n[scan-race] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
