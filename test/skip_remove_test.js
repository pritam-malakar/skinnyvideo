/* Repro + regression for the v2.1.14 skip/removal/auto-advance bugs, driven on
   the REAL GUI path: real renderer + real preload + real IPC + real stage.js +
   real pipeline encodes. The start-queue handler is a faithful mirror of
   src/main/main.js (staging + per-batch loop + auto-advance).

   MODE=skip    → 2-batch queue; skip one file in batch 1.
                  Asserts the skipped file is NEVER encoded (BUG 1) AND the queue
                  auto-advances to batch 2 which also completes (BUG 3).
   MODE=remove  → 1 batch with 2 sources; delete ONE source from disk before
                  Start. Asserts ONLY that file fails and the other still encodes,
                  batch completes with partial success (BUG 2).

   Run:  MODE=skip   ./node_modules/.bin/electron test/skip_remove_test.js
         MODE=remove ./node_modules/.bin/electron test/skip_remove_test.js
   Skips cleanly if the fixture clip or bundled ffmpeg is missing. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runBatch, scanFolder, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { flattenRunDir } = require(path.join(ROOT, 'src/encoder/flatten'));
const { stageFileList } = require(path.join(ROOT, 'src/encoder/stage'));

const MODE = process.env.MODE || 'skip';
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const DEST = path.join(os.tmpdir(), `squeeze-sr-out-${MODE}`);
const SRCDIR = path.join(os.tmpdir(), `squeeze-sr-src-${MODE}`);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win;
let BATCH_FILES = [];      // queue of file-lists returned by successive browse calls
let browseCall = 0;
let queueRunning = false, stopRequested = false;
let lastFinished = null;
const batchStatuses = [];  // {id, status, result}
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') lastFinished = p;
  if (win && !win.isDestroyed()) win.webContents.send(ch, p);
};

// ---- IPC: real handlers; only native dialogs stubbed ----
ipcMain.handle('app-version', async () => '2.1.14-test');
ipcMain.handle('scan-files', async (_e, paths) => {
  const videos = []; let ignored = 0, totalSize = 0;
  for (const p of paths) { const s = await scanFolder(p); videos.push(...s.videos); ignored += s.ignored || 0; totalSize += s.totalSize || 0; }
  return { rootKind: 'files', root: paths[0], videos, ignored, totalSize };
});
ipcMain.handle('scan-source', async (_e, p) => scanFolder(p));
ipcMain.handle('browse-source-files', async () => BATCH_FILES[browseCall++] || []);
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('save-last-src', async () => {});
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async () => null);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path', 'reveal-path', 'reset-drive', 'pause-batch', 'resume-batch', 'cancel-batch']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });

// ---- start-queue: FAITHFUL mirror of src/main/main.js (loop + staging + advance) ----
ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false };
  queueRunning = true; stopRequested = false;
  const totals = { processed: 0, failed: 0, failedNoCopy: 0, reclaimed: 0 };
  try {
    for (let i = 0; i < batches.length; i++) {
      if (stopRequested) break;
      const batch = batches[i];
      send('batch-status', { id: batch.id, status: 'Running' });
      const state = rt(batch.id); state.resolved = false; state.cancelled = false;
      const control = { shouldStop: () => stopRequested, isCancelled: () => false, isPaused: () => false, onSpawn: () => {} };
      try {
        let runSrc = batch.src, tmpCleanup = null, stageMap = new Map(), stageError = null, stageMissing = [];
        if (batch.kind === 'files' && Array.isArray(batch.fileSources) && batch.fileSources.length > 0) {
          try {
            const staged = await stageFileList(batch.id, batch.fileSources);
            runSrc = staged.stageDir; tmpCleanup = staged.tmpRoot; stageMap = staged.stageMap;
            stageMissing = staged.missing || [];
          } catch (e) { stageError = e; }
        }
        if (stageError) {
          const n = Math.max(1, (batch.fileSources || []).length);
          const result = { runDir: null, processed: 0, failed: n, failedNoCopy: n, reclaimed: 0, totalFiles: n, sourceMissing: true, error: stageError.message };
          totals.failed += n; totals.failedNoCopy += n;
          send('batch-status', { id: batch.id, status: 'Failed', result });
          state.resolved = true; continue;
        }
        const wrappedBatch = (runSrc === batch.src) ? batch : { ...batch, src: runSrc };
        const forward = (progress) => {
          let p = progress;
          if (stageMap.size && p && typeof p.file === 'string' && stageMap.has(p.file)) {
            const orig = stageMap.get(p.file); p = { ...p, file: orig, basename: path.basename(orig) };
          }
          send('progress', { batchId: batch.id, ...p });
        };
        let result;
        try { result = await runBatch(wrappedBatch, control, forward); }
        catch (e) { result = { runDir: null, processed: 0, failed: 0, destLost: true, reclaimed: 0, totalFiles: 0, error: e.message }; }
        finally { if (tmpCleanup) { try { await fsp.rm(tmpCleanup, { recursive: true, force: true }); } catch {} } }

        // Fold any staging-skipped (missing) sources into the batch result as
        // per-file source-missing failures (faithful mirror of main.js).
        if (stageMissing.length) {
          result.failed = (result.failed || 0) + stageMissing.length;
          result.failedNoCopy = (result.failedNoCopy || 0) + stageMissing.length;
          result.totalFiles = (result.totalFiles || 0) + stageMissing.length;
          const tot = result.totalFiles || stageMissing.length;
          for (const mp of stageMissing) forward({
            type: 'file-done', index: tot, total: tot, file: mp, basename: path.basename(mp),
            outcome: 'fail', failKind: 'source-missing', outBytes: -1,
            processed: result.processed || 0, failed: result.failed || 0
          });
        }

        if (result && result.runDir && fs.existsSync(result.runDir)) { try { await flattenRunDir(result.runDir); } catch {} }
        totals.processed += result.processed || 0; totals.failed += result.failed || 0; totals.reclaimed += result.reclaimed || 0;
        let finalStatus;
        if (state.cancelled) finalStatus = 'Cancelled';
        else if (result.destLost && (result.processed || 0) === 0) finalStatus = 'Failed';
        else if ((result.failed || 0) > 0) finalStatus = 'Done (with failures)';
        else finalStatus = 'Done';
        send('batch-status', { id: batch.id, status: finalStatus, result });
        state.resolved = true;
      } catch (e) {
        if (!state.resolved) { send('batch-status', { id: batch.id, status: 'Failed', result: { processed: 0, failed: 1, error: e.message } }); state.resolved = true; }
      }
      if (stopRequested) break;
    }
  } finally { queueRunning = false; send('queue-finished', { totals, stopped: stopRequested }); }
  return { ok: true };
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)'); app.quit(); return;
  }
  await fsp.rm(DEST, { recursive: true, force: true });
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  await fsp.mkdir(DEST, { recursive: true });
  await fsp.mkdir(SRCDIR, { recursive: true });
  const mk = async (n) => { const p = path.join(SRCDIR, n); await fsp.copyFile(SMALL_CLIP, p); return p; };

  win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  await wait(400);

  const outFiles = () => fs.existsSync(DEST)
    ? fs.readdirSync(DEST, { recursive: true }).filter((f) => /\.mp4$/i.test(f)).map((f) => path.basename(f))
    : [];

  if (MODE === 'skip' || MODE === 'skipfolder') {
    if (MODE === 'skip') {
      // FILE-PICK path. Batch 1: keepA.mov + skipMe.mov → skip skipMe. Batch 2: b2.mov.
      BATCH_FILES = [[await mk('keepA.mov'), await mk('skipMe.mov')], [await mk('b2.mov')]];
      await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
      await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
      await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    } else {
      // FOLDER path (the IMG_0011 camera-folder scenario). Build two folders, each
      // with its own videos, via the real folder-drop code path (stageSource()).
      const f1 = path.join(SRCDIR, 'Clips A'); const f2 = path.join(SRCDIR, 'Clips B');
      await fsp.mkdir(f1, { recursive: true }); await fsp.mkdir(f2, { recursive: true });
      await fsp.copyFile(SMALL_CLIP, path.join(f1, 'keepA.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(f1, 'skipMe.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(f2, 'b2.mov'));
      await run(`stageSource(${JSON.stringify(f1)})`); await wait(900);
      await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
      await run(`addCurrentToQueue(); true;`); await wait(350);
    }
    // skip the skipMe row in batch 1
    const skipped = await run(`(() => {
      const b1 = document.querySelectorAll('.qbatch')[0];
      const row = [...b1.querySelectorAll('.qrow')].find(r => /skipMe/.test(r.textContent));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`); await wait(250);
    check(skipped === true, 'skip control was clickable on the skipMe row');
    if (MODE === 'skip') {
      await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
      await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    } else {
      await run(`stageSource(${JSON.stringify(path.join(SRCDIR, 'Clips B'))})`); await wait(900);
      await run(`addCurrentToQueue(); true;`); await wait(350);
    }
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ outs, statuses: batchStatuses.map(s => ({ id: s.id, st: s.status })), totals: lastFinished && lastFinished.totals }));
    check(!outs.some((f) => /skipMe/i.test(f)), `skipped file was NEVER encoded (BUG 1) — outputs: [${outs.join(', ')}]`);
    check(outs.some((f) => /keepA/i.test(f)), 'the kept file in batch 1 WAS encoded');
    check(outs.some((f) => /b2/i.test(f)), 'batch 2 ran and encoded (auto-advance — BUG 3)');
    const terminal = (id) => batchStatuses.filter((s) => s.id === id).slice(-1)[0];
    const ids = [...new Set(batchStatuses.map((s) => s.id))];
    check(ids.length === 2 && ids.every((id) => /Done/.test(terminal(id).status)),
      `both batches reached a Done state (got ${ids.map((id) => terminal(id).status).join(' / ')})`);
  } else if (MODE === 'remove') {
    // Batch: present.mov + ghost.mov.  Delete ghost.mov AFTER scan, BEFORE start.
    const present = await mk('present.mov');
    const ghost = await mk('ghost.mov');
    BATCH_FILES = [[present, ghost]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await fsp.rm(ghost, { force: true });           // remove one source from disk
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    const term = batchStatuses.slice(-1)[0];
    const rows = await run(`(() => [...document.querySelectorAll('.qbatch')[0].querySelectorAll('.qrow')].map(r => ({
      name: (r.querySelector('.fname, .name, .qrow-name') || r).textContent.replace(/\\s+/g,' ').trim().slice(0,40),
      status: r.querySelector('.status .pill')?.textContent.trim()
    })))()`);
    console.log('  RESULT', JSON.stringify({ outs, rows, term: term && { st: term.status, processed: term.result && term.result.processed, failed: term.result && term.result.failed }, totals: lastFinished && lastFinished.totals }));
    check(outs.some((f) => /present/i.test(f)), `the present source still encoded (BUG 2) — outputs: [${outs.join(', ')}]`);
    check(!outs.some((f) => /ghost/i.test(f)), 'the removed source did not produce output');
    check(lastFinished && lastFinished.totals.processed >= 1, `at least one file processed (got ${lastFinished && lastFinished.totals.processed})`);
    check(lastFinished && lastFinished.totals.failed === 1, `exactly ONE file failed, not the whole batch (got ${lastFinished && lastFinished.totals.failed})`);
    check(term && /with failures/.test(term.status), `batch completed with PARTIAL success (got ${term && term.status})`);
    const ghostRow = rows.find((r) => /ghost/i.test(r.name));
    const presentRow = rows.find((r) => /present/i.test(r.name));
    check(presentRow && /done|✓/i.test(presentRow.status || ''), `present row shows Done (got ${presentRow && presentRow.status})`);
    check(ghostRow && /fail/i.test(ghostRow.status || ''), `removed (ghost) row shows Failed, not stuck queued (got ${ghostRow && ghostRow.status})`);
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
