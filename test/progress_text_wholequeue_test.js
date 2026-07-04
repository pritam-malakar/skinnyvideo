/* Repo regression (v2.8.1 — Bug B): the progress card TEXT was batch-scoped.
   "Running: <name>" named the running BATCH (stale once its first file
   finished) and "File X of Y" used the per-batch pipeline count (d.total =
   scan.videos.length of the running batch). The overall bar is already
   whole-queue (computeQueueWork over `queue`); the text must tell the same
   story. FIX: derive both lines renderer-side from `queue` —
     - "Running: <file>" = the file actually encoding now, queue-wide;
     - "File X of Y" = position across ALL non-skipped files in ALL batches,
       with skipped files (status 'skipped') EXCLUDED from Y (mirrors the bar).

   Real GUI path: loads src/renderer/index.html with the real preload, seeds a
   mid-run multi-batch `queue` (batch A fully done incl. one SKIPPED file;
   batch B with its 1st file encoding), calls the real updateOverallProgressEta
   painter, and asserts the whole-queue text.
     Batch A non-skipped: a1,a2,a4 done (a3 skipped, dropped from the count).
     Batch B: b1 running, b2/b3 queued.
     Whole-queue: 3 done + b1 running → "File 4 of 6", "Running: b1.mov".
   Fail-on-old (per-batch text set only by the pipeline event, never by the
   painter): the seeded painter leaves the text empty / not "4 of 6". */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

ipcMain.handle('app-version', async () => '2.8.1-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('free-space', async () => ({ free: 9e15 }));
ipcMain.handle('choose-destination', async () => '/tmp/squeeze-verify-out');
ipcMain.handle('stat-path', async () => ({ isFile: false, isDirectory: true }));
ipcMain.handle('scan-files', async () => ({ rootKind: 'files', root: '/fake', ignored: 0, totalSize: 0, videos: [] }));
['browse-source-files', 'scan-source', 'save-last-src', 'add-reclaimed', 'delete-orphans',
 'open-path', 'reveal-path', 'reset-drive', 'reveal-in-finder', 'pause-batch', 'resume-batch',
 'cancel-batch', 'stop-queue', 'start-queue', 'set-batch-skips', 'enqueue-batch', 'remove-batch']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, backgroundColor: '#111111',
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);

  const paint = (setup) => run(`(() => {
    queue.length = 0;
    ${setup}
    updateOverallProgressEta();
    return { counts: progressCounts.textContent, running: progressBatch.textContent };
  })()`);

  // Scenario 1 — folder-named (real job name) batch running, whole-queue count.
  //   A: a1,a2,a4 done + a3 skipped (dropped); B: b1 running, b2/b3 queued.
  const s1 = await paint(`
    queue.push({ id: 'A', status: 'done', srcName: 'Batch A', tier: 'regular', files: [
      { name: 'a1.mov', status: 'done',    size: 100, outputSize: 40 },
      { name: 'a2.mov', status: 'done',    size: 100, outputSize: 40 },
      { name: 'a3.mov', status: 'skipped', size: 100 },
      { name: 'a4.mov', status: 'done',    size: 100, outputSize: 40 },
    ]});
    queue.push({ id: 'B', status: 'running', srcName: 'Project Reel', tier: 'regular', files: [
      { name: 'b1.mov', status: 'running', size: 100, progress: 20 },
      { name: 'b2.mov', status: 'queued',  size: 100 },
      { name: 'b3.mov', status: 'queued',  size: 100 },
    ]});
    currentBatchId = 'B';`);

  check(s1.counts === 'File 4 of 6', `"File X of Y" is whole-queue, skipped excluded — got "${s1.counts}" (want "File 4 of 6"; per-batch would be "File 1 of 3", skip-counted would be "File 4 of 7")`);
  check(s1.running === 'Running: Project Reel', `header names the encoding BATCH's job name — got "${s1.running}" (want "Running: Project Reel"; the file basename stays on #current-file)`);

  // Scenario 2 — filename ECHO: single loose-file batch labelled with the
  // file's own basename. Fallback → show the file, don't echo/stack a filename.
  const s2 = await paint(`
    queue.push({ id: 'C', status: 'running', srcName: 'IMG_0290.mov', tier: 'regular', files: [
      { name: 'IMG_0290.mov', status: 'running', size: 100, progress: 10 },
    ]});
    currentBatchId = 'C';`);
  check(s2.running === 'Running: IMG_0290.mov', `filename-echo label falls back to the file (no stacked/suffixed name) — got "${s2.running}" (want "Running: IMG_0290.mov")`);
  check(s2.counts === 'File 1 of 1', `echo case still whole-queue count — got "${s2.counts}" (want "File 1 of 1")`);

  // Scenario 3 — EMPTY batch name: fallback → file, never a blank "Running: ".
  const s3 = await paint(`
    queue.push({ id: 'D', status: 'running', srcName: '', tier: 'regular', files: [
      { name: 'clip.mov', status: 'running', size: 100, progress: 10 },
    ]});
    currentBatchId = 'D';`);
  check(s3.running === 'Running: clip.mov', `empty batch name falls back to the file (not a blank label) — got "${s3.running}" (want "Running: clip.mov")`);

  check(errs.length === 0, `no renderer console errors (got ${errs.length}${errs.length ? ': ' + errs[0] : ''})`);

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
