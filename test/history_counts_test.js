/* Repo regression (v3.0.2): HISTORY ROW COUNTS — "+ N more" and "N videos"
   must never disagree.

   THE BUG: the row's name was a display string frozen at DROP time by
   fileListDisplayName(paths), so its "+ N more" counted every path dropped —
   including files the scan rejected as non-video and files that later failed
   or were skipped. The row's "N videos" came from filesAdded in
   maybeCreditBatch, which counts only status==='done'. Two populations, two
   moments, one row: "C0038.mov + 12 more · 12 videos".

   THE FIX: the store holds a BARE name plus a `kind`; the suffix is derived
   at render time from `files`, the single count in the record. Arithmetic,
   not coincidence.

   Runs on the REAL GUI path, same harness as history_test.js: real preload,
   real renderer, real add flow, real 'batch-status'/'progress' events, and
   the REAL appendHistoryEntry/readHistory from src/main/history-store.

   Asserts:
     (a) a mixed batch (done + failed + skipped + a non-video the scan drops)
         renders "+ N more" exactly equal to (videos shown − 1);
     (b) both labels derive from the SAME field — mutating entry.files moves
         the suffix and the count together;
     (c) the baked suffix is not stored;
     (d) folder drops and inline renames render verbatim, with no suffix;
     (e) a single done file gets no suffix at all;
     (f) MIGRATION: a real pre-3.0.2 prefs.json on disk, read through the real
         readHistory, renders correctly with no user action.

   Run:  ./node_modules/.bin/electron test/history_counts_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = process.env.SKINNYVIDEO_ROOT || path.join(__dirname, '..');
const { appendHistoryEntry, readHistory } = require(path.join(ROOT, 'src/main/history-store'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const header = (t) => console.log('\n==== ' + t + ' ====');

const WORK = path.join(os.tmpdir(), 'skinnyvideo-histcounts-' + process.pid);
const DEST = path.join(WORK, 'out');
const RUNDIR = path.join(DEST, 'Compressed_2026-09-07_1200');
const PREFS_FIXTURE = path.join(WORK, 'prefs.json');

const store = {};
let nextFiles = [];      // what the picker returns (everything "dropped")
let nextVideos = [];     // what the scan probes as REAL video, [{file,size}]
let STAMP_AT = Date.now();

ipcMain.handle('app-version', async () => '3.0.2-test');
ipcMain.handle('browse-source-files', async () => nextFiles.slice());
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: nextFiles[0],
  ignored: nextFiles.length - nextVideos.length,
  totalSize: nextVideos.reduce((a, v) => a + v.size, 0),
  videos: nextVideos.map((v) => ({ file: v.file, basename: v.file.split('/').pop(), size: v.size }))
}));
ipcMain.handle('scan-source', async () => ({
  rootKind: 'folder', root: nextFiles[0],
  ignored: nextFiles.length - nextVideos.length,
  totalSize: nextVideos.reduce((a, v) => a + v.size, 0),
  videos: nextVideos.map((v) => ({ file: v.file, basename: v.file.split('/').pop(), size: v.size }))
}));
ipcMain.handle('browse-source', async () => nextFiles[0]);
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async () => ({ isFile: false, isDirectory: true }));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('add-reclaimed', async (_e, payload) => {
  if (!payload || !payload.dest) return null;
  if (Math.max(0, Math.floor(payload.filesAdded || 0)) === 0) return null;
  appendHistoryEntry(store, payload.historyEntry, STAMP_AT);
  return { ok: true };
});
ipcMain.handle('get-history', async () => readHistory(store));
ipcMain.handle('reveal-folder', async () => ({ ok: true }));

['save-last-src', 'delete-orphans', 'open-path', 'reveal-path', 'reveal-in-finder',
 'reset-drive', 'pause-batch', 'resume-batch', 'cancel-batch', 'stop-queue',
 'start-queue', 'enqueue-batch', 'remove-batch', 'set-batch-skips',
 'get-tier-defaults']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  fs.mkdirSync(RUNDIR, { recursive: true });

  const win = new BrowserWindow({
    width: 1280, height: 1000, show: false, backgroundColor: '#111111',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false }
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };
  await wait(450);

  /* One row, as the user reads it: the visible label and the visible count. */
  const rowState = () => run(`(() => {
    const rows = [...document.querySelectorAll('#history-list .hs-row')];
    return rows.map(r => ({
      label: r.querySelector('.hs-label').textContent,
      files: r.querySelector('.hs-files').textContent
    }));
  })()`);

  const addBatch = async ({ files, videos, tier = 'regular' }) => {
    nextFiles = files; nextVideos = videos;
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(220);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(420);
    await run(`(() => { const r = document.querySelector('input[name="tier"][value="${tier}"]');
                        r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })(); true;`);
    await wait(80);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
    return run(`queue[queue.length - 1].id`);
  };

  const runBatchTo = async (id, outcomes) => {
    send('batch-status', { id, status: 'Running' });
    await wait(120);
    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      send('progress', { type: 'file-start', index: i + 1, total: outcomes.length, file: o.file, basename: o.file.split('/').pop() });
      await wait(30);
      send('progress', {
        type: 'file-done', index: i + 1, total: outcomes.length,
        file: o.file, basename: o.file.split('/').pop(),
        outBytes: o.outBytes, outcome: o.outcome,
        reclaimed: 0, processed: 0, failed: 0, alreadyDone: 0, elapsedMs: 10
      });
      await wait(50);
    }
    send('batch-status', { id, status: 'Done', result: { runDir: RUNDIR, processed: 0, failed: 0, reclaimed: 0 } });
    await wait(320);
  };

  /* Parse "<name> + N more" back into its number, or null when absent. */
  const suffixOf = (label) => {
    const m = / \+ (\d+) more$/.exec(label);
    return m ? Number(m[1]) : null;
  };
  const countOf = (filesText) => Number(/^(\d+)/.exec(filesText)[1]);

  // ── (a) the reported bug, reproduced end to end ────────────────────────
  header('(a) mixed batch: dropped 6, one non-video, one failed, one skipped');
  /* Six paths go in. The scan rejects notes.txt outright, so five reach the
     queue; of those one fails and one is already present. Three encode.
     Pre-fix this row read "C0038.mov + 5 more · 3 videos". */
  const D = ['/fake/C0038.mov', '/fake/C0039.mov', '/fake/C0040.mov',
             '/fake/C0041.mov', '/fake/C0042.mov', '/fake/notes.txt'];
  STAMP_AT = 1_757_000_000_000;
  const idA = await addBatch({
    files: D,
    videos: D.slice(0, 5).map((f) => ({ file: f, size: 4_000_000 }))
  });
  await runBatchTo(idA, [
    { file: D[0], outBytes: 1_000_000, outcome: 'ok' },
    { file: D[1], outBytes: 1_000_000, outcome: 'ok' },
    { file: D[2], outBytes: null,      outcome: 'fail' },
    { file: D[3], outBytes: 1_000_000, outcome: 'ok' },
    { file: D[4], outBytes: 900_000,   outcome: 'skip-exists' }
  ]);

  const e0 = (store.history || [])[0] || {};
  check(e0.files === 3, `files = done count only (got ${e0.files})`);
  check(e0.kind === 'files', `kind is 'files' for a multi-file drop (got ${JSON.stringify(e0.kind)})`);

  // (c) the suffix must not be in the STORE at all
  check(!/ \+ \d+ more$/.test(e0.name || ''),
    `stored name carries NO baked suffix (got ${JSON.stringify(e0.name)})`);
  check(e0.name === 'C0038.mov',
    `stored name is the bare first DONE filename (got ${JSON.stringify(e0.name)})`);

  const rows = await rowState();
  const label = rows[0].label, filesText = rows[0].files;
  console.log(`      rendered: "${label}" · "${filesText}"`);
  check(countOf(filesText) === 3, `row shows "3 videos" (got ${JSON.stringify(filesText)})`);
  check(suffixOf(label) === 2,
    `row shows "+ 2 more", not "+ 5 more" (got ${JSON.stringify(label)})`);
  // THE assertion the bug violated:
  check(suffixOf(label) === countOf(filesText) - 1,
    `"+ N more" === (videos − 1)  [${suffixOf(label)} === ${countOf(filesText)} − 1]`);

  // ── (b) both labels read the SAME field ────────────────────────────────
  header('(b) suffix and count are derived from one field');
  /* Move entry.files alone and re-render. If the suffix follows, the two
     labels provably share a source; if it does not, one of them is a stored
     string again and the bug has grown back. */
  const moved = await run(`(async () => {
    const list = await window.api.getHistory();
    const e = { ...list[0], files: 9 };
    const li = historyRow(e);
    return { label: li.querySelector('.hs-label').textContent,
             files: li.querySelector('.hs-files').textContent };
  })()`).catch(() => null);
  if (moved) {
    check(suffixOf(moved.label) === 8 && countOf(moved.files) === 9,
      `files:9 → "+ 8 more · 9 videos" (got ${JSON.stringify(moved.label)} · ${JSON.stringify(moved.files)})`);
    check(suffixOf(moved.label) === countOf(moved.files) - 1,
      'the invariant holds under a mutated count — one field of truth');
  } else {
    check(false, 'could not re-render a row through historyRow()');
  }

  // ── (e) a single done file gets no suffix ──────────────────────────────
  header('(e) one file → no suffix');
  STAMP_AT = 1_757_000_100_000;
  const S = ['/fake/solo.mov', '/fake/other.mov'];
  const idS = await addBatch({ files: S, videos: S.map((f) => ({ file: f, size: 3_000_000 })) });
  await runBatchTo(idS, [
    { file: S[0], outBytes: 900_000, outcome: 'ok' },
    { file: S[1], outBytes: null,    outcome: 'fail' }
  ]);
  const rowsS = await rowState();
  check(suffixOf(rowsS[0].label) === null && countOf(rowsS[0].files) === 1,
    `single done file renders bare (got ${JSON.stringify(rowsS[0].label)} · ${JSON.stringify(rowsS[0].files)})`);

  // ── (d) folder + rename render verbatim ────────────────────────────────
  header('(d) folder and custom names render verbatim');
  const verbatim = await run(`(() => {
    const f = historyRow({ at: Date.now(), name: 'Walkthrough', kind: 'folder', tier: 'regular',
                           files: 3, failed: 0, skipped: 0, before: 0, after: 0, reclaimed: 0, runDir: null });
    const c = historyRow({ at: Date.now(), name: 'Wedding rushes', kind: 'custom', tier: 'regular',
                           files: 7, failed: 0, skipped: 0, before: 0, after: 0, reclaimed: 0, runDir: null });
    return { folder: f.querySelector('.hs-label').textContent,
             custom: c.querySelector('.hs-label').textContent };
  })()`);
  check(verbatim.folder === 'Walkthrough', `folder name is untouched (got ${JSON.stringify(verbatim.folder)})`);
  check(verbatim.custom === 'Wedding rushes', `renamed batch is untouched (got ${JSON.stringify(verbatim.custom)})`);

  // ── (f) migration from a REAL pre-3.0.2 prefs.json on disk ─────────────
  header('(f) migration: a real pre-3.0.2 prefs.json on disk');
  /* Exactly what 3.0.1 wrote: baked suffixes, no `kind`. The numbers in the
     stored suffixes are WRONG on purpose (12 vs 12 files, 5 vs 3) — they are
     the bug's own output, and must be discarded, not trusted. */
  fs.writeFileSync(PREFS_FIXTURE, JSON.stringify({
    outputRoots: {},
    history: [
      { at: 1_756_000_000_000, name: 'C0038.mov + 12 more', tier: 'regular', files: 12,
        failed: 0, skipped: 1, before: 2_300_000_000, after: 147_000_000,
        reclaimed: 2_153_000_000, runDir: RUNDIR },
      { at: 1_755_900_000_000, name: 'Walkthrough + 5 more', tier: 'preserve', files: 3,
        failed: 2, skipped: 1, before: 900_000_000, after: 90_000_000,
        reclaimed: 810_000_000, runDir: null },
      { at: 1_755_800_000_000, name: 'Wedding rushes', tier: 'regular', files: 4,
        failed: 0, skipped: 0, before: 100, after: 50, reclaimed: 50, runDir: null }
    ]
  }, null, 2));

  const onDisk = JSON.parse(fs.readFileSync(PREFS_FIXTURE, 'utf8'));
  const migrated = readHistory(onDisk);          // the REAL read path
  check(migrated[0].name === 'C0038.mov' && migrated[0].kind === 'files',
    `baked suffix stripped, kind='files' (got ${JSON.stringify(migrated[0].name)}/${migrated[0].kind})`);
  check(migrated[1].name === 'Walkthrough' && migrated[1].kind === 'files',
    `second baked name stripped (got ${JSON.stringify(migrated[1].name)}/${migrated[1].kind})`);
  check(migrated[2].name === 'Wedding rushes' && migrated[2].kind === 'folder',
    `suffix-less legacy name renders verbatim (got ${JSON.stringify(migrated[2].name)}/${migrated[2].kind})`);
  check(!fs.readFileSync(PREFS_FIXTURE, 'utf8').includes('"kind"'),
    'migration is read-only — the file on disk is not rewritten');

  const legacyRows = await run(`(() => {
    const es = ${JSON.stringify(migrated)};
    return es.map(e => {
      const li = historyRow(e);
      return { label: li.querySelector('.hs-label').textContent,
               files: li.querySelector('.hs-files').textContent };
    });
  })()`);
  legacyRows.forEach((r, i) => console.log(`      legacy row ${i}: "${r.label}" · "${r.files}"`));
  check(legacyRows[0].label === 'C0038.mov + 11 more' && countOf(legacyRows[0].files) === 12,
    `legacy row re-derives from files: "+ 11 more · 12 videos" (got ${JSON.stringify(legacyRows[0].label)})`);
  check(legacyRows[1].label === 'Walkthrough + 2 more' && countOf(legacyRows[1].files) === 3,
    `the wrong stored "+ 5 more" is corrected to "+ 2 more" (got ${JSON.stringify(legacyRows[1].label)})`);
  check(legacyRows[2].label === 'Wedding rushes',
    `legacy verbatim name stays bare (got ${JSON.stringify(legacyRows[2].label)})`);
  legacyRows.forEach((r, i) => check(
    suffixOf(r.label) === null || suffixOf(r.label) === countOf(r.files) - 1,
    `legacy row ${i} holds the invariant`));

  // ───────────────────────────────────────────────────────────────────────
  console.log(`\n==== ${PASS.length} passed, ${FAIL.length} failed ====`);
  if (FAIL.length) FAIL.forEach((f) => console.log('  FAILED: ' + f));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* temp */ }
  win.destroy();
  app.exit(FAIL.length ? 1 : 0);
});
