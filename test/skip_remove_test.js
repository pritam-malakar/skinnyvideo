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

   Run:  MODE=<mode> ./node_modules/.bin/electron test/skip_remove_test.js
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
const progressEvents = []; // every forwarded progress event (for file-start spawn proxy)
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
const send = (ch, p) => {
  if (ch === 'batch-status') batchStatuses.push(p);
  if (ch === 'queue-finished') lastFinished = p;
  if (ch === 'progress') progressEvents.push(p);
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
  }

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  await fsp.rm(SRCDIR, { recursive: true, force: true });
  console.log('\n[' + MODE + '] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
