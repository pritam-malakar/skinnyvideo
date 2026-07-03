/* Repo regression (v2.8.1 — Bug A): the batch options menu (.row-menu, Pause/
   Stop) is a document.body child positioned ONCE from the trigger's viewport
   rect [renderer.js openRowMenu]. The real scroller is .app [styles.css:185],
   so on scroll the trigger moves while the menu stays pinned to the viewport.
   FIX: dismiss the menu when .app scrolls (listener added on open, removed on
   close), mirroring the existing click/Esc close.

   Real GUI path: loads src/renderer/index.html with the real preload, opens a
   running batch's row menu via the real openRowMenu, then fires a real .app
   scroll and asserts the menu is gone.
     Fail-on-old (no scroll listener): menu stays in the DOM after scroll.
     Pass-on-new: .app scroll dismisses it. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

// ---- minimal IPC: enough for a clean renderer load, no encodes ----
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

  // Open a running batch's options menu through the real openRowMenu, anchored
  // to a real element inside .app, then fire a real .app scroll event.
  const res = await run(`(() => {
    const appEl = document.querySelector('.app');
    const anchor = document.createElement('button');
    appEl.appendChild(anchor);
    openRowMenu(anchor, { id: 'b1', status: 'running' });
    const openedInDom = !!document.querySelector('.row-menu');
    const openedState = !!activeRowMenu;
    appEl.dispatchEvent(new Event('scroll'));
    const afterInDom = !!document.querySelector('.row-menu');
    const afterState = !!activeRowMenu;
    return { openedInDom, openedState, afterInDom, afterState };
  })()`);

  check(res.openedInDom && res.openedState, `menu opens (.row-menu in DOM: ${res.openedInDom}, activeRowMenu set: ${res.openedState})`);
  check(res.afterInDom === false, `.app scroll removes the menu from the DOM (still present: ${res.afterInDom})`);
  check(res.afterState === false, `.app scroll clears activeRowMenu (still set: ${res.afterState})`);
  check(errs.length === 0, `no renderer console errors (got ${errs.length}${errs.length ? ': ' + errs[0] : ''})`);

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
