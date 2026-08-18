/* Repo regression (v2.10.0): HISTORY — one row per completed real run.

   Runs on the REAL GUI path: loads src/renderer/index.html with the real
   preload and the real renderer, stages + adds batches through the real add
   flow, then drives them to terminal state with the SAME 'batch-status' /
   'progress' events main sends during a run. The main side is real too — the
   test's add-reclaimed / get-history handlers call the REAL appendHistoryEntry
   and readHistory from src/main/history-store against a plain store object,
   and reveal goes through the REAL stat-gated revealFolder in src/main/reveal
   (only shell.showItemInFolder is spied, so the gate runs against real disk).

   Asserts:
     (a) a completed real batch appends ONE correct entry, field by field,
         including the post-rename batch name;
     (b) a dry run appends nothing;
     (c) a batch that finishes with zero done files appends nothing;
     (d) the 50 cap holds, newest first, oldest dropped;
     (e) the section is hidden until the first entry and visible after;
     (f) the expander shows 5 → all → 5;
     (g) Reveal on a live run folder opens it; on a deleted one it shows the
         non-blocking notice and never reaches Finder.

   Run:  ./node_modules/.bin/electron test/history_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { appendHistoryEntry, readHistory, HISTORY_CAP } = require(path.join(ROOT, 'src/main/history-store'));
const { revealFolder } = require(path.join(ROOT, 'src/main/reveal'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const header = (t) => console.log('\n==== ' + t + ' ====');

const WORK = path.join(os.tmpdir(), 'squeeze-history-' + process.pid);
const DEST = path.join(WORK, 'out');
const LIVE_RUNDIR = path.join(DEST, 'Compressed_2026-08-18_0942');
const DEAD_RUNDIR = path.join(DEST, 'Compressed_2026-08-18_1130');

/* ── main-side store: REAL append/read logic over a plain object ── */
const store = {};
const revealCalls = [];

let nextFiles = [];      // what the browse picker returns for the next stage
let nextSizes = [];      // parallel source sizes

ipcMain.handle('app-version', async () => '2.10.0-test');
ipcMain.handle('browse-source-files', async () => nextFiles.slice());
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: nextFiles[0], ignored: 0,
  totalSize: nextSizes.reduce((a, b) => a + b, 0),
  videos: nextFiles.map((f, i) => ({ file: f, basename: f.split('/').pop(), size: nextSizes[i] }))
}));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async () => ({ isFile: false, isDirectory: true }));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-lifetime-drives', async () => []);

// The two channels under test — REAL logic, no re-implementation.
ipcMain.handle('add-reclaimed', async (_e, payload) => {
  if (!payload || !payload.dest) return null;
  const filesAdded = Math.max(0, Math.floor(payload.filesAdded || 0));
  if (filesAdded === 0) return null;             // mirrors main's ledger gate
  appendHistoryEntry(store, payload.historyEntry, STAMP_AT);
  return { ok: true };
});
ipcMain.handle('get-history', async () => readHistory(store));
ipcMain.handle('reveal-folder', async (_e, p) =>
  revealFolder(p, { reveal: (x) => revealCalls.push(x) }));   // real fsp.stat gate

let STAMP_AT = Date.now();   // main stamps `at`; fixed per append so we can assert it

