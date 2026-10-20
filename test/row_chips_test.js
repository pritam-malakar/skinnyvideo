/* Row chips (3.3.0) — REAL renderer + REAL preload, progress events driven by
   hand (same harness as finalizing_ui_test.js).

   NOTE   a file-done carrying `notes` (an audio track that couldn't be kept)
          shows a visible NOTE chip on the file row, with the note as its
          tooltip. FAIL-ON-OLD: 3.2.2 ignored `notes`; no chip.

   Run:  ./node_modules/.bin/electron test/row_chips_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = ['/fake/a.mov', '/fake/b.mov', '/fake/c.mov'];
const DEST = '/tmp/skinnyvideo-row-chips';

let win;
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('browse-source-files', async () => FILES);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: FILES[0],
  videos: FILES.map((file) => ({ file, size: 1_000_000, duration: 60 })), ignored: 0, totalSize: 3_000_000
}));
ipcMain.handle('scan-source', async () => ({ rootKind: 'files', root: FILES[0], videos: [], ignored: 0, totalSize: 0 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('start-queue', async () => ({ ok: true }));
ipcMain.handle('stop-queue', async () => ({ ok: true }));
ipcMain.handle('enqueue-batch', async () => ({ ok: true, absorbed: false }));
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips'
].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));
ipcMain.handle('get-lifetime-drives', async () => []);

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1100, height: 1000, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
  const run = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);

  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(500);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  const id = await run(`(queue && queue[0] ? queue[0].id : null)`);
  check(id != null, `batch seeded (id=${id})`);
  await run(`document.getElementById('start').click(); true;`); await wait(200);
  send('batch-status', { id, status: 'Running' });
  await wait(50);

  const done = (i, extra) => {
    send('progress', { batchId: id, type: 'file-start', index: i + 1, total: 3, file: FILES[i], basename: path.basename(FILES[i]) });
    send('progress', { batchId: id, type: 'file-done', index: i + 1, total: 3, file: FILES[i], basename: path.basename(FILES[i]),
      outcome: 'ok', outBytes: 500_000, inBytes: 1_000_000, processed: i + 1, failed: 0, alreadyDone: 0, reclaimed: 500_000 * (i + 1), ...extra });
  };
  const chips = (f) => run(`(() => {
    const row = document.querySelector('.qrow[data-fpath=${JSON.stringify(f)}]');
    if (!row) return null;
    return [...row.querySelectorAll('.status .hdr-chip')].map((c) => ({ text: c.textContent, title: c.title, cls: c.className }));
  })()`);

  // ── NOTE ──
  done(0, { notes: ['Audio track 2 (unknown) could not be kept'] });
  await wait(150);
  const a = await chips(FILES[0]);
  const note = (a || []).find((c) => c.text === 'NOTE');
  check(!!note, `NOTE: chip shown on the row (chips ${JSON.stringify(a)})`);
  check(note && note.title.includes('Audio track 2 (unknown) could not be kept'), `NOTE: tooltip carries the note (${note && note.title})`);
  done(1, {});
  await wait(150);
  const b = await chips(FILES[1]);
  check(Array.isArray(b) && !b.some((c) => c.text === 'NOTE'), `NOTE: no chip when there is nothing to note (${JSON.stringify(b)})`);

  console.log(`\n[row-chips] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
