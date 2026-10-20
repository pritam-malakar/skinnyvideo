/* 3.3.0 F1 — History records per finished file: source codec, source
   pix_fmt, tier and the actual reclaim ratio. Old History still loads.

   OLD   (REAL readHistory + REAL renderer): a prefs.json written by 3.2.2
         (and a pre-3.0.2 entry) with no `perFile` loads and renders its rows.
   NEW   (REAL renderer + REAL appendHistoryEntry): a batch whose file-done
         events carry srcCodec/srcPixFmt stores one perFile record per done
         file with the four fields; failed/skipped files add none.
   SHAPE (REAL sanitizeHistoryEntry): junk records are dropped, strings are
         bounded, the list is capped.
   PIPELINE: runBatch's success file-done carries srcCodec/srcPixFmt (real
         encode of a tiny clip with the bundled ffmpeg).

   FAIL-ON-OLD: 3.3.0 item 12 stored no per-file data.
   Run: ./node_modules/.bin/electron test/history_perfile_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const H = require(path.join(ROOT, 'src/main/history-store'));
const P = require(path.join(ROOT, 'src/encoder/pipeline'));
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-histpf-')));
const DEST = path.join(WORK, 'out');
const RUNDIR = path.join(DEST, 'Compressed_2026-10-20_0900');
const store = {};
let nextFiles = [];

ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('browse-source-files', async () => nextFiles.slice());
ipcMain.handle('scan-files', async () => ({ rootKind: 'files', root: nextFiles[0], ignored: 0, totalSize: nextFiles.length * 4e6,
  videos: nextFiles.map((file) => ({ file, basename: path.basename(file), size: 4_000_000 })) }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('get-last-dest', async () => null);
ipcMain.handle('add-reclaimed', async (_e, p) => { H.appendHistoryEntry(store, p.historyEntry, Date.now()); return { ok: true }; });
ipcMain.handle('get-history', async () => H.readHistory(store));
['save-last-src', 'delete-orphans', 'open-path', 'reveal-path', 'reveal-in-finder', 'reveal-folder', 'reset-drive', 'pause-batch',
 'resume-batch', 'cancel-batch', 'stop-queue', 'start-queue', 'enqueue-batch', 'remove-batch', 'set-batch-skips', 'get-tier-defaults',
 'get-update-pref'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

app.whenReady().then(async () => {
  let win;
  try {
    fs.mkdirSync(RUNDIR, { recursive: true });
    // ── OLD ──
    const OLD = [
      { at: 1760000000000, name: 'Card A', kind: 'folder', tier: 'preserve', files: 4, failed: 0, skipped: 1, before: 8e9, after: 2e9, reclaimed: 6e9, runDir: '/x/Compressed_2026-10-14_1000' },
      { at: 1750000000000, name: 'C0038.mov + 2 more', tier: 'regular', files: 3, failed: 0, skipped: 0, before: 3e9, after: 1e9, reclaimed: 2e9, runDir: null }
    ];
    const prefsFile = path.join(WORK, 'prefs.json');
    fs.writeFileSync(prefsFile, JSON.stringify({ history: OLD }));
    store.history = JSON.parse(fs.readFileSync(prefsFile, 'utf8')).history;
    const loaded = H.readHistory(store);
    check(loaded.length === 2 && loaded.every((e) => e.perFile === undefined), 'old-format entries load unchanged (no perFile added on read)');

    win = new BrowserWindow({ width: 1280, height: 1000, show: false,
      webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
    const run = (js) => win.webContents.executeJavaScript(js);
    const send = (ch, p) => win.webContents.send(ch, p);
    await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
    await wait(500);
    const rows = await run(`[...document.querySelectorAll('#history-list .hs-row')].map((r) => r.querySelector('.hs-label').textContent + ' · ' + r.querySelector('.hs-files').textContent)`);
    check(rows.length === 2 && rows[0].startsWith('Card A') && /^C0038\.mov \+ 2 more/.test(rows[1]), `old entries display (${JSON.stringify(rows)})`);

    // ── NEW ──
    nextFiles = ['/fake/a.mov', '/fake/b.mp4', '/fake/c.mov'];
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(200);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(400);
    await run(`(() => { const r = document.querySelector('input[name="tier"][value="preserve"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); })(); true;`);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
    const id = await run(`queue[queue.length - 1].id`);
    send('batch-status', { id, status: 'Running' }); await wait(100);
    const outs = [
      { file: nextFiles[0], outcome: 'ok', outBytes: 1_000_000, srcCodec: 'prores', srcPixFmt: 'yuv422p10le' },
      { file: nextFiles[1], outcome: 'ok-fallback', outBytes: 3_000_000, srcCodec: 'h264', srcPixFmt: 'yuv420p' },
      { file: nextFiles[2], outcome: 'fail', outBytes: null, srcCodec: 'hevc', srcPixFmt: 'yuv420p10le' }
    ];
    for (let i = 0; i < outs.length; i++) {
      send('progress', { type: 'file-start', index: i + 1, total: 3, file: outs[i].file, basename: path.basename(outs[i].file) }); await wait(30);
      send('progress', { type: 'file-done', index: i + 1, total: 3, basename: path.basename(outs[i].file), reclaimed: 0, processed: 0, failed: 0, alreadyDone: 0, elapsedMs: 10, ...outs[i] });
      await wait(50);
    }
    send('batch-status', { id, status: 'Done', result: { runDir: RUNDIR, processed: 2, failed: 1, reclaimed: 0 } });
    await wait(400);
    const e = store.history[0] || {};
    check(Array.isArray(e.perFile) && e.perFile.length === 2, `one record per finished file, none for the failed one (${JSON.stringify(e.perFile)})`);
    const want = [{ codec: 'prores', pixFmt: 'yuv422p10le', tier: 'preserve', reclaimRatio: 0.75 }, { codec: 'h264', pixFmt: 'yuv420p', tier: 'preserve', reclaimRatio: 0.25 }];
    check(JSON.stringify(e.perFile) === JSON.stringify(want), 'records carry codec, pix_fmt, tier and the actual reclaim ratio');
    check(H.readHistory(store).length === 3 && store.history[1].name === 'Card A', 'new entry sits on top of the old ones; old ones untouched');

    // ── SHAPE ──
    const junk = H.sanitizeHistoryEntry({ files: 1, perFile: [null, { codec: 'x'.repeat(40), pixFmt: '<b>', tier: 'nope', reclaimRatio: -3 },
      { reclaimRatio: 'NaN' }, { reclaimRatio: 2 }, ...Array.from({ length: 300 }, () => ({ codec: 'hevc', pixFmt: 'yuv420p', tier: 'regular', reclaimRatio: 0.5 }))] }, 1);
    check(junk.perFile[0].codec === null && junk.perFile[0].pixFmt === null && junk.perFile[0].tier === null && junk.perFile[0].reclaimRatio === -3,
      'bad strings/tier become null; a negative ratio (output grew) is kept');
    check(junk.perFile.length === H.PER_FILE_CAP, `non-numeric and >1 ratios dropped; list capped at ${H.PER_FILE_CAP}`);
    check(Array.isArray(H.sanitizeHistoryEntry({ files: 1 }, 1).perFile), 'an entry without perFile stores an empty list');

    // ── PIPELINE ──
    const card = path.join(WORK, 'Card'), out = path.join(WORK, 'PipeOut');
    fs.mkdirSync(card); fs.mkdirSync(out);
    const g = spawnSync(P.getBinaries().ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=1', '-pix_fmt', 'yuv422p', '-c:v', 'mjpeg', path.join(card, 'm.mov')]);
    if (g.status !== 0) throw new Error('fixture: ' + g.stderr);
    let done = null;
    await P.runBatch({ src: card, dest: out, tier: 'preserve', kind: 'folder' }, {}, (ev) => { if (ev.type === 'file-done') done = ev; });
    check(done && /^ok/.test(done.outcome) && done.srcCodec === 'mjpeg' && done.srcPixFmt === 'yuvj422p',
      `runBatch file-done carries srcCodec/srcPixFmt (${done && JSON.stringify({ o: done.outcome, c: done.srcCodec, p: done.srcPixFmt })})`);
  } catch (err) {
    console.error(err);
    FAIL.push('unexpected throw: ' + (err && err.message));
  }
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  console.log(`\n[history-perfile] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
