/* Repro + regression for the skip / removal / size / auto-advance bugs, driven on
   the REAL GUI path: real renderer + real preload + real IPC + real stage.js +
   real pipeline encodes, AND the REAL src/main/queue-runner.js loop (the exact
   code main.js ships — NOT a mirror, so a real-loop bug can't hide behind a
   simplified copy).

   MODE=skip        file-pick: skip a file → never encoded; queue advances.
   MODE=skipfolder  same via the real folder-drop path.
   MODE=remove      delete one of two sources before Start → only that file fails.
   MODE=sizes       byte-for-byte: stored size === fsp.stat() (source AND output).
   MODE=skiplive    skip a file in a LATER batch AFTER Start.
   MODE=skipadvance 4 batches, skip the MIDDLE batch (03) → queue auto-advances
                    to batch 04 (the live "halts after a skip batch" report).
   MODE=skipthree   batch 03 ends done+failed+skipped → still auto-advances.
   MODE=allskipped  a MIDDLE all-skipped batch shows Done (not stuck Queued) and
                    the queue advances past it.
   MODE=skipui      v2.8.0 spec: within the RUNNING batch only the row
                    CURRENTLY ENCODING lacks the skip control; its queued
                    rows and all waiting-batch rows keep theirs.
   MODE=terminaldone v2.7.1: a row already in a TERMINAL status (skipped) is
                    never overwritten by an exact-path file-start/file-done
                    event (the "skipped row flips to Done + size" bug).
   MODE=liveskip    v2.8.0: skip a not-yet-started file of the RUNNING batch
                    → never encoded (no output on disk), row Skipped, summary
                    counts it, batch ends Done.
   MODE=unskip      v2.8.0: skip then UN-skip a file of the running batch
                    before its turn → it IS encoded.
   MODE=skiprace    v2.8.0 lost-race rule: a skip pushed AFTER the pipeline
                    passed that file's boundary (its file-start already fired)
                    loses — the pipeline is ground truth. The row must flip
                    back to running and end Done with a real output; the skip
                    set converges (path pruned + re-pushed).

   Run:  MODE=<mode> ./node_modules/.bin/electron test/skip_remove_test.js
   Fixture: SKINNYVIDEO_TEST_CLIP env var, else test/fixtures/tiny_clip.mov, else
   the legacy CompressorTest path. Generate the local fixture with the
   bundled engine (from the repo root):
     ./resources/bin/ffmpeg -f lavfi -i testsrc=duration=2:size=640x360:rate=15 \
       -f lavfi -i sine=frequency=440:duration=2 \
       -c:v h264_videotoolbox -b:v 800k -c:a aac test/fixtures/tiny_clip.mov
   LONG fixture (liveskip/unskip/skipui need a wide first-file encode window;
   SKINNYVIDEO_TEST_CLIP_LONG env var, else test/fixtures/long_clip.mov):
     ./resources/bin/ffmpeg -f lavfi -i testsrc=duration=60:size=3840x2160:rate=15 \
       -f lavfi -i sine=frequency=440:duration=60 \
       -c:v h264_videotoolbox -b:v 12M -c:a aac test/fixtures/long_clip.mov
   Skips cleanly if no fixture clip or the bundled ffmpeg is missing. */
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
/* Fixture resolution: env override → repo-local generated clip → legacy path.
   See the header for the one-line generation command. */
const CLIP_CANDIDATES = [
  process.env.SKINNYVIDEO_TEST_CLIP,
  path.join(__dirname, 'fixtures', 'tiny_clip.mov'),
  '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov'
].filter(Boolean);
const SMALL_CLIP = CLIP_CANDIDATES.find((p) => fs.existsSync(p)) || CLIP_CANDIDATES[0];
const LONG_CANDIDATES = [
  process.env.SKINNYVIDEO_TEST_CLIP_LONG,
  path.join(__dirname, 'fixtures', 'long_clip.mov')
].filter(Boolean);
const LONG_CLIP = LONG_CANDIDATES.find((p) => fs.existsSync(p)) || LONG_CANDIDATES[0];
const NEEDS_LONG = new Set(['skipui', 'liveskip', 'unskip']);
const DEST = path.join(os.tmpdir(), `skinnyvideo-sr-out-${MODE}`);
const SRCDIR = path.join(os.tmpdir(), `skinnyvideo-sr-src-${MODE}`);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

