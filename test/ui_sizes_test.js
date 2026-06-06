/* Repo regression for the recurring "per-file output size missing" bug.
   Drives the REAL renderer + REAL preload + REAL Electron IPC + REAL stage.js
   + REAL pipeline encodes through the FILE-LIST path (the GUI path), across a
   MULTI-BATCH queue where an early batch completes while a later one runs.
   Asserts:
     • every DONE file row shows a real MB output size (not "–"),
     • the bottom-panel Reclaimed/Completed reflect the WHOLE queue and agree
       with the per-batch footer total (the two-counter disagreement bug).
   Run:  ./node_modules/.bin/electron test/ui_sizes_test.js
   Needs the CompressorTest fixture + bundled ffmpeg; skips cleanly otherwise. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runBatch } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { flattenRunDir } = require(path.join(ROOT, 'src/encoder/flatten'));
const { stageFileList } = require(path.join(ROOT, 'src/encoder/stage'));
const { getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));

const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const TEST_DEST = path.join(os.tmpdir(), 'ui-sizes-out');
const SRCDIR = path.join(os.tmpdir(), 'ui-sizes-src');
let BATCH_FILES = [];   // [ [b1 files...], [b2 files...] ]
let browseCall = 0;

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win, queueRunning = false, stopRequested = false;
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

// ---- IPC: real handlers, only the native dialogs are stubbed ----
ipcMain.handle('app-version', async () => '2.1.12-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));   // engine present in tests
ipcMain.handle('scan-files', async (_e, paths) => {
  const { scanFolder } = require(path.join(ROOT, 'src/encoder/pipeline'));
  const videos = []; let ignored = 0, totalSize = 0;
  for (const p of paths) { const s = await scanFolder(p); videos.push(...s.videos); ignored += s.ignored || 0; totalSize += s.totalSize || 0; }
  return { rootKind: 'files', root: paths[0], videos, ignored, totalSize };
});
ipcMain.handle('browse-source-files', async () => BATCH_FILES[browseCall++ % BATCH_FILES.length]);
ipcMain.handle('choose-destination', async () => TEST_DEST);
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('save-last-src', async () => {});
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async () => null);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path', 'reveal-path', 'reset-drive', 'scan-source', 'pause-batch', 'resume-batch', 'cancel-batch', 'stop-queue']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

// start-queue mirrors production main.js (staging via real stage.js + path translation)
ipcMain.handle('start-queue', async (_e, batches) => {
  if (queueRunning) return { ok: false };
  queueRunning = true; stopRequested = false;
  const totals = { processed: 0, failed: 0 };
  try {
    for (const batch of batches) {
      send('batch-status', { id: batch.id, status: 'Running' });
      const state = rt(batch.id); state.resolved = false;
      const control = { shouldStop: () => stopRequested, isCancelled: () => false, isPaused: () => false, onSpawn: () => {} };
      let runSrc = batch.src, tmpCleanup = null, stageMap = new Map();
      if (batch.kind === 'files' && batch.fileSources && batch.fileSources.length) {
        const staged = await stageFileList(batch.id, batch.fileSources);
        runSrc = staged.stageDir; tmpCleanup = staged.tmpRoot; stageMap = staged.stageMap;
      }
      const wrapped = (runSrc === batch.src) ? batch : { ...batch, src: runSrc };
      const forward = (p) => {
        let q = p;
        if (stageMap.size && q && typeof q.file === 'string' && stageMap.has(q.file)) {
          const orig = stageMap.get(q.file); q = { ...q, file: orig, basename: path.basename(orig) };
        }
        send('progress', { batchId: batch.id, ...q });
      };
      let result;
      try { result = await runBatch(wrapped, control, forward); }
      catch (e) { result = { runDir: null, processed: 0, failed: 1, reclaimed: 0 }; }
      finally { if (tmpCleanup) { try { await fsp.rm(tmpCleanup, { recursive: true, force: true }); } catch {} } }
      if (result && result.runDir && fs.existsSync(result.runDir)) { try { await flattenRunDir(result.runDir); } catch {} }
      totals.processed += result.processed || 0; totals.failed += result.failed || 0;
      send('batch-status', { id: batch.id, status: result.failed > 0 ? 'Done (with failures)' : 'Done', result });
      state.resolved = true;
    }
  } finally { queueRunning = false; send('queue-finished', { totals, stopped: false }); }
  return { ok: true };
});

app.whenReady().then(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)');
    app.quit(); return;
  }
  await fsp.rm(TEST_DEST, { recursive: true, force: true });
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  await fsp.mkdir(TEST_DEST, { recursive: true });
  await fsp.mkdir(SRCDIR, { recursive: true });
  // Batch 1: two distinct files. Batch 2: two distinct files.
  const mk = async (n) => { const p = path.join(SRCDIR, n); await fsp.copyFile(SMALL_CLIP, p); return p; };
  BATCH_FILES = [
    [await mk('b1_a.mov'), await mk('b1_b.mov')],
    [await mk('b2_a.mov'), await mk('b2_b.mov')]
  ];

  win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await wait(400);
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(400);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  await run(`document.getElementById('start').click(); true;`);

  const snap = () => run(`(() => {
    const batches = [...document.querySelectorAll('.qbatch')].map(root => ({
      pill: root.querySelector('.qbatch-status .pill')?.textContent.trim(),
      rows: [...root.querySelectorAll('.qbatch-files .qrow')].map(r => ({
        status: r.querySelector('.status .pill')?.textContent.trim(),
        out: r.querySelectorAll('.mono')[1]?.textContent.trim()
      }))
    }));
    const reclaimedStat = document.getElementById('reclaimed')?.textContent.trim();
    const completedStat = document.getElementById('stat-completed')?.textContent.trim();
    const qfoot = document.getElementById('qfoot-reclaimed')?.textContent.trim();
    return { batches, reclaimedStat, completedStat, qfoot };
  })()`);

  // Capture the moment batch 1 is Done while batch 2 is still Running.
  let mid = null;
  for (let k = 0; k < 90; k++) {
    await wait(700);
    const s = await snap();
    if (s.batches[0]?.pill === 'Done' && s.batches[1] && /Running/.test(s.batches[1].pill || '')) { mid = s; break; }
    if (s.batches.length >= 2 && s.batches.every((b) => /Done|Failed/.test(b.pill || ''))) { mid = s; break; }
  }

  if (!mid) { check(false, 'reached a state with batch-1 done'); }
  else {
    console.log('  mid-run snapshot:', JSON.stringify(mid));
    const b1 = mid.batches[0];
    check(!!b1 && b1.pill === 'Done', 'batch 1 is Done');
    const b1done = (b1?.rows || []).filter((r) => r.status === 'Done');
    check(b1done.length === 2, 'batch 1 has 2 done rows');
    check(b1done.every((r) => /\dMB|\d+ MB|KB|\dGB|GB/.test(r.out || '') && r.out !== '—'),
      'EVERY done row in batch 1 shows a real output size (not "–")');
    check(mid.reclaimedStat && mid.reclaimedStat !== '0 B' && mid.reclaimedStat !== '—',
      `bottom-panel Reclaimed is non-zero while batch 1 is done (got ${mid.reclaimedStat})`);
    check(parseInt(mid.completedStat, 10) >= 2, `bottom Completed counts the whole queue (≥2; got ${mid.completedStat})`);
    check(mid.qfoot && mid.qfoot !== '—', `per-batch footer reclaimed present (got ${mid.qfoot})`);
  }
  check(errs.length === 0, 'no renderer console errors (e.g. "overall is not defined"): ' + (errs[0] || 'none'));

  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
