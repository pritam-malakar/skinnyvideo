/* Clear-staged-file control — REAL renderer + preload + IPC.
   v2.3.0 feature: a "Clear" button on the loaded dropzone discards the staged
   file via clearDrop({resetTier:true}) — the SAME reset Add runs post-commit.
   It must: clear current to empty, drop has-source, restore the prompt, hide
   #drop-status, KEEP the sticky dest, and leave the queue + any active run
   untouched.

   FAIL-ON-OLD: pre-feature there is no #drop-clear element, so the
   "button present when staged" check fails and clickClear is a no-op (the
   post-clear assertions then fail too).
   Run: ./node_modules/.bin/electron test/clear_staged_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEST = '/tmp/squeeze-clear-test';

// Count run-affecting IPC so we can prove a clear never disturbs the queue/run.
const calls = { 'stop-queue': 0, 'cancel-batch': 0, 'remove-batch': 0, 'start-queue': 0 };

let nextVideo = { file: '/fake/a.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p' };

ipcMain.handle('app-version', async () => 'clear-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('browse-source-files', async () => [nextVideo.file]);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({ rootKind: 'files', root: nextVideo.file, videos: [nextVideo], ignored: 0, totalSize: nextVideo.size }));
ipcMain.handle('scan-source', async () => ({ rootKind: 'files', root: nextVideo.file, videos: [], ignored: 0, totalSize: 0 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips',
 'start-queue', 'stop-queue', 'enqueue-batch', 'remove-batch'
].forEach((c) => ipcMain.handle(c, async () => { if (c in calls) calls[c]++; return { ok: true }; }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 1000, show: false, backgroundColor: '#0c0e12',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const run = (js) => win.webContents.executeJavaScript(js);
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);

  const setMode  = async (pro) => { await run(`document.getElementById('${pro ? 'mode-pro' : 'mode-simple'}').click(); true;`); await wait(150); };
  const browse   = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(500); };
  const chooseDest = async () => { await run(`document.getElementById('choose-dest').click(); true;`); await wait(250); };
  const clickAdd = async () => { await run(`document.getElementById('add-to-queue').click(); true;`); await wait(250); };
  const clickClear = async () => { await run(`document.getElementById('drop-clear').click(); true;`); await wait(200); };

  // Visibility via offsetParent: null when the element (or an ancestor) is display:none.
  const dzState = () => run(`(() => {
    const cs = (id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).display : 'MISSING'; };
    const vis = (id) => { const e = document.getElementById(id); return !!(e && e.offsetParent !== null); };
    return {
      clearExists: !!document.getElementById('drop-clear'),
      clearVisible: vis('drop-clear'),
      dropStatusDisplay: cs('drop-status'),
      hasSource: document.getElementById('dropzone').classList.contains('has-source'),
      innerDisplay: getComputedStyle(document.querySelector('.dz-inner')).display,
      titleText: document.getElementById('dz-title').textContent.replace(/\\s+/g,' ').trim(),
      filesLen: current.fileSources.length,
      scanned: current.scanned,
      src: current.src,
      dest: current.dest,
      queueLen: queue.length,
    };
  })()`);

  // ── 1. No file staged → clear button exists but is NOT visible (lives in #drop-status) ──
  const empty = await dzState();
  check(empty.clearExists === true, `#drop-clear element present in DOM`);
  check(empty.clearVisible === false && empty.dropStatusDisplay === 'none',
    `empty dropzone: clear button hidden (drop-status display=${empty.dropStatusDisplay})`);

  // ── 2. Stage a file → has-source, #drop-status visible, clear button visible ──
  await chooseDest();
  await browse();
  const staged = await dzState();
  check(staged.hasSource === true && staged.dropStatusDisplay === 'flex',
    `staged: has-source + #drop-status visible`);
  check(staged.clearVisible === true, `staged: Clear button visible`);
  check(staged.filesLen === 1 && staged.scanned === true, `staged: current has 1 scanned file`);
  const destBefore = staged.dest;

  // ── 3. Click Clear → current empty, has-source gone, prompt restored, dest kept, queue unchanged ──
  const qLenBefore = staged.queueLen;
  await clickClear();
  const cleared = await dzState();
  check(cleared.filesLen === 0 && cleared.scanned === false && cleared.src === null,
    `after Clear: current reset to empty (files=${cleared.filesLen}, scanned=${cleared.scanned})`);
  check(cleared.hasSource === false && cleared.innerDisplay === 'flex',
    `after Clear: has-source removed → .dz-inner prompt shown`);
  check(/Drop a .*folder or files.* to begin/.test(cleared.titleText) || /Drop .*another/.test(cleared.titleText),
    `after Clear: #dz-title prompt restored ("${cleared.titleText}")`);
  check(cleared.dropStatusDisplay === 'none' && cleared.clearVisible === false,
    `after Clear: #drop-status (and Clear button) hidden`);
  check(cleared.dest === destBefore && cleared.dest === DEST,
    `after Clear: sticky dest PRESERVED (${cleared.dest})`);
  check(cleared.queueLen === qLenBefore,
    `after Clear: queue length unchanged (${cleared.queueLen})`);

  // ── 4. Clear while a batch is QUEUED + a run is "active" → queue + run untouched ──
  await browse();                 // stage again (dest sticky)
  await clickAdd();               // → 1 batch queued, staging reset
  await browse();                 // stage a second file on top
  const beforeClear = await run(`(() => {
    runActive = true;             // simulate an in-flight run
    return { q: queue.length, id: queue[0] && queue[0].id, st: queue[0] && queue[0].status };
  })()`);
  Object.keys(calls).forEach((k) => calls[k] = 0);   // reset counters around the clear
  await clickClear();
  const afterClear = await run(`({ q: queue.length, id: queue[0] && queue[0].id, st: queue[0] && queue[0].status, runActive })`);
  check(afterClear.q === beforeClear.q && afterClear.id === beforeClear.id && afterClear.st === beforeClear.st,
    `Clear mid-run: queued batch intact (q=${afterClear.q}, status=${afterClear.st})`);
  check(afterClear.runActive === true, `Clear mid-run: runActive flag untouched`);
  check(calls['stop-queue'] === 0 && calls['cancel-batch'] === 0 && calls['remove-batch'] === 0,
    `Clear mid-run: no stop/cancel/remove IPC fired (stop=${calls['stop-queue']}, cancel=${calls['cancel-batch']}, remove=${calls['remove-batch']})`);
  await run(`runActive = false; true;`);

  // ── 5. Nerd mode: after Clear, the pro panel returns to disabled "Drop files…" ──
  await setMode(true);
  await browse();                 // stage → panel becomes live
  await clickClear();             // clear it
  const panel = await run(`(() => {
    const pb = document.getElementById('pro-panel');
    return { disabled: pb.classList.contains('disabled'),
             emptyText: document.getElementById('pro-panel-empty').textContent.trim() };
  })()`);
  check(panel.disabled === true, `Nerd mode after Clear: pro panel disabled`);
  check(/Drop files to configure/.test(panel.emptyText),
    `Nerd mode after Clear: empty prompt "${panel.emptyText}"`);

  check(errors.length === 0, `no renderer console errors: ${errors.length ? errors.join(' | ') : 'none'}`);

  console.log('\n[clear-staged] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
