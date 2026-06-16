/* Nerd-panel state-desync regression — REAL renderer + preload + IPC.
   Two defects, one symptom (empty "Drop files…" copy coexisting with a stale
   slider at a non-default value + Modified badge):
     (A) DETERMINISTIC — on Add, the panel re-arms the tier from session memory
         (qv:85 persists) and used to DIM the stale value under the empty copy.
         Fixed: empty-state and armed-display are MUTUALLY EXCLUSIVE (slider rows
         + Modified + checkbox are SUPPRESSED, not dimmed, until ready).
     (B) RACE — a stageFiles scan resolving AFTER an Add reset must not mutate the
         reassigned `current` or re-enable the panel (token guard bails).
   Plus: session memory still re-arms once a NEW file+location are staged.

   FAIL-ON-OLD: pre-fix the disabled panel only dims (body display≠none, Modified
   visible) and the late scan re-enables → (A) and (B) fail.
   Run: ./node_modules/.bin/electron test/panel_desync_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEST = '/tmp/squeeze-desync';

let nextVideo = { file: '/fake/a.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };
let scanDelay = 0;

let win;
ipcMain.handle('app-version', async () => 'desync');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('browse-source-files', async () => [nextVideo.file]);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => {
  if (scanDelay) await wait(scanDelay);
  return { rootKind: 'files', root: nextVideo.file, videos: [nextVideo], ignored: 0, totalSize: nextVideo.size };
});
ipcMain.handle('scan-source', async () => ({ rootKind: 'files', root: nextVideo.file, videos: [], ignored: 0, totalSize: 0 }));
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 20, preset: 'medium' } }));
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
  const browse  = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(scanDelay ? 60 : 600); };
  const chooseDest = async () => { await run(`document.getElementById('choose-dest').click(); true;`); await wait(300); };
  const clickAdd = async () => { await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300); };
  const sliderSet = async (key, val) => { await run(`(() => {
    const i = document.querySelector('#pro-panel input[type="range"][data-key="${key}"]');
    i.value = '${val}'; i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`); await wait(120); };
  const panelState = () => run(`(() => {
    const cs = (id) => getComputedStyle(document.getElementById(id)).display;
    const pb = document.getElementById('pro-panel');
    return {
      disabled: pb.classList.contains('disabled'),
      emptyShown: cs('pro-panel-empty') !== 'none',
      bodyDisplay: cs('pro-panel-body'),
      modDisplay: cs('pro-panel-modified'),
      cbHidden: document.getElementById('pro-downconvert').hidden,
      filesLen: current.files.length,
      scanned: current.scanned,
      armedQv: (armed.settings && armed.settings.qv)
    };
  })()`);

  await setMode(true);

  // ── (A) DETERMINISTIC: stage + qv85 + Add → clean empty prompt, armed value SUPPRESSED ──
  nextVideo = { file: '/fake/a.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };
  await browse(); await chooseDest();
  await sliderSet('qv', 85);
  await clickAdd();
  const a = await panelState();
  check(a.filesLen === 0 && a.scanned === false, `(A) current reset to empty after Add (files=${a.filesLen}, scanned=${a.scanned})`);
  check(a.disabled === true && a.emptyShown === true, `(A) panel disabled + empty prompt shown`);
  check(a.bodyDisplay === 'none' && a.modDisplay === 'none' && a.cbHidden === true,
    `(A) slider rows + Modified + checkbox SUPPRESSED, not dimmed (body=${a.bodyDisplay}, mod=${a.modDisplay}, cb-hidden=${a.cbHidden})`);
  check(a.armedQv === 85, `(A) session memory still holds qv=85 (armed, just not rendered) (got ${a.armedQv})`);

  // ── Re-arm: a NEW file+location → the remembered qv=85 renders again ──
  nextVideo = { file: '/fake/b.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };
  await browse();   // dest is sticky from the prior Add → ready=true
  const r = await panelState();
  const dv = await run(`document.querySelector('#pro-panel .sheet-label .val[data-key="qv"]').textContent`);
  check(r.bodyDisplay !== 'none' && r.disabled === false, `(re-arm) panel live once file+location staged`);
  check(dv === '85' && r.armedQv === 85, `(re-arm) session memory re-armed qv=85 (displayed ${dv})`);

  // clear staging back to empty for the race test
  await clickAdd();

  // ── (B) RACE: a slow scan resolving AFTER an Add reset must not re-enable ──
  nextVideo = { file: '/fake/c.mov', size: 1_000_000, duration: 60, pix_fmt: 'yuv420p10le' };
  scanDelay = 800;
  await browse();                 // stageFiles starts, awaits the delayed scan (scanned=false)
  await wait(150);
  await run(`clearDrop({ resetTier: true }); true;`);   // reassign `current` mid-scan
  await wait(1000);               // let the stale scan resolve
  scanDelay = 0;
  const b = await panelState();
  check(b.filesLen === 0 && b.scanned === false,
    `(B) late scan did NOT mutate the reset current (files=${b.filesLen}, scanned=${b.scanned})`);
  check(b.disabled === true, `(B) late scan did NOT re-enable the panel (disabled=${b.disabled})`);

  check(errors.length === 0, `no renderer console errors: ${errors.length ? errors.join(' | ') : 'none'}`);

  console.log('\n[panel-desync] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
