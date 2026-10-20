/* 3.3.0 Item 11 — the skip label "Existing" is now "Duplicate".

   UI   (REAL renderer + REAL preload): a file-done with outcome 'skip-exists'
        renders the row pill "Duplicate" with tooltip "Same file already added
        in this session", and the output column says "duplicate". No
        user-facing "Existing" remains in the renderer.
   LOG  (REAL runBatch, REAL bundled ffmpeg, same tiny clip run twice into the
        same Output in the same minute): the second run logs
        `SKIP-EXISTS  <src> (Duplicate: same file already added in this session; …)`
        — the SKIP-EXISTS tag is kept for grep stability.

   FAIL-ON-OLD (3.2.2): the row said "Existing" (no tooltip) and the log line
   had no Duplicate wording.
   Run: ./node_modules/.bin/electron test/duplicate_label_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src/encoder/pipeline'));
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = ['/fake/dup.mov'];

let win;
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };
ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => '/tmp/skinnyvideo-dup');
ipcMain.handle('browse-source-files', async () => FILES);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({ rootKind: 'files', root: FILES[0], videos: FILES.map((file) => ({ file, size: 1_000_000, duration: 60 })), ignored: 0, totalSize: 1_000_000 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
['start-queue', 'stop-queue', 'enqueue-batch', 'save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

app.whenReady().then(async () => {
  try {
    // ── UI ──
    win = new BrowserWindow({ width: 1100, height: 900, show: false,
      webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
    const run = (js) => win.webContents.executeJavaScript(js);
    await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
    await wait(400);
    await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
    await run(`document.getElementById('dz-browse').click(); true;`); await wait(500);
    await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
    const id = await run(`(queue && queue[0] ? queue[0].id : null)`);
    await run(`document.getElementById('start').click(); true;`); await wait(200);
    send('batch-status', { id, status: 'Running' });
    send('progress', { batchId: id, type: 'file-start', index: 1, total: 1, file: FILES[0], basename: 'dup.mov' });
    send('progress', { batchId: id, type: 'file-done', index: 1, total: 1, file: FILES[0], basename: 'dup.mov', outcome: 'skip-exists', outBytes: 400_000, processed: 0, failed: 0, alreadyDone: 1, reclaimed: 0 });
    await wait(200);
    const r = await run(`(() => { const row = document.querySelector('.qrow[data-fpath=${JSON.stringify(FILES[0])}]'); if (!row) return null;
      const pill = row.querySelector('.status .pill'); const cols = row.children;
      return { text: pill.textContent, title: pill.title, out: ([...cols].find((c) => c.classList.contains('mono') && c.style.textAlign === 'right') || {}).textContent || null, all: [...cols].map((c) => c.className + '=' + c.textContent) }; })()`);
    check(r && r.text === 'Duplicate', `row pill reads "Duplicate" (${JSON.stringify(r)})`);
    check(r && r.title === 'Same file already added in this session', `tooltip "Same file already added in this session" (${r && r.title})`);
    check(r && r.out === 'duplicate', `output column says "duplicate" (${r && r.out})`);
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
    check(!/'Existing'|'existing'/.test(src), 'no user-facing "Existing" string left in the renderer');

    // ── LOG ──
    const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dup-')));
    const card = path.join(SB, 'Card'), out = path.join(SB, 'Out');
    fs.mkdirSync(card); fs.mkdirSync(out);
    const g = spawnSync(P.getBinaries().ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=1', '-c:v', 'libx265', '-x265-params', 'log-level=none', path.join(card, 'dup.mov')]);
    if (g.status !== 0) throw new Error('fixture: ' + g.stderr);
    const r1 = await P.runBatch({ src: card, dest: out, tier: 'preserve', kind: 'folder' }, {}, () => {});
    const r2 = await P.runBatch({ src: card, dest: out, tier: 'preserve', kind: 'folder' }, {}, () => {});
    await wait(300);
    const log = fs.readFileSync(r2.logPath, 'utf8');
    if (r1.runDir === r2.runDir) {
      check(/^SKIP-EXISTS  .*dup\.mov \(Duplicate: same file already added in this session; already present in destination\)$/m.test(log),
        'log keeps SKIP-EXISTS and adds the Duplicate wording');
    } else {
      console.log('SKIP LOG: the two runs straddled a minute boundary (different run folders)');
    }
    fs.rmSync(SB, { recursive: true, force: true });
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  console.log(`\n[duplicate-label] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
