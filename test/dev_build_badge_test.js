/* Dev build must be unmistakable in the footer badge.

   THE PROBLEM: the badge rendered app.getVersion() raw. In dev that reads
   package.json, when packaged it reads CFBundleShortVersionString, and right
   after a release the two are the SAME string — so a `npm start` window and
   the copy in /Applications both showed "v3.0.2" and a stale instance could be
   mistaken for the build under test.

   Real code path throughout: the real main.js, the real 'app-version' handler,
   the real preload bridge (the string is fetched with window.api.getAppVersion
   from inside the renderer, so it genuinely crosses IPC), and the real
   renderer DOM. The packaged branch is exercised through the pure descriptor,
   because app.isPackaged is really false in a dev process and cannot honestly
   be forced to true.

   userData is redirected to a temp dir BEFORE main.js is required, so this
   machine's prefs.json / history ledger are never read or written.

   FAIL-ON-OLD: the old handler returned app.getVersion() verbatim, so the IPC
   string carries no -dev segment and the badge renders no chip. Pass-on-new.
   Run:  ./node_modules/.bin/electron test/dev_build_badge_test.js */
const { app, BrowserWindow, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { buildDescriptor, readGitShortHash, SHORT_LEN } = require(path.join(ROOT, 'src/main/build-id'));
const PKG_VERSION = require(path.join(ROOT, 'package.json')).version;
/* app.getVersion() reads package.json under `electron .` (how npm start runs)
   but falls back to Electron's own version when a test script is the entry
   point. Compare the IPC string against what MAIN actually saw — the same app
   object — not against package.json, or this asserts a harness artifact. */
const MAIN_VERSION = app.getVersion();
const GIT_DIR = path.join(ROOT, '.git');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

/* Hermetic userData — must precede require('main.js'); prefsPath() resolves
   app.getPath('userData') lazily, so this redirects the whole launch. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyvideo-devbadge-'));
app.setPath('userData', SANDBOX);
nativeTheme.themeSource = 'dark';

require(path.join(ROOT, 'src/main/main.js'));

/* ── Pure descriptor: both branches, against the REAL .git of this repo. */
function descriptorChecks() {
  const packaged = buildDescriptor({ version: PKG_VERSION, packaged: true, gitDir: GIT_DIR });
  check(packaged === PKG_VERSION,
    `packaged descriptor is the version verbatim: ${packaged} === ${PKG_VERSION}`);
  check(!/-dev/.test(packaged), 'packaged descriptor carries no -dev segment');

  const dev = buildDescriptor({ version: PKG_VERSION, packaged: false, gitDir: GIT_DIR });
  check(dev.startsWith(PKG_VERSION + '-dev'),
    `dev descriptor starts with "${PKG_VERSION}-dev": ${dev}`);
  check(new RegExp('^' + PKG_VERSION.replace(/\./g, '\\.') + '-dev\\.[0-9a-f]{' + SHORT_LEN + '}$').test(dev),
    `dev descriptor carries a ${SHORT_LEN}-char sha: ${dev}`);

  /* The hash must be HEAD's, not a stale packed-refs snapshot. This repo has a
     packed-refs entry for refs/heads/main that is many commits behind the
     loose ref, so preferring the wrong file is silently wrong, not an error. */
  const head = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
  const ref = /^ref:\s*(.+)$/.exec(head);
  let expected = null;
  try {
    expected = ref
      ? fs.readFileSync(path.join(ROOT, '.git', ref[1].trim()), 'utf8').trim().slice(0, SHORT_LEN)
      : head.slice(0, SHORT_LEN);
  } catch { /* packed-only checkout — skip the comparison below */ }
  if (expected) {
    check(readGitShortHash(GIT_DIR) === expected,
      `short hash is HEAD's loose ref (${readGitShortHash(GIT_DIR)} === ${expected}), not packed-refs`);
  }

  /* Unreadable .git degrades, never throws, on the launch path. */
  const missing = path.join(SANDBOX, 'no-such-git');
  check(buildDescriptor({ version: PKG_VERSION, packaged: false, gitDir: missing }) === PKG_VERSION + '-dev',
    `unreadable .git falls back to "${PKG_VERSION}-dev"`);
}

function finish() {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('\n[dev-build-badge] PASS: ' + PASS.length + ' FAIL: ' + FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}

app.on('window-all-closed', () => { /* held open by the test */ });

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { check(false, 'createWindow() produced a BrowserWindow'); return finish(); }

  await new Promise((resolve) => {
    if (!win.webContents.isLoading()) return resolve();
    win.webContents.once('did-finish-load', resolve);
  });

  /* ── Over the real bridge, over the real channel, from the renderer. */
  const overIpc = await win.webContents.executeJavaScript('window.api.getAppVersion()');
  check(/-dev(\.|$)/.test(overIpc),
    `'app-version' over IPC ends with a -dev segment in a dev build: ${overIpc}`);
  check(overIpc.startsWith(MAIN_VERSION + '-dev'),
    `IPC string is main's own version plus the dev tail (${MAIN_VERSION}): ${overIpc}`);
  check(overIpc === buildDescriptor({ version: MAIN_VERSION, packaged: false, gitDir: GIT_DIR }),
    'IPC string equals the descriptor computed independently from .git');

  /* ── The badge actually renders it, with the tail in its own lemon chip. */
  const badge = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('app-version');
    const chip = el && el.querySelector('.dev-chip');
    return {
      base: el && el.firstChild ? el.firstChild.textContent : null,
      chip: chip ? chip.textContent : null,
      title: el ? el.title : null,
      chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
      lemon: getComputedStyle(document.documentElement).getPropertyValue('--lemon').trim()
    };
  })()`);
  const cut = overIpc.indexOf('-dev');
  check(badge.base === 'v' + overIpc.slice(0, cut),
    `badge base is the plain version: ${badge.base}`);
  check(badge.chip === overIpc.slice(cut + 1),
    `dev tail is split into its own chip, sha intact: ${badge.chip}`);
  /* base + chip must reconstruct the descriptor exactly — no character of the
     sha may be dropped by the split. */
  check(badge.base.replace(/^v/, '') + '-' + badge.chip === overIpc,
    'base + chip reconstruct the IPC string with nothing lost');
  check(badge.title === 'v' + overIpc,
    `the unbroken string is on the title for copying: ${badge.title}`);
  check(badge.chipBg === 'rgb(255, 216, 77)',
    `chip fill is the lemon token ${badge.lemon} (computed ${badge.chipBg})`);

  descriptorChecks();
  finish();
});
