/* Regression: v2.1.17 FEATURE 2 — double-click a BATCH name → inline rename.

   Part A (renderer behavior, REAL renderer + preload):
     • rename commits to the queue model + the visible header,
     • empty / whitespace-only is rejected (previous name kept).
   Part B (GROUND TRUTH — real run): after renaming, run the batch through the
     REAL queue-runner + REAL pipeline encode and assert the produced output is
     under <dest>/Compressed_<timestamp>/ (stat the real file). The rename must
     NOT move the output — srcName is a label, never an on-disk path.
   Part C (GROUND TRUTH — real stage.js): the staging dir is id-based
     ("Selected files (<id>)"), independent of the batch name.

   FAIL on old code: no dblclick→edit exists, so the rename is a no-op and the
   queue model keeps the old name → Part A fails. PASS on the fix.

   Run:  ./node_modules/.bin/electron test/batch_rename_test.js
   Needs the CompressorTest fixture + bundled ffmpeg; Part B skips cleanly
   (still PASSES Part A/C) otherwise. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));
const { stageFileList } = require(path.join(ROOT, 'src/encoder/stage'));
const { getBinaries, scanFolder } = require(path.join(ROOT, 'src/encoder/pipeline'));

const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const TEST_DEST = path.join(os.tmpdir(), 'rename-test-out-' + process.pid);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

const bins = getBinaries();
const CAN_ENCODE = fs.existsSync(bins.ffmpeg) && fs.existsSync(SMALL_CLIP);

let win, stopRequested = false;
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, { child: null, paused: false, cancelled: false }); return rtm.get(id); };
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

// ── Real start-queue (same wiring as main.js) so the encode + output path are real ──
ipcMain.handle('start-queue', async (_e, batches) => {
  stopRequested = false;
  let totals;
  try { totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt }); }
  finally { send('queue-finished', { totals: totals || {}, stopped: stopRequested }); }
  return { ok: true };
});
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });
ipcMain.handle('set-batch-skips', async (_e, { batchId, skipped }) => { rt(batchId).skips = new Set(skipped || []); return { ok: true }; });
ipcMain.handle('scan-files', async (_e, paths) => {
  const videos = []; let ignored = 0, totalSize = 0;
  for (const p of paths) { const s = await scanFolder(p); videos.push(...s.videos); ignored += s.ignored || 0; totalSize += s.totalSize || 0; }
  return { rootKind: 'files', root: paths[0], videos, ignored, totalSize };
});
ipcMain.handle('choose-destination', async () => TEST_DEST);
ipcMain.handle('app-version', async () => '2.1.17-test');
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('check-engine', async () => ({ ok: true }));   // engine present in tests
['save-last-src','add-reclaimed','free-space','delete-orphans','open-path','reveal-path',
 'reveal-in-finder','reset-drive','pause-batch','resume-batch','cancel-batch','browse-source','browse-source-files']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  fs.mkdirSync(TEST_DEST, { recursive: true });
  win = new BrowserWindow({ width: 1100, height: 1000, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);

  // Stage one file-list batch + a destination, then add it.
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`(async () => { await stageFiles([${JSON.stringify(SMALL_CLIP)}]); })()`); await wait(300);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(200);
  const origName = await run(`queue[0] && queue[0].srcName`);
  check(!!origName, `batch added with a name (got "${origName}")`);

  // Helper: dblclick the batch name, type a value, end with Enter or Escape.
  const rename = (value, key) => run(`(async () => {
    const nameEl = document.querySelector('#queue .qbatch .qbatch-name');
    nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const input = document.querySelector('#queue .qbatch .qbatch-name-edit');
    if (!input) return { ok:false, reason:'no input' };
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    return { ok:true, model: queue[0].srcName,
             shown: (document.querySelector('#queue .qbatch .qbatch-name')||{}).textContent };
  })()`);

  // A1: commit a real rename → model + header both update.
  const r1 = await rename('Holiday Footage', 'Enter');
  check(r1.ok && r1.model === 'Holiday Footage', `rename commits to queue model (got "${r1.model}")`);
  check(/Holiday Footage/.test(r1.shown || ''), `rename shows in the header (got "${r1.shown}")`);

  // A2: empty rejected → previous kept.
  const r2 = await rename('', 'Enter');
  check(r2.model === 'Holiday Footage', `empty name rejected, previous kept (got "${r2.model}")`);

  // A3: whitespace-only rejected → previous kept.
  const r3 = await rename('    ', 'Enter');
  check(r3.model === 'Holiday Footage', `whitespace-only rejected, previous kept (got "${r3.model}")`);

  // A4: Escape cancels without committing.
  const r4 = await rename('SHOULD NOT STICK', 'Escape');
  check(r4.model === 'Holiday Footage', `Escape cancels the edit (got "${r4.model}")`);

  // Part C: staging dir is id-based, NOT name-based (real stage.js).
  const staged = await stageFileList(4242, CAN_ENCODE ? [SMALL_CLIP] : []);
  const stageBase = path.basename(staged.stageDir);
  check(stageBase === 'Selected files (4242)',
    `staging dir is id-based, name-independent (got "${stageBase}")`);
  check(!/Holiday Footage/.test(staged.stageDir), 'staging dir does not contain the batch name');
  try { await fsp.rm(staged.tmpRoot, { recursive: true, force: true }); } catch {}

  // Part B: real run → output under <dest>/Compressed_<ts>/ despite the rename.
  if (CAN_ENCODE) {
    // Start the real encode and poll the renderer's queue model for the result.
    await run(`document.getElementById('start').click(); true;`);
    let result = null;
    for (let i = 0; i < 360 && !result; i++) {       // up to ~180s
      await wait(500);
      const st = await run(`(() => { const b = queue[0]; return { status: b.status,
        runDir: b.lastResult ? b.lastResult.runDir : null }; })()`);
      if (st.status === 'done' || st.status === 'failed') result = st;
    }
    const runDir = result && result.runDir;
    check(!!runDir && /\/Compressed_\d{4}-\d{2}-\d{2}_\d{4}$/.test(runDir),
      `output runDir is <dest>/Compressed_<timestamp>/ (got "${runDir}")`);
    check(!!runDir && runDir.startsWith(TEST_DEST),
      `output stays under the chosen destination (got "${runDir}")`);
    let outFile = null;
    if (runDir) { try { outFile = (await fsp.readdir(runDir)).find((f) => /\.mp4$/i.test(f)); } catch {} }
    check(!!outFile, `a real compressed file exists in the run dir (got "${outFile}")`);
    check(!/Holiday Footage/.test(runDir || ''), 'rename did not leak into the output path');
  } else {
    console.log('SKIP (Part B real encode): fixture/ffmpeg missing');
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  try { fs.rmSync(TEST_DEST, { recursive: true, force: true }); } catch {}
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
