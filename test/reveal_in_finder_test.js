/* Regression: v2.1.17 FEATURE 1 — click a queue FILE NAME → reveal the
   ORIGINAL source in Finder, stat-gated.

   Drives the REAL renderer + REAL preload + REAL Electron IPC + the REAL
   src/main/reveal.js stat gate against REAL files on disk. Only the scan (file
   list) and the final showItemInFolder are substituted — the scan just supplies
   the rows (as every UI test does), and the reveal is a spy so Finder never
   pops while the stat gate runs for real.

   Asserts (ground truth):
     • Folder batch, EXISTING original → reveal invoked with the ORIGINAL path.
     • Folder batch, DELETED original  → stat gate blocks it: reveal NOT invoked,
       non-blocking notice shown (no modal/backdrop).
     • File-list batch (the folder-vs-file-list trap) → reveal invoked with the
       ORIGINAL source path, NEVER a temp hardlink (no squeeze-fl/Selected files).

   FAIL on old code: the file name carries no click handler, so reveal is never
   invoked and no notice appears → every assertion fails. PASS on the fix.

   Run:  ./node_modules/.bin/electron test/reveal_in_finder_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { revealInFinder } = require(path.join(ROOT, 'src/main/reveal'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

// ── Real files on disk (plain files — the stat gate only cares about existence) ──
const WORK = path.join(os.tmpdir(), 'reveal-test-' + process.pid);
const FOLDER = path.join(WORK, 'FolderBatch');
const LOOSE = path.join(WORK, 'loose');
const CLIP1 = path.join(FOLDER, 'clip1.mov');      // folder batch, stays → reveal ok
const CLIP2 = path.join(FOLDER, 'clip2.mov');      // folder batch, deleted → stat-gated
const MOVIEX = path.join(LOOSE, 'movieX.mov');     // file-list batch original
const TEST_DEST = path.join(WORK, 'out');

// ── reveal spy: REAL stat gate, only the Finder reveal is captured ──
const revealCalls = [];
ipcMain.handle('reveal-in-finder', async (_e, p) =>
  revealInFinder(p, { reveal: (x) => revealCalls.push(x) }));   // real fsp.stat

// ── scan stubs: supply the rows pointing at the REAL original paths ──
ipcMain.handle('scan-source', async () => ({
  rootKind: 'folder', root: FOLDER, ignored: 0, totalSize: 20,
  videos: [{ file: CLIP1, size: 10 }, { file: CLIP2, size: 10 }]
}));
ipcMain.handle('scan-files', async (_e, paths) => ({
  rootKind: 'files', root: paths[0], ignored: 0, totalSize: 10,
  videos: [{ file: MOVIEX, size: 10 }]
}));
ipcMain.handle('choose-destination', async () => TEST_DEST);
ipcMain.handle('app-version', async () => '2.1.17-test');
ipcMain.handle('stat-path', async (_e, p) => { try { const s = await fsp.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; } catch { return null; } });
ipcMain.handle('get-lifetime-drives', async () => []);
['save-last-src','add-reclaimed','free-space','delete-orphans',
 'open-path','reveal-path','reset-drive','pause-batch','resume-batch','cancel-batch',
 'stop-queue','start-queue','browse-source','browse-source-files']
  .forEach((ch) => ipcMain.handle(ch, async () => ({ ok: true })));

app.whenReady().then(async () => {
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.mkdirSync(LOOSE, { recursive: true });
  fs.writeFileSync(CLIP1, 'x'); fs.writeFileSync(CLIP2, 'x'); fs.writeFileSync(MOVIEX, 'x');

  const win = new BrowserWindow({ width: 1100, height: 1000, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, m) => { if (/error|is not defined|undefined/i.test(m)) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  const run = (js) => win.webContents.executeJavaScript(js);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(400);

  // dest, then a FOLDER batch, then a FILE-LIST batch — through the real flow.
  await run(`document.getElementById('choose-dest').click(); true;`); await wait(150);
  await run(`(async () => { await stageSource(${JSON.stringify(FOLDER)}); })()`); await wait(200);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(150);
  await run(`(async () => { await stageFiles([${JSON.stringify(MOVIEX)}]); })()`); await wait(200);
  await run(`document.getElementById('add-to-queue').click(); true;`); await wait(200);

  const queued = await run(`document.querySelectorAll('#queue .qbatch').length`);
  check(queued === 2, `two batches queued (got ${queued})`);

  // Sanity: rows carry the ORIGINAL paths and the name is clickable.
  const rowInfo = await run(`(() => {
    const rows = [...document.querySelectorAll('#queue .qrow')];
    return rows.map(r => ({ fpath: r.dataset.fpath,
      revealable: !!r.querySelector('.file .name.revealable') }));
  })()`);
  check(rowInfo.some(r => r.fpath === CLIP1) && rowInfo.some(r => r.fpath === MOVIEX),
    'file rows keep the ORIGINAL source path in data-fpath');
  check(rowInfo.every(r => r.revealable), 'every file name is clickable (.revealable)');

  const clickRow = (fpath) => run(
    `(() => { const r = document.querySelector('[data-fpath=' + JSON.stringify(${JSON.stringify(fpath)}) + ']');
       if (!r) return false; r.querySelector('.file .name.revealable').click(); return true; })()`);

  // 1) Folder batch, EXISTING original → reveal invoked with the ORIGINAL path.
  revealCalls.length = 0;
  check(await clickRow(CLIP1), 'clip1 row found + clicked');
  await wait(250);
  check(revealCalls.length === 1 && revealCalls[0] === CLIP1,
    `existing folder-batch original → reveal invoked with original (got ${JSON.stringify(revealCalls)})`);

  // 2) Folder batch, DELETED original → stat gate blocks reveal, notice shown.
  fs.rmSync(CLIP2, { force: true });
  revealCalls.length = 0;
  await clickRow(CLIP2); await wait(250);
  const notice = await run(`(() => { const n = document.getElementById('app-notice');
    return { shown: !!(n && n.classList.contains('show')), text: n ? n.textContent : '',
             modal: !!document.querySelector('.modal-backdrop') }; })()`);
  check(revealCalls.length === 0, `deleted original → reveal NOT invoked (got ${JSON.stringify(revealCalls)})`);
  check(notice.shown && /moved or been deleted/i.test(notice.text) && !notice.modal,
    `deleted original → non-blocking notice shown, no modal (got ${JSON.stringify(notice)})`);

  // 3) File-list batch (the trap) → reveal the ORIGINAL, never a temp hardlink.
  revealCalls.length = 0;
  check(await clickRow(MOVIEX), 'file-list row found + clicked');
  await wait(250);
  const got = revealCalls[0] || '';
  check(revealCalls.length === 1 && got === MOVIEX,
    `file-list batch → reveal invoked with ORIGINAL (got ${JSON.stringify(revealCalls)})`);
  check(!/squeeze-fl-|Selected files/.test(got),
    `file-list reveal path is NOT a temp hardlink (got "${got}")`);

  check(errs.length === 0, 'no renderer console errors: ' + (errs[0] || 'none'));
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
});
app.on('window-all-closed', () => app.quit());
