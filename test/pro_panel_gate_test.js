/* Batch-settings gate regression — REAL renderer + REAL preload + REAL IPC.
   The Pro/Nerd-mode "Batch settings" panel (#pro-panel) must not be interactive
   until the batch is ACTIONABLE (staged files AND an output location) — matching
   "Add batch". It's a DOM sibling after the tier cards, so the tier step's
   `inert` lock can't cover it; the gate condition has to carry the location term.

   Drives the real staging flow (Pro toggle → file-list browse → choose location).
   Asserts the three states + the conditional prompt copy.

   FAIL-ON-OLD: pre-fix the gate keyed on files-only, so with files staged and NO
   location the panel was ENABLED → the "files, no location → disabled" assertions
   FAIL. Pass-on-new.
   Run:  ./node_modules/.bin/electron test/pro_panel_gate_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = '/fake/gate-clip.mov';
const DEST = '/tmp/squeeze-pro-gate';

let win;
ipcMain.handle('app-version', async () => 'gate-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('choose-destination', async () => DEST);
ipcMain.handle('browse-source-files', async () => [FAKE]);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async () => ({
  rootKind: 'files', root: FAKE,
  videos: [{ file: FAKE, size: 1_000_000, duration: 60 }], ignored: 0, totalSize: 1_000_000
}));
ipcMain.handle('scan-source', async () => ({ rootKind: 'files', root: FAKE, videos: [], ignored: 0, totalSize: 0 }));
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
  const browse  = async () => { await run(`document.getElementById('dz-browse').click(); true;`); await wait(600); };
  const chooseDest = async () => { await run(`document.getElementById('choose-dest').click(); true;`); await wait(300); };
  const gate = () => run(`(() => {
    const panel = document.getElementById('pro-panel');
    const slider = document.querySelector('#pro-panel input[type="range"]');
    const empty = document.getElementById('pro-panel-empty');
    return {
      disabled: panel.classList.contains('disabled'),
      sliderDisabled: slider ? slider.disabled : null,
      emptyShown: getComputedStyle(empty).display !== 'none',
      emptyText: empty.textContent.trim()
    };
  })()`);

  await setMode(true);   // Pro/Nerd mode → panel visible

  // State 1 — no files: disabled, "Drop files…" prompt.
  let g = await gate();
  check(g.disabled === true && g.sliderDisabled === true,
    `no files → panel disabled + slider disabled (disabled=${g.disabled}, slider=${g.sliderDisabled})`);
  check(g.emptyShown === true && /drop files/i.test(g.emptyText),
    `no files → prompt reads "Drop files…" (got ${JSON.stringify(g.emptyText)})`);

  // State 2 — files staged, NO location: STILL disabled, location prompt. (FAIL-ON-OLD)
  await browse();
  g = await gate();
  check(g.disabled === true, `files but NO location → panel still disabled (got disabled=${g.disabled})`);
  check(g.sliderDisabled === true, `files but NO location → Quality slider disabled (got ${g.sliderDisabled})`);
  check(g.emptyShown === true && /pick an output location/i.test(g.emptyText),
    `files but NO location → prompt reads "Pick an output location…" (got ${JSON.stringify(g.emptyText)})`);

  // State 3 — location set: enabled, inputs live, location prompt gone.
  await chooseDest();
  g = await gate();
  check(g.disabled === false, `file + location → panel enabled (got disabled=${g.disabled})`);
  check(g.sliderDisabled === false, `file + location → Quality slider enabled (got ${g.sliderDisabled})`);
  check(g.emptyShown === false, `file + location → no disabled prompt shown (emptyShown=${g.emptyShown})`);

  check(errors.length === 0, `no renderer console errors: ${errors.length ? errors.join(' | ') : 'none'}`);

  console.log('\n[pro-panel-gate] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
