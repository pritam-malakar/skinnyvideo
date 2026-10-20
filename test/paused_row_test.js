/* 3.3.0 Item 6 — a paused batch's active file row reads Paused.
   REAL renderer + REAL preload; batch-status / progress driven by hand (the
   same messages main sends — 'Paused' after SIGSTOP, 'Running' after SIGCONT).

   While PAUSED: the encoding file's row pill says "Paused", has the paused
   class (lemon), and its colour is the lemon token; queued rows stay Queued.
   On RESUME: back to "Running" (mint).

   FAIL-ON-OLD (3.2.2): the batch pill said Paused while the file row kept
   saying Running.
   Run: ./node_modules/.bin/electron test/paused_row_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = ['/fake/one.mov', '/fake/two.mov'];

let win;
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };
ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => '/tmp/skinnyvideo-paused-row');
ipcMain.handle('browse-source-files', async () => FILES);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({ rootKind: 'files', root: FILES[0], videos: FILES.map((file) => ({ file, size: 1_000_000, duration: 60 })), ignored: 0, totalSize: 2_000_000 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
['start-queue', 'stop-queue', 'enqueue-batch', 'save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

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
  await run(`document.getElementById('start').click(); true;`); await wait(200);
  send('batch-status', { id, status: 'Running' }); await wait(50);
  send('progress', { batchId: id, type: 'file-start', index: 1, total: 2, file: FILES[0], basename: 'one.mov' });
  send('progress', { batchId: id, type: 'file-progress', index: 1, total: 2, file: FILES[0], fileProgress: 0.4 });
  await wait(150);
  const row = (f) => run(`(() => { const s = document.querySelector('.qrow[data-fpath=${JSON.stringify(f)}] .status'); if (!s) return null;
    const pill = s.querySelector('.pill'); const cs = getComputedStyle(pill);
    const lemon = getComputedStyle(document.documentElement).getPropertyValue('--lemon').trim();
    const probe = document.createElement('i'); probe.style.background = lemon; document.body.appendChild(probe); const lemonRgb = getComputedStyle(probe).backgroundColor; probe.remove();
    return { text: pill.textContent, cls: s.className, bg: cs.backgroundColor, lemonRgb }; })()`);
  const batchPill = () => run(`(document.querySelector('.qbatch-status .pill') || {}).textContent`);

  let r = await row(FILES[0]);
  check(r && r.text === 'Running', `before pause: active row reads Running (${JSON.stringify(r)})`);
  send('batch-status', { id, status: 'Paused' }); await wait(150);
  r = await row(FILES[0]);
  check((await batchPill()) === 'Paused', 'paused: batch pill reads Paused');
  check(r && r.text === 'Paused' && /\bpaused\b/.test(r.cls), `paused: active file row reads Paused with the paused class (${JSON.stringify(r)})`);
  check(r && r.bg === r.lemonRgb, `paused: row pill is lemon (${r && r.bg} vs ${r && r.lemonRgb})`);
  const q = await row(FILES[1]);
  check(q && q.text === 'Queued', `paused: a queued row stays Queued (${q && q.text})`);
  send('batch-status', { id, status: 'Running' }); await wait(150);
  r = await row(FILES[0]);
  check(r && r.text === 'Running' && /\brunning\b/.test(r.cls), `resumed: row back to Running (${JSON.stringify(r)})`);

  console.log(`\n[paused-row] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
