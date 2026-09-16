/* Keep-awake during a run — REAL main.js, REAL powerSaveBlocker, REAL encodes.
   One 'prevent-app-suspension' blocker exists exactly while a queue runs, and
   is released however the run ends:
     1. a refused start-queue payload never starts one
     2. a run that finishes releases it
     3. a run cancelled mid-encode releases it
     4. "Stop and quit" (⌘Q during a run, dialog answered) releases it before
        the app quits
   After every scenario no blocker this app started is still active.
   FAIL-ON-OLD: main.js never called powerSaveBlocker — scenario 2 sees no
   blocker during the run.
   Run: ./node_modules/.bin/electron test/keep_awake_test.js */
const { app, BrowserWindow, powerSaveBlocker, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-keepawake-')));
app.setPath('userData', path.join(SANDBOX, 'userData'));
const SHORT = path.join(SANDBOX, 'Short');
const LONG = path.join(SANDBOX, 'Long');
const DEST = path.join(SANDBOX, 'Out');
for (const d of [SHORT, LONG, DEST]) fs.mkdirSync(d);
const enc = (out, size, secs) => spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi',
  '-i', `testsrc2=size=${size}:rate=30:duration=${secs}`, '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', out]);
enc(path.join(SHORT, 'a.mov'), '320x240', 1);
enc(path.join(LONG, 'b.mov'), '1920x1080', 20);   // x265 'preserve' takes far longer than the test waits

/* Record every blocker main starts; the real API still does the work. */
const started = [];
const stopped = [];
const realStart = powerSaveBlocker.start.bind(powerSaveBlocker);
const realStop = powerSaveBlocker.stop.bind(powerSaveBlocker);
powerSaveBlocker.start = (type) => { const id = realStart(type); started.push({ id, type }); return id; };
powerSaveBlocker.stop = (id) => { stopped.push(id); return realStop(id); };
const anyActive = () => started.some((s) => powerSaveBlocker.isStarted(s.id));
/* "Stop and quit" answers the close-guard dialog without a human. */
dialog.showMessageBoxSync = () => 1;

require(path.join(ROOT, 'src/main/main.js'));

function finish(code) {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log('\n[keep-awake] PASS: ' + PASS.length + ' FAIL: ' + FAIL.length);
  app.exit(code === undefined ? (FAIL.length ? 1 : 0) : code);
}
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    await wait(50);
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const batch = (id, src, tier) => JSON.stringify({ id, src, dest: DEST, tier, dryRun: false, kind: 'folder', fileSources: [], skipped: [] });
    await js(`window.__status = {}; window.api.onBatchStatus(({ id, status }) => { window.__status[id] = status; }); 0`);

    // 1. refused payload
    const bad = await js(`window.api.startQueue([{ id: 1, kind: 'folder' }])`);
    check(bad.ok === false && started.length === 0, 'refused start-queue payload starts no blocker');

    // 2. run to completion
    await js(`window.__run = window.api.startQueue([${batch(2, SHORT, 'regular')}]); 0`);
    let seen = false;
    for (let i = 0; i < 100 && !seen; i++) { seen = anyActive(); if (!seen) await wait(20); }
    check(seen, 'a blocker is active while the run is in progress');
    check(started.length === 1 && started[0].type === 'prevent-app-suspension', `exactly one 'prevent-app-suspension' blocker (${JSON.stringify(started)})`);
    const r2 = await js('window.__run');
    check(r2.ok === true && (await js('window.__status[2]')) === 'Done', `run finished Done (${await js('window.__status[2]')})`);
    check(!anyActive(), 'blocker released when the run finished');

    // 3. cancel mid-encode
    await js(`window.__run = window.api.startQueue([${batch(3, LONG, 'preserve')}]); 0`);
    for (let i = 0; i < 200 && (await js('window.__status[3]')) !== 'Running'; i++) await wait(25);
    await wait(1500);   // well inside the x265 encode
    check(anyActive(), 'blocker active during the long encode');
    await js('window.api.cancelBatch(3)');
    await js('window.__run');
    check((await js('window.__status[3]')) === 'Cancelled', `batch reported Cancelled (${await js('window.__status[3]')})`);
    check(!anyActive(), 'blocker released after a cancelled run');
    check(started.length === 2, `one blocker per run, none leaked by double start (${started.length})`);

    // 4. Stop and quit during a run
    await js(`window.__run = window.api.startQueue([${batch(4, LONG, 'preserve')}]); 0`);
    for (let i = 0; i < 200 && (await js('window.__status[4]')) !== 'Running'; i++) await wait(25);
    await wait(1500);
    check(anyActive(), 'blocker active before quitting');
    app.once('will-quit', (e) => {
      e.preventDefault();
      check(!anyActive(), 'blocker released by the time the app quits');
      check(started.every((s) => stopped.includes(s.id)), `every started blocker was stopped (${JSON.stringify({ started: started.map((s) => s.id), stopped })})`);
      finish();
    });
    app.quit();
    setTimeout(() => { check(false, 'app did not reach will-quit within 30s'); finish(1); }, 30000);
  } catch (e) {
    check(false, 'unexpected error: ' + (e && e.stack || e));
    finish();
  }
});
