/* downconvert8 Nerd-mode UI — REAL renderer + preload + IPC.
   The "Downconvert 10-bit to 8-bit" checkbox:
     (a) Simple mode → never shown;
     (b) Nerd mode + 10-bit batch + location → shown + enabled;
     (c) checking it arms settings.downconvert8 and FREEZES into the batch on Add;
     (d) Nerd mode + all-8-bit batch → hidden (no dead control).

   FAIL-ON-OLD: the checkbox element / wiring don't exist pre-feature → (b)/(c)
   fail. Run: ./node_modules/.bin/electron test/downconvert_ui_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEST = '/tmp/squeeze-dc8-ui';

// scan-files returns whatever the test currently stages (10-bit or 8-bit).
let nextVideo = { file: '/fake/ten.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };

let win;
ipcMain.handle('app-version', async () => 'dc8-ui');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('browse-source-files', async () => [nextVideo.file]);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: nextVideo.file, videos: [nextVideo], ignored: 0, totalSize: nextVideo.size
}));
ipcMain.handle('scan-source', async () => ({ rootKind: 'files', root: nextVideo.file, videos: [], ignored: 0, totalSize: 0 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips',
 'start-queue', 'stop-queue', 'enqueue-batch'
].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));
ipcMain.handle('get-lifetime-drives', async () => []);

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const run = (js) => win.webContents.executeJavaScript(js);
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });

  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);

  const setMode = async (pro) => { await run(`document.getElementById('${pro ? 'mode-pro' : 'mode-simple'}').click(); true;`); await wait(150); };
  const browse  = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(600); };
  const chooseDest = async () => { await run(`document.getElementById('choose-dest').click(); true;`); await wait(300); };
  const cbHidden = () => run(`document.getElementById('pro-downconvert').hidden`);
  const cbDisabled = () => run(`document.getElementById('pro-downconvert-input').disabled`);

  // (a) Simple mode — checkbox container hidden (panel itself hidden in Simple).
  nextVideo = { file: '/fake/ten.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };
  await browse();
  check(await cbHidden() === true, `(a) Simple mode: downconvert checkbox hidden`);

  // (b) Nerd + 10-bit staged but NO location yet → still suppressed (single
  //     ready gate). Then pick location → shown + enabled.
  await setMode(true);
  check(await cbHidden() === true, `(b) Nerd + 10-bit, no location → checkbox suppressed (ready gate)`);
  await chooseDest();
  check(await cbHidden() === false, `(b) Nerd + 10-bit + location → checkbox shown`);
  check(await cbDisabled() === false, `(b) with location → checkbox enabled (not gated)`);

  // (c) check it → arms settings.downconvert8; Add freezes it into the batch.
  await run(`document.getElementById('pro-downconvert-input').click(); true;`); await wait(150);
  const armed = await run(`!!(armed.settings && armed.settings.downconvert8)`);
  check(armed === true, `(c) checking arms settings.downconvert8 (got ${armed})`);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  const frozen = await run(`(queue[0] && queue[0].settings) ? queue[0].settings.downconvert8 : 'no-batch'`);
  check(frozen === true, `(c) Add froze downconvert8:true into the batch payload (got ${frozen})`);

  // (d) all-8-bit batch → checkbox hidden (dest is sticky from the prior Add).
  nextVideo = { file: '/fake/eight.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p' };
  await browse();
  check(await cbHidden() === true, `(d) Nerd + all-8-bit batch → checkbox hidden (no dead control)`);

  check(errors.length === 0, `no renderer console errors: ${errors.length ? errors.join(' | ') : 'none'}`);

  console.log('\n[downconvert-ui] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
