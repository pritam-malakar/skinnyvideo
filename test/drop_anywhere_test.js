/* 3.3.0 Item 5 — "Drop anywhere" is true.
   REAL renderer + the REAL preload (wrapped by test/drop_preload.js only so a
   synthetic File maps to a path). A drop event dispatched on <body> must stage
   exactly what the same drop on the dropzone stages — same staging path, same
   scanner (scan-files IPC). Also: a drag with no files (queue reordering) is
   not treated as a drop, and a drop on the dropzone still stages once.

   FAIL-ON-OLD (3.2.2): only the dropzone listened; a drop on <body> staged
   nothing.
   Run: ./node_modules/.bin/electron test/drop_anywhere_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const scans = [];
ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
ipcMain.handle('stat-path', async () => ({ isFile: true, isDirectory: false }));
ipcMain.handle('scan-files', async (_e, paths) => {
  scans.push(paths);
  return { rootKind: 'files', root: paths[0], videos: paths.map((file) => ({ file, size: 1000, duration: 5 })), ignored: 0, totalSize: 1000 * paths.length };
});
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive', 'free-space'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'drop_preload.js'), contextIsolation: true, sandbox: false } });
  const run = (js) => win.webContents.executeJavaScript(js);
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(400);
  const label = await run(`(document.querySelector('.dz-well-label') || {}).textContent`);
  check(label === 'Drop anywhere', `the label still says "Drop anywhere" (${label})`);

  const drop = (selector, names, withFiles = true) => run(`(() => {
    const dt = new DataTransfer();
    ${withFiles ? `for (const n of ${JSON.stringify(names)}) dt.items.add(new File(['x'], n));` : `dt.setData('text/plain', '1');`}
    const target = ${selector === 'body' ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`};
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(over);
    const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
    return { overPrevented: over.defaultPrevented, dropPrevented: ev.defaultPrevented };
  })()`);
  const staged = () => run(`(current.files || []).map((f) => f.path || f.file)`);
  const reset = () => run(`clearDrop({ resetTier: true }); true`);

  const names = ['a.mov', 'b.mp4'];
  const zone = await drop('#dropzone', names);
  await wait(400);
  const viaZone = await staged();
  const zoneScans = scans.length;
  check(viaZone.length === 2, `dropzone drop stages both files (${JSON.stringify(viaZone)})`);
  check(zoneScans === 1, `dropzone drop scans once — not twice via the window listener (scans ${zoneScans})`);
  await reset(); await wait(200);

  const body = await drop('body', names);
  await wait(400);
  const viaBody = await staged();
  check(JSON.stringify(viaBody) === JSON.stringify(viaZone), `a drop on <body> stages the same files as the dropzone (${JSON.stringify(viaBody)})`);
  check(scans.length === 2 && JSON.stringify(scans[1]) === JSON.stringify(scans[0]), `same scanner, same paths (${JSON.stringify(scans)})`);
  check(body.overPrevented && body.dropPrevented, `window takes the drag (dragover/drop default prevented: ${JSON.stringify(body)})`);
  await reset(); await wait(200);

  const before = scans.length;
  await drop('body', [], false);
  await wait(300);
  check(scans.length === before && (await staged()).length === 0, 'a drag with no files (queue reordering) is not staged');

  console.log(`\n[drop-anywhere] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
