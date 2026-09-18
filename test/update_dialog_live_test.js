/* The update offer, LIVE: real main.js, real updater.js, real electron-updater,
   against a local feed advertising a newer version. Only two things are
   stubbed — the feed URL (dev-only env override) and dialog.showMessageBox,
   because a test cannot click a native sheet.
   Proves: the sheet is parented on the main window (so it is a sheet, not a
   free-floating box), carries Download / Skip This Version / Later, and that
   "Skip This Version" is persisted — a SECOND launch against the same feed and
   the same userData is never offered that version again.
   Run: ./node_modules/.bin/electron test/update_dialog_live_test.js */
const { app, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERSION = '99.9.9';
const ROLE = process.env.SV_TEST_ROLE || 'parent';
const UD = process.env.SV_TEST_UD || fs.mkdtempSync(path.join(os.tmpdir(), 'sv-updlive-'));
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', UD);

/* A feed of the shape electron-updater's generic provider expects. */
const FEED = [
  `version: ${VERSION}`,
  'files:',
  `  - url: SkinnyVideo-${VERSION}-arm64-mac.zip`,
  '    sha512: ' + 'A'.repeat(88),
  '    size: 1024',
  `path: SkinnyVideo-${VERSION}-arm64-mac.zip`,
  'sha512: ' + 'A'.repeat(88),
  "releaseDate: '2026-09-18T00:00:00.000Z'",
  '',
].join('\n');

const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url.startsWith('/latest-mac.yml')) { res.writeHead(200, { 'Content-Type': 'text/yaml' }); res.end(FEED); }
  else { res.writeHead(404); res.end(); }
});

/* Capture every message box instead of showing it. */
const boxes = [];
dialog.showMessageBox = (...args) => {
  const parented = args.length > 1 && args[0] && typeof args[0].isDestroyed === 'function';
  const opts = args.length > 1 ? args[1] : args[0];
  boxes.push({ parented, opts });
  // Parent picks "Skip This Version"; the child must never be asked at all.
  return Promise.resolve({ response: 1 });
};

function finish(code) {
  try { server.close(); } catch {}
  console.log(`\n[update-dialog-live:${ROLE}] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  app.exit(code === undefined ? (FAIL.length ? 1 : 0) : code);
}

server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  process.env.SKINNYVIDEO_DEV_UPDATER = '1';
  process.env.SKINNYVIDEO_DEV_FEED_URL = url;
  require(path.join(ROOT, 'src/main/main.js'));

  app.whenReady().then(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    // The first check fires 10 s after installUpdater(); give it room.
    for (let i = 0; i < 100 && boxes.length === 0; i++) await wait(250);
    const prefs = () => { try { return JSON.parse(fs.readFileSync(path.join(UD, 'prefs.json'), 'utf8')); } catch { return {}; } };

    if (ROLE === 'parent') {
      check(requests.some((u) => u.startsWith('/latest-mac.yml')), `the updater fetched the stubbed feed (${requests.join(', ') || 'no requests'})`);
      check(boxes.length === 1, `exactly one sheet was shown (${boxes.length})`);
      const b = boxes[0] || { opts: {} };
      check(b.parented === true, 'shown on the main window (a sheet), not as a free-floating box');
      check(b.opts.type === 'info' && b.opts.message === `SkinnyVideo ${VERSION} is available`,
        `type=info, message="${b.opts.message}"`);
      check(b.opts.detail === 'Download it now? You can install it whenever you’re ready.', `detail: "${b.opts.detail}"`);
      check(JSON.stringify(b.opts.buttons) === JSON.stringify(['Download', 'Skip This Version', 'Later']),
        `buttons: ${JSON.stringify(b.opts.buttons)}`);
      check(b.opts.defaultId === 0 && b.opts.cancelId === 2 && b.opts.noLink === true,
        `defaultId=${b.opts.defaultId}, cancelId=${b.opts.cancelId}, noLink=${b.opts.noLink}`);
      await wait(600);
      check(prefs().skippedUpdateVersion === VERSION, `Skip persisted to prefs.json (${JSON.stringify(prefs().skippedUpdateVersion)})`);

      // Second launch, same userData and feed: the skipped version must not be offered.
      const child = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, SV_TEST_ROLE: 'child', SV_TEST_UD: UD },
        encoding: 'utf8', timeout: 120000,
      });
      const out = (child.stdout || '') + (child.stderr || '');
      console.log(out.split('\n').filter((l) => /^(PASS|FAIL):|skipped .* not offered|update available/.test(l)).map((l) => '    ' + l).join('\n'));
      check(child.status === 0, `second launch: the skipped version was not offered again (child exit ${child.status})`);
      try { fs.rmSync(UD, { recursive: true, force: true }); } catch {}
      return finish();
    }

    // child
    check(boxes.length === 0, `no sheet on the second launch (${boxes.length} shown)`);
    check(prefs().skippedUpdateVersion === VERSION, 'the skip is still recorded');
    return finish();
  });
});
