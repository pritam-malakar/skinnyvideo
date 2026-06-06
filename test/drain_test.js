/* Regression for OPTION A — a RUNNING queue drains ALL batches, including ones
   dropped WHILE it runs. Driven on the REAL GUI path: real renderer + real
   preload + real IPC shape + real stage.js + real pipeline encodes + the REAL
   src/main/queue-runner.js loop. The start-queue / enqueue-batch / pause / resume
   / stop handlers here MIRROR main.js (same liveBatches-append semantics) so the
   loop + drain under test is the exact behavior main ships.

   MODE=drain        drop batch B WHILE batch A runs → B is encoded in the SAME
                     run, no second Start. Also asserts the ETA/work re-baselines
                     to include B (no stall at 0 while Queued work remains). A is
                     the last (only) batch when B lands → also covers "drop during
                     the last batch".
   MODE=freshrun     let the run COMPLETE, THEN drop B → B is NOT absorbed into the
                     finished run (it waits Queued); a fresh Start runs it as a
                     SECOND run (two queue-finished events). No resurrection.
   MODE=pausehold    pause the active batch, drop B mid-run → B is NOT pulled while
                     paused; resume → the queue drains B.
   MODE=stopnodrain  Stop mid-run with batches Queued (one pre-Start, one dropped
                     mid-run) → Stop ends the run and does NOT drain the rest.

   FAIL-ON-OLD: before this fix the renderer never told main about a mid-run drop
   (no enqueue-batch), so B sat Queued and the run ended after the Start-time
   snapshot — drain/pausehold/stopnodrain B-encoded assertions fail.

   Run:  MODE=<mode> ./node_modules/.bin/electron test/drain_test.js
   Skips cleanly if the fixture clip or bundled ffmpeg is missing. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runBatch, scanFolder, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));

const MODE = process.env.MODE || 'drain';
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const DEST = path.join(os.tmpdir(), `squeeze-drain-out-${MODE}`);
const SRCDIR = path.join(os.tmpdir(), `squeeze-drain-src-${MODE}`);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win;
let BATCH_FILES = [];
let browseCall = 0;
let queueRunning = false, stopRequested = false, liveBatches = null;
let lastFinished = null, finishedCount = 0;
const batchStatuses = [];
const progressEvents = [];
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') { lastFinished = p; finishedCount++; }
  if (ch === 'progress') progressEvents.push(p);
  if (win && !win.isDestroyed()) win.webContents.send(ch, p);
};

// ---- IPC: real handlers; only native dialogs stubbed ----
ipcMain.handle('app-version', async () => '2.1.20-test');
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
['open-path', 'reveal-path', 'reset-drive', 'reveal-in-finder'].forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('set-batch-skips', async (_e, { batchId, skipped }) => { rt(batchId).skips = new Set(Array.isArray(skipped) ? skipped : []); return { ok: true }; });

// ---- start-queue / enqueue-batch / pause / resume / stop — MIRROR main.js ----
ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false, error: 'Already running' };
  queueRunning = true; stopRequested = false; liveBatches = batches;
  let totals;
  try {
    totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt });
  } finally {
    liveBatches = null; queueRunning = false;
    send('queue-finished', { totals: totals || { processed: 0, failed: 0 }, stopped: stopRequested });
  }
  return { ok: true };
});
ipcMain.handle('enqueue-batch', async (_e, batch) => {
  if (!queueRunning || !liveBatches || !batch) return { ok: true, absorbed: false };
  liveBatches.push(batch);
  return { ok: true, absorbed: true };
});
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });
ipcMain.handle('pause-batch', async (_e, id) => {
  const s = rt(id); if (!s.child || s.paused) return { ok: false };
  try { s.child.kill('SIGSTOP'); s.paused = true; send('batch-status', { id, status: 'Paused' }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('resume-batch', async (_e, id) => {
  const s = rt(id); if (!s.child || !s.paused) return { ok: false };
  try { s.child.kill('SIGCONT'); s.paused = false; send('batch-status', { id, status: 'Running' }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cancel-batch', async () => ({ ok: true }));

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
  const ranIds = () => batchStatuses.filter((s) => /Running/.test(s.status)).map((s) => s.id);
  const wentRunning = (id) => batchStatuses.some((s) => s.id === id && /Running/.test(s.status));
  // Renderer-side helpers
  const idByFile = (re) => run(`(() => { const b = (typeof queue!=='undefined'?queue:[]).find(b => b.files.some(f => /${re}/.test(f.name))); return b ? b.id : null; })()`);
  const work = () => run(`(typeof computeQueueWork === 'function') ? (({totalBytes,remainMs,hasRemaining}) => ({totalBytes,remainMs,hasRemaining}))(computeQueueWork()) : null`);
  const addPick = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(900); await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350); };

  if (MODE === 'drain') {
    BATCH_FILES = [[await mk('a1.mov'), await mk('a2.mov')], [await mk('b1.mov')]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    await wait(300);                                  // batch A is encoding
    const work0 = await work();
    const bId = null;
    await addPick();                                  // DROP B mid-run (runActive → enqueue)
    const work1 = await work();
    const newBId = await idByFile('b1');
    check(!!work0 && !!work1 && work1.totalBytes > work0.totalBytes,
      `ETA/work re-baselined to include the mid-run batch (totalBytes ${work0 && work0.totalBytes} → ${work1 && work1.totalBytes})`);
    check(!!work1 && work1.hasRemaining === true, 'work still has remaining (ETA does not stall at 0 while Queued work remains)');
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ outs, finishedCount, newBId, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(outs.some((f) => /a1/i.test(f)) && outs.some((f) => /a2/i.test(f)), 'the originally-running batch A encoded all its files');
    check(outs.some((f) => /b1/i.test(f)), 'mid-run-dropped batch B WAS encoded in the same run (THE FIX)');
    check(finishedCount === 1, `exactly ONE run completed — B drained in the same run, not a new one (got ${finishedCount})`);
    check(newBId != null && wentRunning(newBId), 'batch B went Running within the live run');
    const order = ranIds();
    check(newBId != null && order[order.length - 1] === newBId, `B ran AFTER A (drained at its turn) — Running order ${JSON.stringify(order)}`);
  } else if (MODE === 'freshrun') {
    BATCH_FILES = [[await mk('a1.mov')], [await mk('b1.mov')]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);
    check(finishedCount === 1, `first run completed (got finishedCount ${finishedCount})`);
    const afterFirst = outFiles();
    // Drop B AFTER the run finished (runActive is now false → not absorbed).
    await addPick();
    const bId = await idByFile('b1');
    await wait(800);                                  // give any (wrong) auto-run a chance
    check(bId != null && !wentRunning(bId), 'post-completion drop did NOT resurrect the finished run (B not auto-run)');
    check(finishedCount === 1, 'no phantom second queue-finished from the completed run');
    const startShown = await run(`!document.getElementById('start').classList.contains('hidden')`);
    check(startShown === true, 'Start is shown for the post-completion drop (a fresh run awaits)');
    // Now Start → a fresh, SECOND run encodes B.
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && finishedCount < 2; k++) await wait(700);
    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ afterFirst, outs, finishedCount, bId }));
    check(outs.some((f) => /b1/i.test(f)), 'B encoded in the fresh run');
    check(finishedCount === 2, `B started a NEW run with its own completion (got ${finishedCount} runs)`);
  } else if (MODE === 'pausehold') {
    BATCH_FILES = [[await mk('a1.mov'), await mk('a2.mov'), await mk('a3.mov')], [await mk('b1.mov')]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    // Wait until A is actually EMITTING encoder progress (ffmpeg child spawned —
    // it spawns only AFTER scan + stage, so a fixed sleep races it).
    let aId = null;
    for (let k = 0; k < 50; k++) {
      await wait(200);
      aId = await run(`(() => { const b=(typeof queue!=='undefined'?queue:[]).find(b=>b.status==='running'); return b?b.id:null; })()`);
      if (aId != null && progressEvents.some((p) => /a1/.test(p.basename || p.file || ''))) break;
    }
    // Pause; retry a few times in case we're momentarily between files (no child).
    let paused = false;
    for (let k = 0; k < 12 && !paused; k++) {
      await run(`window.api.pauseBatch(${JSON.stringify(aId)}); true;`);
      await wait(200);
      paused = batchStatuses.some((s) => s.id === aId && s.status === 'Paused');
    }
    check(paused === true, `active batch A paused (id ${aId})`);
    await addPick();                                  // DROP B while paused
    const bId = await idByFile('b1');
    await wait(900);                                  // B must NOT be pulled while paused
    check(bId != null && !wentRunning(bId), 'no next batch pulled while paused (B stays Queued until resume)');
    await run(`window.api.resumeBatch(${JSON.stringify(aId)}); true;`);
    for (let k = 0; k < 150 && !lastFinished; k++) await wait(700);
    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ aId, bId, outs, finishedCount, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(outs.some((f) => /a1/i.test(f)) && outs.some((f) => /b1/i.test(f)), 'after resume the queue drained A and the mid-run B');
    check(bId != null && wentRunning(bId), 'B ran once resumed');
    check(finishedCount === 1, `single continuous run (got ${finishedCount})`);
  } else if (MODE === 'stopnodrain') {
    BATCH_FILES = [[await mk('a1.mov')], [await mk('b1.mov')], [await mk('c1.mov')]];
    // A and B queued BEFORE start.
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    const bId = await idByFile('b1');
    await run(`document.getElementById('start').click(); true;`);
    await wait(250);                                  // A encoding
    await addPick();                                  // DROP C mid-run
    const cId = await idByFile('c1');
    await run(`window.api.stopQueue(); true;`);        // hard-stop
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);
    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ bId, cId, outs, stopped: lastFinished && lastFinished.stopped, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(outs.some((f) => /a1/i.test(f)), 'the in-flight batch A finished its current file');
    check(!outs.some((f) => /b1/i.test(f)), 'Stop did NOT drain the pre-Start queued batch B');
    check(!outs.some((f) => /c1/i.test(f)), 'Stop did NOT drain the mid-run-dropped batch C');
    check(bId != null && !wentRunning(bId), 'batch B never went Running after Stop');
    check(cId != null && !wentRunning(cId), 'batch C never went Running after Stop');
    check(lastFinished && lastFinished.stopped === true, 'run ended as user-stopped');
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) for (const l of FAIL) console.log(' - ' + l);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
