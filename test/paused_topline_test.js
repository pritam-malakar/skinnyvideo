/* Regression: real pause/resume of a queue batch. (The original v2.1.17 FEATURE 3
   "top activity line" has since been REMOVED in the re-skin — this test now also
   asserts that the #top-progress element is gone in every state.)

   Drives the REAL renderer + preload + REAL queue-runner + REAL pipeline encode
   of a real clip. Pause/resume go through the SAME path the Pause button uses
   (window.api.pauseBatch/resumeBatch → a real SIGSTOP/SIGCONT on the encode
   child → the real 'Paused'/'Running' batch-status). The assertions bind to the
   REAL pause state (item.status === 'paused', set by that message), NOT a mocked flag.

   Asserts:
     • while PAUSED: tl-tag reads paused, NO second orange cue (.next-action) active,
       and NO top-progress line exists;
     • on RESUME: the batch returns to running;
     • the #top-progress element is gone from index.html.

   Run:  ./node_modules/.bin/electron test/paused_topline_test.js
   Needs the CompressorTest fixture + bundled ffmpeg; skips cleanly otherwise. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));
const { getBinaries, scanFolder } = require(path.join(ROOT, 'src/encoder/pipeline'));

const { ensureFixtures } = require('./fixture_helper');
const FX = ensureFixtures();
// '' when the bundled ffmpeg is absent, so the existsSync guard below skips cleanly.
const SMALL_CLIP = FX ? FX.smallClip : '';
const TEST_DEST = path.join(os.tmpdir(), 'paused-test-out-' + process.pid);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

const bins = getBinaries();
if (!fs.existsSync(bins.ffmpeg) || !fs.existsSync(SMALL_CLIP)) {
  console.log('SKIP: fixture/ffmpeg missing — cannot drive a real encode to pause.');
  console.log('\nPASS: 0 FAIL: 0');
  process.exit(0);
}

let win, stopRequested = false;
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, { child: null, paused: false, cancelled: false }); return rtm.get(id); };
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };
const sendBatch = (id, status) => send('batch-status', { id, status });

// ── Real run + the REAL pause/resume/cancel handlers (verbatim from main.js) ──
ipcMain.handle('start-queue', async (_e, batches) => {
  stopRequested = false;
  let totals;
  try { totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt }); }
  finally { send('queue-finished', { totals: totals || {}, stopped: stopRequested }); }
  return { ok: true };
});
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });
ipcMain.handle('pause-batch', async (_e, id) => {
  const s = rt(id);
  if (!s.child || s.paused) return { ok: false };
  try { s.child.kill('SIGSTOP'); s.paused = true; sendBatch(id, 'Paused'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('resume-batch', async (_e, id) => {
  const s = rt(id);
  if (!s.child || !s.paused) return { ok: false };
  try { s.child.kill('SIGCONT'); s.paused = false; sendBatch(id, 'Running'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cancel-batch', async (_e, id) => {
  const s = rt(id); s.cancelled = true;
  if (s.child && s.paused) { try { s.child.kill('SIGCONT'); } catch {} s.paused = false; }
  if (s.child) { try { s.child.kill('SIGTERM'); } catch {} const c = s.child; setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 800); }
  return { ok: true };
});
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
 'reveal-in-finder','reset-drive','browse-source','browse-source-files']
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

  // Hard safety net: never let a stuck encode hang the suite.
  const bail = setTimeout(() => {
    for (const [, s] of rtm) { try { s.child && s.child.kill('SIGCONT'); s.child && s.child.kill('SIGKILL'); } catch {} }
    console.log('\nBAIL: timed out'); console.log('PASS:', PASS.length, 'FAIL:', FAIL.length + 1);
    app.exit(1);
  }, 180000);

  await wait(400);
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`(async () => { await stageFiles([${JSON.stringify(SMALL_CLIP)}]); })()`); await wait(300);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(150);
  const batchId = await run(`queue[0].id`);
  await run(`document.getElementById('start').click(); true;`);

  // Wait until the encode child is live AND the renderer shows running + active.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await wait(500);
    const status = await run(`queue[0].status`);
    if (status === 'running' && rt(batchId).child) ready = true;
  }
  check(ready, 'real encode reached running state');

  // The top progress line was REMOVED — it must not exist in any state.
  check(await run(`document.getElementById('top-progress') === null`),
    'no top-progress line element while RUNNING');

  // PAUSE through the same mechanism the Pause button uses (real SIGSTOP).
  await run(`window.api.pauseBatch(${JSON.stringify(batchId)}); true;`);
  let paused = false;
  for (let i = 0; i < 30 && !paused; i++) { await wait(150); paused = (await run(`queue[0].status`)) === 'paused'; }
  check(paused, 'pause-batch drove the batch to the real paused state');

  const onPause = await run(`(() => ({
    tlPaused: document.getElementById('tl-tag').classList.contains('paused'),
    orangeCues: document.querySelectorAll('.next-action').length,
    topGone: document.getElementById('top-progress') === null }))()`);
  check(onPause.tlPaused, 'PAUSED: tl-tag reads paused');
  check(onPause.orangeCues === 0, `PAUSED mid-run: no second orange cue active (got ${onPause.orangeCues})`);
  check(onPause.topGone, 'PAUSED: still no top-progress line');

  // RESUME (real SIGCONT) → back to running.
  await run(`window.api.resumeBatch(${JSON.stringify(batchId)}); true;`);
  let resumed = false;
  for (let i = 0; i < 30 && !resumed; i++) { await wait(150); resumed = (await run(`queue[0].status`)) === 'running'; }
  check(resumed, 'resume-batch drove the batch back to running');

  // Static check: the top-progress element is gone from the source.
  const idxHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  check(!/id="top-progress"/.test(idxHtml), 'top-progress element removed from index.html');

  // Clean up: cancel the encode child + stop the queue.
  await run(`window.api.cancelBatch(${JSON.stringify(batchId)}); true;`);
  stopRequested = true;
  await wait(1500);

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  clearTimeout(bail);
  try { fs.rmSync(TEST_DEST, { recursive: true, force: true }); } catch {}
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
