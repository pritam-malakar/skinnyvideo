/* Finalizing UX regression (v2.2.8) — REAL renderer + REAL preload + REAL IPC.
   Drives the progress stream by hand (no encode) to assert the honest
   finalizing state:
     (a) running file pinned ≳99% with no fresh progress → instant heuristic:
         indeterminate cyan bar + "Finishing up…", and the ETA strip does NOT
         render a fabricated "~10s left";
     (b) a confirmed type:'finalizing' IPC → label upgrades to "Writing to
         disk — …";
     (c) file-done → finalizing state cleared (no class, note hidden).
   FAIL-ON-OLD: old renderer freezes at the last % and shows "~10s left" with no
   finalizing class / note → (a)+(c) fail. Pass-on-new.
   Run:  ./node_modules/.bin/electron test/finalizing_ui_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = '/fake/clip.mov';
const DEST = '/tmp/skinnyvideo-finalizing-ui';

let win;
const send = (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); };

// ── minimal main mirror: just enough for the real add+start flow to run ──
ipcMain.handle('app-version', async () => '2.2.8-test');
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
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
// start-queue does NOT run a real queue — we drive progress events by hand.
ipcMain.handle('start-queue', async () => ({ ok: true }));
ipcMain.handle('stop-queue', async () => ({ ok: true }));
ipcMain.handle('enqueue-batch', async () => ({ ok: true, absorbed: false }));
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive',
 'reveal-in-finder', 'pause-batch', 'resume-batch', 'cancel-batch', 'set-batch-skips'
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

  // Source-level guarantee: the fabricated fallback floor is gone from the code.
  const rendererSrc = require('fs').readFileSync(path.join(ROOT, 'src/renderer/renderer.js'), 'utf8');
  check(!rendererSrc.includes("|| '~10s left'"), "fabricated `|| '~10s left'` fallback removed from renderer.js");

  // Seed one file-list batch through the real add flow.
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`document.getElementById('dz-browse').click(); true;`); await wait(500);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(300);
  const id = await run(`(queue && queue[0] ? queue[0].id : null)`);
  check(id != null, `batch seeded (id=${id})`);

  // Start the run (flips runActive, starts the 1s ETA ticker), then drive events.
  await run(`document.getElementById('start').click(); true;`); await wait(200);
  send('batch-status', { id, status: 'Running' });
  await wait(50);
  send('progress', { batchId: id, type: 'file-start', index: 1, total: 1, file: FAKE, basename: 'clip.mov' });
  await wait(50);
  send('progress', { batchId: id, type: 'file-progress', index: 1, total: 1, file: FAKE, fileProgress: 0.995 });
  await wait(50);

  const readUI = () => run(`(() => {
    const card = document.getElementById('progress-card');
    const note = document.getElementById('finalizing-note');
    const eta  = document.getElementById('current-eta');
    const strip= document.getElementById('stat-eta');
    const row  = document.querySelector('.qrow[data-fpath=${JSON.stringify(FAKE)}] .status .progressbar');
    return {
      finalizingClass: card ? card.classList.contains('finalizing') : null,
      noteHidden: note ? note.hidden : null,
      noteText: note ? note.textContent : null,
      etaText: eta ? eta.textContent : null,
      etaHidden: strip ? strip.classList.contains('hidden') : null,
      rowIndeterminate: row ? row.classList.contains('indeterminate') : null
    };
  })()`);

  // (a) Instant heuristic — the 1s ETA ticker flips it on the first tick after
  // staleness crosses 2s. Wait > 2s + a full tick interval to land on that tick.
  await wait(3700);
  let ui = await readUI();
  check(ui.finalizingClass === true, `(a) heuristic: progress card marked finalizing (got ${ui.finalizingClass})`);
  check(ui.rowIndeterminate === true, `(a) heuristic: running file bar indeterminate (got ${ui.rowIndeterminate})`);
  check(typeof ui.noteText === 'string' && ui.noteText.includes('Finishing up'),
    `(a) heuristic: note reads "Finishing up…" (got ${JSON.stringify(ui.noteText)})`);
  check(ui.etaHidden === true && ui.etaText !== '~10s left',
    `(a) heuristic: no fabricated "~10s left" countdown (etaHidden=${ui.etaHidden}, etaText=${JSON.stringify(ui.etaText)})`);

  // (b) Confirmed signal — label upgrades.
  send('progress', { batchId: id, type: 'finalizing', index: 1, total: 1, file: FAKE, basename: 'clip.mov' });
  await wait(100);
  ui = await readUI();
  check(ui.finalizingClass === true && typeof ui.noteText === 'string' && ui.noteText.includes('Writing to disk'),
    `(b) confirmed: note upgrades to "Writing to disk — …" (got ${JSON.stringify(ui.noteText)})`);
  check(ui.rowIndeterminate === true, `(b) confirmed: bar still indeterminate (got ${ui.rowIndeterminate})`);

  // (c) file-done — clears the finalizing state.
  send('progress', { batchId: id, type: 'file-done', index: 1, total: 1, file: FAKE, basename: 'clip.mov',
    outcome: 'ok', outBytes: 500_000, inBytes: 1_000_000, processed: 1, failed: 0, alreadyDone: 0, reclaimed: 500_000 });
  await wait(150);
  ui = await readUI();
  check(ui.finalizingClass === false, `(c) file-done: finalizing class cleared (got ${ui.finalizingClass})`);
  check(ui.noteHidden === true, `(c) file-done: note hidden (got ${ui.noteHidden})`);

  check(errors.length === 0, `no renderer console errors: ${errors.length ? errors.join(' | ') : 'none'}`);

  console.log('\n[finalizing-ui] PASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error('TEST ERROR', e); app.exit(2); });
