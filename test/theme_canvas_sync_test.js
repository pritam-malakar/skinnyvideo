/* Window canvas ↔ renderer --canvas sync (macOS 27 corner-mask wedge).

   THE BUG: NSWindow's backgroundColor was hardcoded '#111111' in
   createWindow() while the renderer's light theme paints --canvas #E3E3E3.
   The macOS corner mask carves an arc out of the window; the crescent between
   that arc and the square top edge of the web contents is never painted by the
   renderer, so it shows NSWindow's backgroundColor. On Golden Gate the uniform
   ~20pt mask makes that crescent big enough to read as a wedge — near-black on
   light grey in light appearance.

   This drives the REAL boot path: the real main.js, the real createWindow(),
   the real BrowserWindow, the real nativeTheme, and the real 'theme:changed'
   handler. Nothing about the colour is mocked — every asserted value is read
   back off the live window with getBackgroundColor(), and the expected values
   come from src/shared/theme.js, which is itself checked against styles.css.

   userData is redirected to a temp dir BEFORE main.js is required, so the real
   prefs.json / history ledger on this machine is never read or written.

   FAIL-ON-OLD: against the hardcoded '#111111' the seed check reports #111111
   where CANVAS.light is expected, and both mirror checks fail because no
   'theme:changed' listener exists to move the colour at all. Pass-on-new.
   Run:  ./node_modules/.bin/electron test/theme_canvas_sync_test.js */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { CANVAS } = require(path.join(ROOT, 'src/shared/theme'));
const STYLES = path.join(ROOT, 'src/renderer/styles.css');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
/* Electron normalises the colour it stores; compare on value, not spelling. */
const sameColor = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/* ── Hermetic userData. MUST precede require('main.js'): prefsPath() resolves
      app.getPath('userData') lazily, so redirecting it here sends the whole
      launch — migration, loadPrefs, the orphan sweep — at a throwaway dir. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyvideo-theme-'));
app.setPath('userData', SANDBOX);

/* ── Force LIGHT appearance before main.js registers its whenReady handler, so
      createWindow() genuinely computes its seed from shouldUseDarkColors ===
      false. themeSource is real Electron state, not a stub. */
nativeTheme.themeSource = 'light';

require(path.join(ROOT, 'src/main/main.js'));

/* ── 3. Drift: CANVAS must equal what --canvas resolves to in the stylesheet.
      styles.css is the design authority; this is what catches a palette edit
      that moves the canvas and leaves the window colour behind. */
function canvasFromStyles(theme) {
  const css = fs.readFileSync(STYLES, 'utf8');
  const block = new RegExp('html\\[data-theme="' + theme + '"\\]\\s*\\{([\\s\\S]*?)\\}').exec(css);
  if (!block) return null;
  const decl = /--canvas\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(block[1]);
  return decl ? decl[1] : null;
}

function driftChecks() {
  for (const theme of ['dark', 'light']) {
    const fromCss = canvasFromStyles(theme);
    check(fromCss !== null, `styles.css declares --canvas for html[data-theme="${theme}"]`);
    check(fromCss !== null && sameColor(fromCss, CANVAS[theme]),
      `CANVAS.${theme} (${CANVAS[theme]}) matches styles.css --canvas (${fromCss}) — styles.css is authoritative`);
  }
}

function finish() {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('\n[theme-canvas-sync] PASS: ' + PASS.length + ' FAIL: ' + FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}

app.on('window-all-closed', () => { /* held open by the test */ });

/* Registered AFTER main.js's own whenReady handler, so by the time this runs
   createWindow() has already returned and the window exists — but loadFile is
   still in flight, so the renderer has not yet sent its own theme:changed.
   This is therefore the CONSTRUCTION seed, uncontaminated by the mirror. */
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { check(false, 'createWindow() produced a BrowserWindow'); return finish(); }

  /* ── 1. Seed at construction, light appearance. */
  check(nativeTheme.shouldUseDarkColors === false,
    'nativeTheme.shouldUseDarkColors is false (light appearance forced)');
  const seeded = win.getBackgroundColor();
  check(sameColor(seeded, CANVAS.light),
    `createWindow() seeded backgroundColor ${seeded} === CANVAS.light (${CANVAS.light})`);

  /* Let the renderer finish loading so its own startup setTheme lands before
     the mirror checks — otherwise a late send could race the assertions. */
  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });
  await new Promise((r) => setTimeout(r, 300));

  check(sameColor(win.getBackgroundColor(), CANVAS.light),
    `after renderer load in light appearance the window is still CANVAS.light (${win.getBackgroundColor()})`);

  /* ── 2. The real 'theme:changed' handler, both directions. ipcMain.emit
        invokes the listener main.js actually registered (this is why the
        channel is send/on, not invoke/handle) with the same payload shape
        preload sends. The colour is then read back off the live window. */
  const beforeDark = win.getBackgroundColor();
  ipcMain.emit('theme:changed', {}, { dark: true });
  const afterDark = win.getBackgroundColor();
  check(sameColor(afterDark, CANVAS.dark),
    `'theme:changed' { dark: true } set backgroundColor ${afterDark} === CANVAS.dark (${CANVAS.dark})`);
  /* The value alone cannot prove the handler ran: the OLD hardcoded '#111111'
     already equals CANVAS.dark, so a window stuck on it would pass the check
     above by coincidence. Assert the emit actually MOVED the colour. */
  check(!sameColor(beforeDark, afterDark),
    `the { dark: true } emit changed the window colour (${beforeDark} → ${afterDark}), not a coincidental match`);

  ipcMain.emit('theme:changed', {}, { dark: false });
  const afterLight = win.getBackgroundColor();
  check(sameColor(afterLight, CANVAS.light),
    `'theme:changed' { dark: false } set backgroundColor ${afterLight} === CANVAS.light (${CANVAS.light})`);

  /* A destroyed window must not throw on a late send. */
  let threw = false;
  win.destroy();
  try { ipcMain.emit('theme:changed', {}, { dark: true }); } catch { threw = true; }
  check(!threw, "'theme:changed' after the window is destroyed is a no-op, not a throw");

  driftChecks();
  finish();
});