let win;
let BATCH_FILES = [];      // queue of file-lists returned by successive browse calls
let browseCall = 0;
let queueRunning = false, stopRequested = false;
let lastFinished = null;
const batchStatuses = [];  // {id, status, result}
const progressEvents = []; // every forwarded progress event (for file-start spawn proxy)
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
/* v2.8.0 race harness: a mode may install interceptSend to HOLD one event
   (returning true) and later release it via rawSend — this reproduces the
   skip-vs-file-start race deterministically. Null = passthrough. */
let interceptSend = null;
const rawSend = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') lastFinished = p;
  if (ch === 'progress') progressEvents.push(p);
  if (win && !win.isDestroyed()) win.webContents.send(ch, p);
};
const send = (ch, p) => {
  if (interceptSend && interceptSend(ch, p)) return;
  rawSend(ch, p);
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
let lifetimeCredit = null;
ipcMain.handle('add-reclaimed', async (_e, payload) => { lifetimeCredit = payload; return null; });
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('delete-orphans', async () => ({ deleted: 0 }));
['open-path', 'reveal-path', 'reset-drive', 'pause-batch', 'resume-batch', 'cancel-batch']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));
ipcMain.handle('check-engine', async () => ({ ok: true }));   // engine present in tests
ipcMain.handle('stop-queue', async () => { stopRequested = true; return { ok: true }; });
ipcMain.handle('set-batch-skips', async (_e, { batchId, skipped }) => { rt(batchId).skips = new Set(Array.isArray(skipped) ? skipped : []); return { ok: true }; });

