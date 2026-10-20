/* 3.3.0 Item 10 — the Output folder is remembered across launches.

   VALIDATE (plain node, REAL prefs-store.usableDir): an existing writable
            folder is returned; a missing folder, a file, a read-only folder,
            a relative path and a non-string all give null.
   UI       (REAL renderer + REAL preload, fresh window per case): when main's
            get-last-dest answers a folder, Output shows it and Add can use
            it; when it answers null, Output stays the placeholder exactly as
            today.
   MAIN     main.js saves the chosen folder (prefs.lastDest) in
            choose-destination and serves it through usableDir.

   FAIL-ON-OLD (3.2.2): nothing persisted the Output folder; every launch
   started unset.
   Run: ./node_modules/.bin/electron test/output_folder_test.js */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-outdir-')));

let answer = null;
ipcMain.handle('get-last-dest', async () => answer);
ipcMain.handle('app-version', async () => '3.3.0-test');
ipcMain.handle('check-engine', async () => ({ ok: true }));
ipcMain.handle('get-tier-defaults', async () => ({ regular: { vcodec: 'hevc_videotoolbox', qv: 62 }, preserve: { vcodec: 'libx265', crf: 18, preset: 'medium' } }));
ipcMain.handle('get-lifetime-drives', async () => []);
['save-last-src', 'add-reclaimed', 'delete-orphans', 'open-path', 'reveal-path', 'reset-drive', 'free-space', 'stat-path'].forEach((c) => ipcMain.handle(c, async () => ({ ok: true })));

let win = null;   // one window, a fresh page load per case (= a fresh launch of the renderer)
async function uiWith(value) {
  answer = value;
  if (!win) win = new BrowserWindow({ width: 1000, height: 800, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await wait(500);
  return win.webContents.executeJavaScript(`(() => { const el = document.getElementById('dest-path');
    return { text: el.textContent, placeholder: el.classList.contains('placeholder'), dest: current.dest || null }; })()`);
}

app.whenReady().then(async () => {
  try {
    // ── VALIDATE ──
    let usableDir = null;
    try { ({ usableDir } = require(path.join(ROOT, 'src/main/prefs-store'))); } catch {}
    check(typeof usableDir === 'function', 'prefs-store exports usableDir');
    if (typeof usableDir === 'function') {
      const ok = path.join(SB, 'Out'); fs.mkdirSync(ok);
      const ro = path.join(SB, 'ReadOnly'); fs.mkdirSync(ro); fs.chmodSync(ro, 0o555);
      const file = path.join(SB, 'file.txt'); fs.writeFileSync(file, 'x');
      check(usableDir(ok) === ok, 'existing writable folder is kept');
      check(usableDir(path.join(SB, 'Gone')) === null, 'missing folder → unset');
      check(usableDir(file) === null, 'a file → unset');
      check(usableDir(ro) === null, 'read-only folder → unset');
      check(usableDir('relative/Out') === null && usableDir(null) === null && usableDir(42) === null, 'relative path / null / non-string → unset');
      fs.chmodSync(ro, 0o755);
    }
    // ── MAIN wiring (source-level: main is not loadable outside the app) ──
    const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
    check(/prefs\.lastDest = r\.filePaths\[0\]/.test(main) && /ipcMain\.handle\('get-last-dest', async \(\) => usableDir\(prefs\.lastDest\)\)/.test(main),
      'main saves the chosen folder and serves it through usableDir');
    // ── UI ──
    const dest = path.join(SB, 'Out');
    const a = await uiWith(dest);
    check(a.dest === dest && a.text === dest && !a.placeholder, `remembered folder shown at launch (${JSON.stringify(a)})`);
    const b = await uiWith(null);
    check(b.dest === null && b.placeholder, `no usable folder → Output left unset, placeholder shown (${JSON.stringify(b)})`);
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[output-folder] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(FAIL.length ? 1 : 0);
});