['save-last-src', 'delete-orphans', 'open-path', 'reveal-path', 'reveal-in-finder',
 'reset-drive', 'pause-batch', 'resume-batch', 'cancel-batch', 'stop-queue',
 'start-queue', 'enqueue-batch', 'remove-batch', 'set-batch-skips', 'scan-source',
 'browse-source', 'get-tier-defaults']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  fs.mkdirSync(DEST, { recursive: true });
  fs.mkdirSync(LIVE_RUNDIR, { recursive: true });
  fs.mkdirSync(DEAD_RUNDIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1280, height: 1000, show: false, backgroundColor: '#111111',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false }
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => {
    if (/error|is not defined|undefined/i.test(m)) errs.push(m);
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));

  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };
  await wait(450);

  const sectionState = () => run(`(() => {
    const s = document.getElementById('history-section');
    const rows = [...document.querySelectorAll('#history-list .hs-row')];
    const foot = document.querySelector('#history-list .hs-foot .hs-more');
    return {
      hidden: s.classList.contains('hidden'),
      hint: document.getElementById('history-count').textContent,
      rows: rows.length,
      footText: foot ? foot.textContent : null,
      labels: rows.map(r => r.querySelector('.hs-label').textContent),
      metas:  rows.map(r => r.querySelector('.hs-meta').textContent),
      tiers:  rows.map(r => r.querySelector('.hs-tier').className + '|' + r.querySelector('.hs-tier').textContent),
      amounts: rows.map(r => r.querySelector('.hs-reclaimed').textContent),
      deltas:  rows.map(r => r.querySelector('.hs-delta').textContent),
      reveals: rows.map(r => !!r.querySelector('.hs-reveal'))
    };
  })()`);

  /* Stage + add one batch through the real UI flow. */
  const addBatch = async ({ files, sizes, tier, dry = false }) => {
    nextFiles = files; nextSizes = sizes;
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(220);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(420);
    await run(`(() => { const r = document.querySelector('input[name="tier"][value="${tier}"]');
                        r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })(); true;`);
    await wait(80);
    const isDry = await run(`document.getElementById('dry-run').getAttribute('aria-pressed') === 'true'`);
    if (isDry !== dry) { await run(`document.getElementById('dry-run').click(); true;`); await wait(120); }
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
    return run(`queue[queue.length - 1].id`);
  };

  /* Drive a queued batch to terminal, exactly as a real run does. */
  const runBatchTo = async (id, outcomes, result) => {
    send('batch-status', { id, status: 'Running' });
    await wait(120);
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      send('progress', { type: 'file-start', index: i + 1, total: outcomes.length, file: o.file, basename: o.file.split('/').pop() });
      await wait(40);
      send('progress', {
        type: 'file-done', index: i + 1, total: outcomes.length,
        file: o.file, basename: o.file.split('/').pop(),
        outBytes: o.outBytes, outcome: o.outcome,
        reclaimed: 0, processed: 0, failed: 0, alreadyDone: 0, elapsedMs: 10
      });
      await wait(60);
    }
    send('batch-status', { id, status: 'Done', result });
    await wait(320);
  };

  // ───────────────────────────────────────────────────────────────────────
  header('(e) hidden until the first entry exists');
  const empty = await sectionState();
  check(empty.hidden === true, 'History section starts hidden with an empty store');
  check(empty.rows === 0 && empty.hint === '', 'no rows, no count hint while empty');

  // ───────────────────────────────────────────────────────────────────────
  header('(a) a completed real batch appends one correct entry');
  const A = ['/fake/a1.mov', '/fake/a2.mov', '/fake/a3.mov', '/fake/a4.mov'];
  const ASZ = [4_000_000, 6_000_000, 2_500_000, 1_000_000];
  STAMP_AT = 1_755_500_000_000;
  const idA = await addBatch({ files: A, sizes: ASZ, tier: 'regular' });
  // Inline rename BEFORE the run finishes — the entry must carry the new name.
  await run(`(() => { const b = queue.find(q => q.id === ${idA}); b.srcName = 'Wedding rushes'; renderQueue(); })(); true;`);
  await wait(120);
  await runBatchTo(idA, [
    { file: A[0], outBytes: 1_500_000, outcome: 'ok' },      // done  4.0M → 1.5M
    { file: A[1], outBytes: 2_000_000, outcome: 'ok' },      // done  6.0M → 2.0M
    { file: A[2], outBytes: null,      outcome: 'fail' },    // failed
    { file: A[3], outBytes: 900_000,   outcome: 'skip-exists' } // 'existed' → skipped
  ], { runDir: LIVE_RUNDIR, logPath: path.join(LIVE_RUNDIR, 'compress.log'), processed: 2, failed: 1, reclaimed: 6_500_000 });

  check(store.history && store.history.length === 1, `exactly one entry appended (got ${store.history ? store.history.length : 0})`);
  const e0 = (store.history || [])[0] || {};
  check(e0.at === STAMP_AT, `at is stamped by main (got ${e0.at})`);
  check(e0.name === 'Wedding rushes', `name is the batch name AT TERMINAL TIME, post-rename (got ${JSON.stringify(e0.name)})`);
  check(e0.tier === 'regular', `tier is the internal key, not a label (got ${JSON.stringify(e0.tier)})`);
  check(e0.files === 2, `files = done count only (got ${e0.files})`);
  check(e0.failed === 1, `failed = 1 (got ${e0.failed})`);
  check(e0.skipped === 1, `skipped counts the already-present file (got ${e0.skipped})`);
  check(e0.before === 10_000_000, `before = source bytes of DONE files only (got ${e0.before})`);
  check(e0.after === 3_500_000, `after = output bytes of DONE files only (got ${e0.after})`);
  check(e0.reclaimed === 6_500_000, `reclaimed = before − after (got ${e0.reclaimed})`);
  check(e0.runDir === LIVE_RUNDIR, `runDir carried from lastResult (got ${e0.runDir})`);
  check(Object.keys(e0).sort().join(',') === 'after,at,before,failed,files,name,reclaimed,runDir,skipped,tier',
    `entry holds exactly the documented keys (got ${Object.keys(e0).sort().join(',')})`);

  const shown = await sectionState();
  check(shown.hidden === false, '(e) section becomes visible once an entry exists');
  check(shown.rows === 1 && shown.hint === '1 batch', `one row, hint is exactly "1 batch" (rows=${shown.rows}, hint=${JSON.stringify(shown.hint)})`);
  /* An entry is one BATCH, not one run — a single Start over three batches
     lands three entries. The hint must never say "run"/"runs" again. */
  check(!/runs?\b/i.test(shown.hint), `singular hint carries no "run" wording (got ${JSON.stringify(shown.hint)})`);
  check(shown.labels[0] === 'Wedding rushes', 'row shows the run name');
  check(/2 videos/.test(shown.metas[0]), `meta names the video count (got ${JSON.stringify(shown.metas[0])})`);
  check(shown.tiers[0] === 'hs-tier regular|Make It Fast',
    `tier chip uses TIER_CSS + TIER_LABEL (got ${JSON.stringify(shown.tiers[0])})`);
  check(/→/.test(shown.deltas[0]), `before → after sub-line present (got ${JSON.stringify(shown.deltas[0])})`);
  check(shown.reveals[0] === true, 'a run with a folder gets a Reveal button');

  // ───────────────────────────────────────────────────────────────────────
  header('(b) a dry run appends nothing');
  const before_b = store.history.length;
  const B = ['/fake/b1.mov', '/fake/b2.mov'];
  const idB = await addBatch({ files: B, sizes: [3_000_000, 3_000_000], tier: 'preserve', dry: true });
  const dryFlag = await run(`queue.find(q => q.id === ${idB}).dryRun`);
  check(dryFlag === true, 'batch was queued with dryRun frozen true');
  await runBatchTo(idB, [
    { file: B[0], outBytes: 1_000_000, outcome: 'ok' },
    { file: B[1], outBytes: 1_000_000, outcome: 'ok' }
  ], { runDir: null, processed: 0, failed: 0, reclaimed: 0 });
  check(store.history.length === before_b, `dry run left the ledger untouched (${before_b} → ${store.history.length})`);

  // ───────────────────────────────────────────────────────────────────────
  header('(c) a batch with zero done files appends nothing');
  const before_c = store.history.length;
  const C = ['/fake/c1.mov', '/fake/c2.mov'];
  const idC = await addBatch({ files: C, sizes: [5_000_000, 5_000_000], tier: 'regular', dry: false });
  await runBatchTo(idC, [
    { file: C[0], outBytes: null, outcome: 'fail' },
    { file: C[1], outBytes: null, outcome: 'fail' }
  ], { runDir: path.join(DEST, 'Compressed_2026-08-18_1200'), processed: 0, failed: 2, reclaimed: 0 });
  const doneC = await run(`queue.find(q => q.id === ${idC}).status`);
  check(doneC === 'done' || doneC === 'failed', `batch reached a terminal state (${doneC})`);
  check(store.history.length === before_c, `zero done files → no entry (${before_c} → ${store.history.length})`);

  // ───────────────────────────────────────────────────────────────────────
  header('(d) the cap holds at 50, newest first');
  const capStore = {};
  for (let i = 1; i <= 55; i++) {
    appendHistoryEntry(capStore, {
      name: `run ${i}`, tier: 'regular', files: 1, failed: 0, skipped: 0,
      before: 100, after: 40, reclaimed: 60, runDir: `/x/Compressed_${i}`
    }, 1_700_000_000_000 + i);
  }
  check(HISTORY_CAP === 50, `cap constant is 50 (got ${HISTORY_CAP})`);
  check(capStore.history.length === 50, `55 appends → 50 stored (got ${capStore.history.length})`);
  check(capStore.history[0].name === 'run 55', `newest is first (got ${capStore.history[0].name})`);
  check(capStore.history[49].name === 'run 6', `oldest kept is run 6 — runs 1-5 dropped (got ${capStore.history[49].name})`);
  check(capStore.history.every((e, i, a) => i === 0 || a[i - 1].at >= e.at), 'stored order is strictly newest → oldest');

  // ───────────────────────────────────────────────────────────────────────
  header('(f) expander: 5 → all → 5');
  // Seed the real store with 7 entries (the live one plus six), then refresh
  // through the renderer's own fetch path.
  const seeded = { history: [] };
  for (let i = 1; i <= 7; i++) {
    appendHistoryEntry(seeded, {
      name: `Seeded run ${i}`, tier: i % 2 ? 'regular' : 'preserve', files: i, failed: 0, skipped: 0,
      before: 1_000_000 * i, after: 400_000 * i, reclaimed: 600_000 * i,
      runDir: i === 1 ? DEAD_RUNDIR : LIVE_RUNDIR
    }, 1_755_000_000_000 + i * 1000);
  }
  store.history = seeded.history;
  await run(`refreshHistory(); true;`); await wait(250);

  const compact = await sectionState();
  check(compact.rows === 5, `compact view shows 5 of 7 (got ${compact.rows})`);
  check(compact.hint === '7 batches', `hint is exactly "7 batches" — counts ALL entries, not the visible 5 (got ${JSON.stringify(compact.hint)})`);
  check(!/runs?\b/i.test(compact.hint), `plural hint carries no "run" wording (got ${JSON.stringify(compact.hint)})`);
  check(compact.footText === 'Show all (7)', `foot control reads "Show all (7)" (got ${JSON.stringify(compact.footText)})`);
  check(compact.labels[0] === 'Seeded run 7', `newest first in the UI too (got ${compact.labels[0]})`);
  check(compact.tiers.some(t => /archival\|Slow But Better/.test(t)), 'preserve rows render the violet "Slow But Better" chip');

  await run(`document.getElementById('history-toggle').click(); true;`); await wait(220);
  const expanded = await sectionState();
  check(expanded.rows === 7, `expanded shows all 7 (got ${expanded.rows})`);
  check(expanded.footText === 'Show less', `foot flips to "Show less" (got ${JSON.stringify(expanded.footText)})`);

  await run(`document.getElementById('history-toggle').click(); true;`); await wait(220);
  const recompact = await sectionState();
  check(recompact.rows === 5, `collapses back to 5 (got ${recompact.rows})`);
  check(recompact.footText === 'Show all (7)', 'foot label returns to "Show all (7)"');

  // Ephemeral: a fresh fetch must come back compact, never remembering.
  await run(`document.getElementById('history-toggle').click(); true;`); await wait(200);
  await run(`historyExpanded = false; refreshHistory(); true;`); await wait(220);
  const relaunch = await sectionState();
  check(relaunch.rows === 5, `expansion is not persisted — a fresh render is compact (got ${relaunch.rows})`);

  // ───────────────────────────────────────────────────────────────────────
  header('(g) Reveal: live folder opens, deleted folder warns');
  const clickReveal = (idx) => run(
    `(() => { const b = document.querySelectorAll('#history-list .hs-row')[${idx}].querySelector('.hs-reveal');
       if (!b) return false; b.click(); return true; })()`);

  revealCalls.length = 0;
  check(await clickReveal(0), 'row 0 has a Reveal button to click');
  await wait(300);
  check(revealCalls.length === 1 && revealCalls[0] === LIVE_RUNDIR,
    `live run folder → reveal invoked with the run folder (got ${JSON.stringify(revealCalls)})`);

  // Delete the folder behind the LAST row (Seeded run 1 → DEAD_RUNDIR), expand
  // so it is on screen, then click it.
  fs.rmSync(DEAD_RUNDIR, { recursive: true, force: true });
  await run(`document.getElementById('history-toggle').click(); true;`); await wait(220);
  revealCalls.length = 0;
  check(await clickReveal(6), 'the oldest row (deleted folder) has a Reveal button to click');
  await wait(400);
  const notice = await run(`(() => { const n = document.getElementById('app-notice');
    return { shown: !!(n && n.classList.contains('show')), text: n ? n.textContent : '',
             modal: !!document.querySelector('.modal-backdrop') }; })()`);
  check(revealCalls.length === 0, `deleted run folder → reveal NOT invoked (got ${JSON.stringify(revealCalls)})`);
  check(notice.shown && /folder may have moved or been deleted/i.test(notice.text) && !notice.modal,
    `deleted run folder → non-blocking notice, no modal (got ${JSON.stringify(notice)})`);
  check(await run(`!!document.querySelectorAll('#history-list .hs-row')[6].querySelector('.hs-reveal')`),
    'the button stays enabled — reachability is answered at click time, never guessed');

  // A run with no folder at all gets no button rather than a dead one.
  store.history = [{ at: STAMP_AT, name: 'No folder', tier: 'regular', files: 1, failed: 0,
                     skipped: 0, before: 10, after: 4, reclaimed: 6, runDir: null }];
  await run(`refreshHistory(); true;`); await wait(220);
  const nofolder = await sectionState();
  check(nofolder.rows === 1 && nofolder.reveals[0] === false,
    'runDir null → the row renders with no Reveal button');

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) FAIL.forEach((f) => console.log('  FAILED: ' + f));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  app.exit(FAIL.length ? 1 : 0);
});
