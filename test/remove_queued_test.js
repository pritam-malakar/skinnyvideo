/* PHANTOM-FREEZE repro — removing a QUEUED batch while a run is in progress
   must tell main to skip it. Today the renderer's remove ✕ only filters its
   in-memory `queue` and re-renders: main's liveBatches still holds the batch,
   so the engine encodes it INVISIBLY (no row, Start hidden, app looks frozen
   until queue-finished). Ground truth = real ffmpeg outputs on disk.

   Driven on the REAL GUI path: real renderer + real preload + real IPC shape +
   real stage.js + real pipeline encodes + the REAL src/main/queue-runner.js
   loop. start-queue / enqueue-batch handlers MIRROR main.js.

   MODE=removequeued  (default) queue A (2 files) + B (1 file) pre-Start; Start;
                      while A encodes, click B's remove ✕ (real DOM). Engine
                      must NOT encode b1. FAILS on current code: b1.mp4 appears,
                      B's id goes Running with no renderer row (phantom).

   Run:  ./node_modules/.bin/electron test/remove_queued_test.js
   Skips cleanly if the fixture clip or bundled ffmpeg is missing. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { scanFolder, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));

const MODE = process.env.MODE || 'removequeued';
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';
const DEST = path.join(os.tmpdir(), `squeeze-rmq-out-${MODE}`);
const SRCDIR = path.join(os.tmpdir(), `squeeze-rmq-src-${MODE}`);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win;
let BATCH_FILES = [];
let browseCall = 0;
let queueRunning = false, stopRequested = false, liveBatches = null;
let lastFinished = null, finishedCount = 0;
const batchStatuses = [];
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') { lastFinished = p; finishedCount++; }
  if (win && !win.isDestroyed()) win.webContents.send(ch, p);
};

// ---- IPC: real handlers; only native dialogs stubbed ----
ipcMain.handle('app-version', async () => '2.2.6-test');
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
ipcMain.handle('pause-batch', async () => ({ ok: true }));
ipcMain.handle('resume-batch', async () => ({ ok: true }));
ipcMain.handle('cancel-batch', async () => ({ ok: true }));
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });

// ---- start-queue / enqueue-batch — MIRROR main.js ----
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
ipcMain.handle('remove-batch', async (_e, batchId) => { rt(batchId).removed = true; return { ok: true }; });

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
  const wentRunning = (id) => batchStatuses.some((s) => s.id === id && /Running/.test(s.status));
  const idByFile = (re) => run(`(() => { const b = (typeof queue!=='undefined'?queue:[]).find(b => b.files.some(f => /${re}/.test(f.name))); return b ? b.id : null; })()`);
  const addPick = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(900); await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350); };

  if (MODE === 'removequeued') {
    BATCH_FILES = [[await mk('a1.mov'), await mk('a2.mov')], [await mk('b1.mov')]];
    // Queue A then B, BOTH before Start.
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await addPick();
    const bId = await idByFile('b1');
    check(bId != null, `batch B queued pre-Start (id ${bId})`);
    await run(`document.getElementById('start').click(); true;`);
    await wait(400);                                   // A is encoding

    // REMOVE B via its real ✕ button (the actual GUI path under test).
    const clicked = await run(`(() => {
      const btn = document.querySelector('[data-id="${bId}"] .qbatch-remove--x');
      if (!btn) return false;
      btn.click(); return true;
    })()`);
    check(clicked === true, 'clicked the real remove ✕ on queued batch B mid-run');
    const stillInView = await run(`(typeof queue!=='undefined'?queue:[]).some(b => b.id === ${JSON.stringify(bId)})`);
    check(stillInView === false, 'renderer view no longer lists B');

    for (let k = 0; k < 150 && !lastFinished; k++) await wait(700);
    check(!!lastFinished, 'run reached queue-finished');

    const outs = outFiles();
    console.log('  RESULT', JSON.stringify({ bId, outs, finishedCount, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(outs.some((f) => /a1/i.test(f)) && outs.some((f) => /a2/i.test(f)), 'batch A encoded all its files');
    check(!outs.some((f) => /b1/i.test(f)), 'engine did NOT encode the removed batch B (THE FIX — phantom freeze)');
    check(bId != null && !wentRunning(bId), 'removed batch B never went Running main-side (no invisible work)');
    check(finishedCount === 1, `exactly one run completed (got ${finishedCount})`);
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) for (const l of FAIL) console.log(' - ' + l);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