// ---- start-queue: drives the REAL src/main/queue-runner.js (NOT a mirror) so
//      the loop/auto-advance under test is the exact code main.js ships. ----
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));
ipcMain.handle('start-queue', async (_evt, batches) => {
  if (queueRunning) return { ok: false };
  queueRunning = true; stopRequested = false;
  let totals;
  try {
    totals = await runQueue(batches, { send, isStopRequested: () => stopRequested, rt });
  } finally {
    queueRunning = false;
    send('queue-finished', { totals: totals || { processed: 0, failed: 0 }, stopped: stopRequested });
  }
  return { ok: true };
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)'); app.quit(); return;
  }
  if (NEEDS_LONG.has(MODE) && !fs.existsSync(LONG_CLIP)) {
    console.log('(skipped — long fixture clip not present; see header for the generation command)'); app.quit(); return;
  }
  await fsp.rm(DEST, { recursive: true, force: true });
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  await fsp.mkdir(DEST, { recursive: true });
  await fsp.mkdir(SRCDIR, { recursive: true });
  const mk = async (n) => { const p = path.join(SRCDIR, n); await fsp.copyFile(SMALL_CLIP, p); return p; };
  const mkLong = async (n) => { const p = path.join(SRCDIR, n); await fsp.copyFile(LONG_CLIP, p); return p; };
  /* Poll until the REAL renderer reports a given file's row status. */
  const waitRow = async (namePart, want, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const st = await run(`(() => { const b = queue[0]; const f = b && b.files.find((x) => x.name.includes(${JSON.stringify(namePart)})); return f ? f.status : null; })()`);
      if (want.includes(st)) return st;
      await wait(150);
    }
    return null;
  };

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
  } else if (MODE === 'sizes') {
    // BUG 1 — every displayed/stored size must equal fsp.stat() of the real file,
    // byte-for-byte, for BOTH source and output. Real 3-file encode.
    const srcs = [await mk('sz_a.mov'), await mk('sz_b.mov'), await mk('sz_c.mov')];
    BATCH_FILES = [srcs];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    // Pull the renderer's STORED per-file sizes straight from its queue state.
    const stored = await run(`(typeof queue!=='undefined'?queue:[]).flatMap(b => b.files.map(f => ({ name: f.name, size: f.size, outputSize: f.outputSize, status: f.status })))`);
    const realOut = {};
    if (fs.existsSync(DEST)) for (const f of fs.readdirSync(DEST, { recursive: true })) {
      if (/\.mp4$/i.test(f)) realOut[path.basename(f, '.mp4')] = (await fsp.stat(path.join(DEST, f))).size;
    }
    let sumSrcStat = 0, sumOutStat = 0, sumReclaim = 0, allMatch = true;
    console.log('  file                stored-src   stat-src     stored-out   stat-out');
    for (const r of stored) {
      const statSrc = (await fsp.stat(path.join(SRCDIR, r.name))).size;
      const stem = r.name.replace(/\.[^.]+$/, '');
      const statOut = realOut[stem];
      console.log(`  ${r.name.padEnd(18)} ${String(r.size).padEnd(12)} ${String(statSrc).padEnd(12)} ${String(r.outputSize).padEnd(12)} ${String(statOut)}`);
      check(r.size === statSrc, `${r.name}: STORED source size === fsp.stat (${r.size} vs ${statSrc})`);
      check(r.outputSize === statOut, `${r.name}: STORED output size === fsp.stat of real output (${r.outputSize} vs ${statOut})`);
      sumSrcStat += statSrc; sumOutStat += statOut; sumReclaim += (statSrc - statOut);
    }
    check(stored.length === 3 && stored.every((r) => r.status === 'done'), `all 3 files done (got ${stored.map((r) => r.status).join(',')})`);
    // Lifetime/run aggregate must equal the summed REAL stat reclaim.
    check(lifetimeCredit && lifetimeCredit.addedBytes === sumReclaim,
      `lifetime reclaimed === Σ(real source stat − real output stat) (${lifetimeCredit && lifetimeCredit.addedBytes} vs ${sumReclaim})`);
    console.log(`  AGGREGATE  Σsrc=${sumSrcStat}  Σout=${sumOutStat}  Σreclaim=${sumReclaim}  lifetimeCredit=${lifetimeCredit && lifetimeCredit.addedBytes}`);
  } else if (MODE === 'skiplive') {
    // BUG 2 LIVE — skip a file in a LATER batch AFTER Start, while earlier batches run.
    const f1 = path.join(SRCDIR, 'B1'); const f2 = path.join(SRCDIR, 'B2'); const f3 = path.join(SRCDIR, 'B3');
    for (const d of [f1, f2, f3]) await fsp.mkdir(d, { recursive: true });
    await fsp.copyFile(SMALL_CLIP, path.join(f1, 'b1only.mov'));
    await fsp.copyFile(SMALL_CLIP, path.join(f2, 'b2only.mov'));
    await fsp.copyFile(SMALL_CLIP, path.join(f3, 'keep3.mov'));
    await fsp.copyFile(SMALL_CLIP, path.join(f3, 'skip3.mov'));
    const skip3path = path.join(f3, 'skip3.mov');
    await run(`stageSource(${JSON.stringify(f1)})`); await wait(700);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(250);
    await run(`addCurrentToQueue(); true;`); await wait(250);
    await run(`stageSource(${JSON.stringify(f2)})`); await wait(700);
    await run(`addCurrentToQueue(); true;`); await wait(250);
    await run(`stageSource(${JSON.stringify(f3)})`); await wait(700);
    await run(`addCurrentToQueue(); true;`); await wait(250);
    // Start, THEN skip skip3 in batch 3 while batch 1 is encoding.
    await run(`document.getElementById('start').click(); true;`);
    await wait(120);
    const clicked = await run(`(() => {
      const b3 = document.querySelectorAll('.qbatch')[2];
      const row = b3 && [...b3.querySelectorAll('.qrow')].find(r => /skip3/.test(r.textContent));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`);
    check(clicked === true, 'skip3 was toggled AFTER Start, while batch 1 ran');
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    const startedSkip3 = progressEvents.some((p) => p.type === 'file-start' && p.file === skip3path);
    const anySkip3 = progressEvents.some((p) => p.file === skip3path);
    console.log('  RESULT', JSON.stringify({ outs, startedSkip3, anySkip3, statuses: batchStatuses.map(s => ({ id: s.id, st: s.status })) }));
    check(!outs.some((f) => /skip3/i.test(f)), `skipped-after-start file produced NO output (BUG 2) — outputs: [${outs.join(', ')}]`);
    check(!startedSkip3 && !anySkip3, 'skipped file spawned NO encoder (no file-start / no progress event for it)');
    check(outs.some((f) => /keep3/i.test(f)), 'the kept file in batch 3 still encoded');
    check(outs.some((f) => /b1only/i.test(f)) && outs.some((f) => /b2only/i.test(f)), 'earlier batches encoded');
    const term3 = batchStatuses.filter((s) => s.id === 3 || /3/.test(String(s.id))).slice(-1)[0];
    check(batchStatuses.some((s) => /Done/.test(s.status)), `batch 3 completed Done (statuses seen)`);
  } else if (MODE === 'skipadvance' || MODE === 'skipthree') {
    // LIVE auto-advance repro: a MIDDLE batch (03) contains a skipped file; the
    // queue must AUTO-ADVANCE to batch 04 with no user action.
    //   skipadvance — 4 FOLDER batches, skip a file in batch 03 (matches the
    //                 IMG_0238 live report).
    //   skipthree   — batch 03 ends with done + failed + skipped files (file-list:
    //                 keep3 done, ghost3 source-removed → failed, skip3 skipped).
    let skip3path;
    if (MODE === 'skipadvance') {
      const dirs = ['B1', 'B2', 'B3', 'B4'].map((d) => path.join(SRCDIR, d));
      for (const d of dirs) await fsp.mkdir(d, { recursive: true });
      await fsp.copyFile(SMALL_CLIP, path.join(dirs[0], 'b1only.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(dirs[1], 'b2only.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(dirs[2], 'keep3.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(dirs[2], 'skip3.mov'));
      await fsp.copyFile(SMALL_CLIP, path.join(dirs[3], 'b4only.mov'));
      skip3path = path.join(dirs[2], 'skip3.mov');
      await run(`stageSource(${JSON.stringify(dirs[0])})`); await wait(600);
      await run(`document.getElementById('choose-dest').click(); true;`); await wait(200);
      await run(`addCurrentToQueue(); true;`); await wait(200);
      for (const d of dirs.slice(1)) { await run(`stageSource(${JSON.stringify(d)})`); await wait(600); await run(`addCurrentToQueue(); true;`); await wait(200); }
    } else {
      // file-list batches; batch 03 = keep3 + skip3 + ghost3(removed before start)
      const a1 = await mk('adv_a1.mov'), a2 = await mk('adv_a2.mov');
      const keep3 = await mk('keep3.mov'); skip3path = await mk('skip3.mov'); const ghost3 = await mk('ghost3.mov');
      const a4 = await mk('adv_a4.mov');
      BATCH_FILES = [[a1], [a2], [keep3, skip3path, ghost3], [a4]];
      for (let bi = 0; bi < 4; bi++) {
        await run(`document.getElementById('dz-browse').click(); true;`); await wait(700);
        if (bi === 0) { await run(`document.getElementById('choose-dest').click(); true;`); await wait(200); }
        await run(`document.getElementById('add-to-queue').click(); true;`); await wait(250);
      }
      await fsp.rm(ghost3, { force: true });   // batch 03 will end done+failed+skipped
    }
    // Start, THEN skip skip3 in batch 03 while earlier batches run.
    await run(`document.getElementById('start').click(); true;`);
    await wait(140);
    const clicked = await run(`(() => {
      const b3 = document.querySelectorAll('.qbatch')[2];
      const row = b3 && [...b3.querySelectorAll('.qrow')].find(r => /skip3/.test(r.textContent));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`);
    check(clicked === true, 'skip3 toggled AFTER Start in the MIDDLE batch (03), earlier batches running');
    for (let k = 0; k < 150 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    const ran4 = progressEvents.some((p) => p.type === 'file-start' && /b4only|adv_a4/.test(p.file || ''));
    const b4out = outs.some((f) => /b4only|adv_a4/i.test(f));
    const order = batchStatuses.filter((s) => /Running/.test(s.status)).map((s) => s.id);
    // Renderer DOM end-state: pills + whether Start is showing (a display halt
    // would leave batch 04 "Queued" + Start visible even though main ran it).
    const dom = await run(`(() => ({
      pills: [...document.querySelectorAll('.qbatch')].map(b => b.querySelector('.qbatch-status .pill')?.textContent.trim()),
      startShown: !document.getElementById('start').classList.contains('hidden'),
      b3rows: [...(document.querySelectorAll('.qbatch')[2]?.querySelectorAll('.qrow') || [])].map(r => ({ n: r.textContent.replace(/\\s+/g,' ').slice(0,18), s: r.querySelector('.status .pill')?.textContent.trim() }))
    }))()`);
    console.log('  RESULT', JSON.stringify({ outs, ran4, b4out, dom, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(!outs.some((f) => /skip3/i.test(f)), `skipped middle-batch file produced NO output — outputs: [${outs.join(', ')}]`);
    // THE BUG: queue must auto-advance PAST the skip batch to batch 04.
    check(b4out && ran4, 'queue AUTO-ADVANCED past the skip batch — batch 04 ran unattended (THE BUG)');
    check(order.length === 4, `all four batches went Running in order (got Running ids: [${order.join(',')}])`);
    check(lastFinished != null, 'queue-finished fired (run reached a clean end)');
    // Renderer must SHOW batch 04 as finished (not stuck Queued) — display-halt guard.
    check(dom.pills.length === 4 && /Done/i.test(dom.pills[3] || ''),
      `renderer shows batch 04 finished, not stuck Queued (pills: ${JSON.stringify(dom.pills)})`);
    check(/Done/i.test(dom.pills[2] || ''), `renderer shows batch 03 (the skip batch) Done (pill: ${dom.pills[2]})`);
    if (MODE === 'skipthree') {
      const term3 = batchStatuses.filter((s) => s.id === 3).slice(-1)[0];
      check(term3 && /with failures/.test(term3.status || ''), `batch 03 ended done+failed+skipped (got ${term3 && term3.status})`);
      check(outs.some((f) => /keep3/i.test(f)) && !outs.some((f) => /ghost3/i.test(f)), 'batch 03: kept file done, removed file failed (no output)');
    }
  } else if (MODE === 'allskipped') {
    // A MIDDLE batch with ALL files skipped must not get silently dropped + left
    // stuck Queued — it must show Done and the queue must advance to batch 3.
    BATCH_FILES = [[await mk('as_a1.mov')], [await mk('only2.mov')], [await mk('as_a3.mov')]];
    for (let bi = 0; bi < 3; bi++) {
      await run(`document.getElementById('dz-browse').click(); true;`); await wait(700);
      if (bi === 0) { await run(`document.getElementById('choose-dest').click(); true;`); await wait(200); }
      await run(`document.getElementById('add-to-queue').click(); true;`); await wait(250);
    }
    // Skip the ONLY file in batch 02 → batch 02 is all-skipped.
    const sk = await run(`(() => {
      const b2 = document.querySelectorAll('.qbatch')[1];
      const btn = b2 && b2.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`); await wait(250);
    check(sk === true, 'batch 02 single file skipped → batch is all-skipped');
    await run(`document.getElementById('start').click(); true;`);
    for (let k = 0; k < 120 && !lastFinished; k++) await wait(700);

    const outs = outFiles();
    const pills = await run(`[...document.querySelectorAll('.qbatch')].map(b => b.querySelector('.qbatch-status .pill')?.textContent.trim())`);
    console.log('  RESULT', JSON.stringify({ outs, pills, statuses: batchStatuses.map((s) => ({ id: s.id, st: s.status })) }));
    check(!outs.some((f) => /only2/i.test(f)), 'all-skipped batch produced NO output');
    check(pills.length === 3 && /Done/i.test(pills[1] || ''), `all-skipped batch 02 shows Done, not stuck Queued (pills: ${JSON.stringify(pills)})`);
    check(outs.some((f) => /as_a3/i.test(f)) && /Done/i.test(pills[2] || ''), 'queue advanced to batch 03 after the all-skipped batch');
    check(lastFinished != null, 'queue-finished fired');
  } else if (MODE === 'skipui') {
    /* v2.8.0 spec — live skip: within the RUNNING batch only the row that is
       CURRENTLY ENCODING lacks the skip control; its still-queued rows and
       every waiting-batch row expose one. (v2.7.1 hid it on the whole running
       batch; the live-skip feature reverses that for queued rows.) */
    BATCH_FILES = [[await mkLong('r1a.mov'), await mk('r1b.mov')], [await mk('w2a.mov')]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    // r1a (long clip) encoding, r1b still queued, batch 2 waiting.
    check((await waitRow('r1a', ['running'])) === 'running', 'probe: r1a row reached running');
    const probe = await run(`(() => {
      const bs = [...document.querySelectorAll('.qbatch')];
      const pill = (b) => b.querySelector('.qbatch-status .pill')?.textContent.trim();
      const rowBtn = (b, part) => {
        const row = [...b.querySelectorAll('.qrow')].find((r) => r.textContent.includes(part));
        return row ? row.querySelectorAll('.qrow-skip-btn').length : -1;
      };
      return {
        pills: bs.map(pill),
        encodingRowBtns: rowBtn(bs[0], 'r1a.mov'),
        queuedRowBtns: rowBtn(bs[0], 'r1b.mov'),
        waitingRowBtns: rowBtn(bs[1], 'w2a.mov')
      };
    })()`);
    console.log('  RESULT', JSON.stringify(probe));
    check(/Running/i.test(probe.pills[0] || ''), `batch 1 pill is Running (got ${probe.pills[0]})`);
    check(probe.encodingRowBtns === 0,
      `the CURRENTLY ENCODING row exposes no skip control (got ${probe.encodingRowBtns})`);
    check(probe.queuedRowBtns === 1,
      `the running batch's QUEUED row exposes the skip control (got ${probe.queuedRowBtns})`);
    check(probe.waitingRowBtns === 1,
      `the WAITING batch's row keeps its skip control (got ${probe.waitingRowBtns})`);
    for (let k = 0; k < 240 && !lastFinished; k++) await wait(700);
    check(lastFinished != null, 'queue-finished fired');
  } else if (MODE === 'liveskip') {
    /* v2.8.0 — skip a not-yet-started file of the RUNNING batch: consulted at
       the file boundary, so it is never staged into an encode. FAILS pre-fix:
       the running batch's rows have no skip control at all. */
    BATCH_FILES = [[await mkLong('l1.mov'), await mk('l2.mov'), await mk('skip3.mov')]];
    const skip3orig = path.join(SRCDIR, 'skip3.mov');
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    check((await waitRow('l1', ['running'])) === 'running', 'l1 (long clip) is encoding');
    const clicked = await run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('skip3'));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`);
    check(clicked === true, 'skip control clicked on skip3 while the batch RUNS');
    for (let k = 0; k < 240 && !lastFinished; k++) await wait(700);
    const outs = outFiles();
    const startedSkip3 = progressEvents.some((p) => p.type === 'file-start' && p.file === skip3orig);
    const rowPill = await run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('skip3'));
      return row ? row.querySelector('.status .pill')?.textContent.trim() : null;
    })()`);
    const counts = await run(`(() => { let s = 0; for (const b of queue) for (const f of b.files) if (f.status === 'skipped') s++; return s; })()`);
    const batchPill = await run(`document.querySelector('.qbatch-status .pill')?.textContent.trim()`);
    console.log('  RESULT', JSON.stringify({ outs, startedSkip3, rowPill, counts, batchPill }));
    check(!outs.some((f) => /skip3/i.test(f)), `live-skipped file has NO output on disk — outputs: [${outs.join(', ')}]`);
    check(startedSkip3 === false, 'live-skipped file never emitted a real file-start');
    check(rowPill === 'Skipped', `row resolves to Skipped (got ${rowPill})`);
    check(counts === 1, `summary skip count includes it (got ${counts})`);
    check(/Done/i.test(batchPill || ''), `batch ends Done (got ${batchPill})`);
    check(outs.some((f) => /l1/i.test(f)) && outs.some((f) => /l2/i.test(f)), 'the kept files encoded');
  } else if (MODE === 'unskip') {
    /* v2.8.0 — skip then UN-skip a running batch's file before its turn: the
       live set converges and the file IS encoded. FAILS pre-fix: no controls. */
    BATCH_FILES = [[await mkLong('u1.mov'), await mk('u2.mov'), await mk('u3flip.mov')]];
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    check((await waitRow('u1', ['running'])) === 'running', 'u1 (long clip) is encoding');
    const clickRow = (part) => run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes(${JSON.stringify(part)}));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`);
    const skippedClick = await clickRow('u3flip'); await wait(300);
    const midStatus = await run(`queue[0].files.find((f) => f.name.includes('u3flip')).status`);
    const unskipClick = await clickRow('u3flip'); await wait(300);
    const backStatus = await run(`queue[0].files.find((f) => f.name.includes('u3flip')).status`);
    check(skippedClick === true && midStatus === 'skipped', `skip toggled ON mid-run (clicked=${skippedClick}, status=${midStatus})`);
    check(unskipClick === true && backStatus === 'queued', `skip toggled OFF (un-skip) mid-run (clicked=${unskipClick}, status=${backStatus})`);
    for (let k = 0; k < 240 && !lastFinished; k++) await wait(700);
    const outs = outFiles();
    const rowPill = await run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('u3flip'));
      return row ? row.querySelector('.status .pill')?.textContent.trim() : null;
    })()`);
    console.log('  RESULT', JSON.stringify({ outs, rowPill }));
    check(outs.some((f) => /u3flip/i.test(f)), `un-skipped file WAS encoded — outputs: [${outs.join(', ')}]`);
    check(/Done/.test(rowPill || ''), `un-skipped row ends Done (got ${rowPill})`);
  } else if (MODE === 'skiprace') {
    /* v2.8.0 lost-race rule — the skip lands AFTER the pipeline passed the
       file's boundary check (its file-start already fired main-side). The
       pipeline is ground truth: the row must flip back to running and end
       Done with a REAL output; the skips set converges. Reproduced
       deterministically: HOLD raceMe's file-start at the harness boundary,
       click skip while the renderer still shows the row queued, release.
       FAILS on the naive implementation: row stuck Skipped while the output
       exists on disk (the exact lie 2.7.1 fixed, recreated). */
    BATCH_FILES = [[await mk('r1.mov'), await mk('raceMe.mov')]];
    let heldEvent = null;
    let heldDone = null;
    interceptSend = (ch, p) => {
      if (ch === 'progress' && p && p.type === 'file-start' && /raceMe/.test(p.basename || '') && !heldEvent) {
        heldEvent = p;
        return true;   // hold: renderer does not yet know raceMe started
      }
      /* Also hold raceMe's file-done so the "flipped back to running" sample
         is deterministic (a tiny clip finishes in under the sampling wait). */
      if (ch === 'progress' && p && p.type === 'file-done' && /raceMe/.test(p.basename || '') && !heldDone) {
        heldDone = p;
        return true;
      }
      return false;
    };
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    await run(`document.getElementById('start').click(); true;`);
    // Wait until the pipeline actually reached raceMe's boundary (event held).
    for (let k = 0; k < 200 && !heldEvent; k++) await wait(100);
    check(heldEvent != null, 'harness holds raceMe file-start (pipeline passed its boundary)');
    const clicked = await run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find((r) => r.textContent.includes('raceMe'));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`); await wait(250);
    check(clicked === true, 'skip clicked while raceMe already encodes (row still showed queued)');
    const midStatus = await run(`queue[0].files.find((f) => f.name.includes('raceMe')).status`);
    check(midStatus === 'skipped', `renderer provisionally shows Skipped (got ${midStatus})`);
    // Release the held file-start — ground truth arrives. file-done is still
    // held, so the row must read exactly 'running' at this sample.
    rawSend('progress', heldEvent);
    await wait(300);
    const afterStart = await run(`queue[0].files.find((f) => f.name.includes('raceMe')).status`);
    // Wait for the encode to finish (its file-done gets captured), then stop
    // intercepting and forward it so the row resolves normally.
    for (let k = 0; k < 300 && !heldDone; k++) await wait(100);
    interceptSend = null;
    if (heldDone) rawSend('progress', heldDone);
    for (let k = 0; k < 240 && !lastFinished; k++) await wait(700);
    const outs = outFiles();
    const fin = await run(`(() => { const f = queue[0].files.find((x) => x.name.includes('raceMe')); return { status: f.status, outputSize: f.outputSize }; })()`);
    const skipsPruned = !(rt(1).skips instanceof Set) || !rt(1).skips.has(path.join(SRCDIR, 'raceMe.mov'));
    console.log('  RESULT', JSON.stringify({ afterStart, fin, outs, skipsPruned }));
    check(afterStart === 'running', `held file-start flips the provisional row back to running (got ${afterStart})`);
    check(outs.some((f) => /raceMe/i.test(f)), `raceMe output EXISTS on disk — outputs: [${outs.join(', ')}]`);
    check(fin.status === 'done' && Number.isFinite(fin.outputSize) && fin.outputSize > 0,
      `row ends Done with a real output size (got ${fin.status}/${fin.outputSize})`);
    check(skipsPruned === true, 'skips set converged (raceMe pruned + re-pushed)');
  } else if (MODE === 'terminaldone') {
    /* v2.7.1 regression — a row in a TERMINAL status must never be overwritten
       by exact-path file-start/file-done events (pre-fix: the exact-path
       findIndex had no isTerminalFileStatus guard, so a skipped row flipped
       Running and then Done + output size when the engine encoded it anyway).
       Pure renderer test: events are injected, no encode runs. */
    BATCH_FILES = [[await mk('keepA.mov'), await mk('skipMe.mov')]];
    const skipPath = path.join(SRCDIR, 'skipMe.mov');
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(900);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(300);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(350);
    const sk = await run(`(() => {
      const row = [...document.querySelectorAll('.qrow')].find(r => /skipMe/.test(r.textContent));
      const btn = row && row.querySelector('.qrow-skip-btn');
      if (btn) { btn.click(); return true; } return false;
    })()`); await wait(250);
    check(sk === true, 'setup: skipMe row skipped before Start');
    const rowState = () => run(`queue[0].files.find(f => /skipMe/.test(f.name)) && (() => { const f = queue[0].files.find(f => /skipMe/.test(f.name)); return { status: f.status, outputSize: f.outputSize }; })()`);
    const before = await rowState();
    check(before && before.status === 'skipped', `setup: row is terminal 'skipped' (got ${before && before.status})`);
    // Simulate the engine encoding it anyway (the pre-fix reality): Running
    // batch + exact-path file-start, then exact-path file-done with a size.
    send('batch-status', { id: 1, status: 'Running' });
    await wait(150);
    send('progress', { type: 'file-start', file: skipPath, basename: 'skipMe.mov', index: 1, total: 2 });
    await wait(150);
    const afterStart = await rowState();
    check(afterStart && afterStart.status === 'skipped',
      `terminal row NOT flipped by exact-path file-start (got ${afterStart && afterStart.status})`);
    send('progress', { type: 'file-done', file: skipPath, basename: 'skipMe.mov', index: 1, total: 2,
      outcome: 'ok', outBytes: 42000, inBytes: 56079, processed: 1, failed: 0, alreadyDone: 0, reclaimed: 14000 });
    await wait(150);
    const afterDone = await rowState();
    check(afterDone && afterDone.status === 'skipped',
      `terminal row NOT overwritten by exact-path file-done (got ${afterDone && afterDone.status})`);
    check(afterDone && afterDone.outputSize == null,
      `terminal row gained NO output size (got ${afterDone && afterDone.outputSize})`);
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
