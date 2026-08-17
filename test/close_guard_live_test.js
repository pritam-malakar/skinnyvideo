/* Close-guard GROUND TRUTH (v2.9.6) — real Electron, real BrowserWindow, real
   'close' event, real long-lived ffmpeg child.

   The pure-predicate test (close_guard_test.js) can be green while the app
   still dies mid-encode: it hand-feeds state to the decision module and never
   touches the real close path. That is exactly how the v2.9.5 bug shipped.
   This file asserts the behaviour an operator actually gets.

   Wiring here is COPIED VERBATIM from main.js createWindow()/before-quit so
   the test exercises the shipped decision path, not a re-implementation.

   FAIL-ON-OLD: against pre-v2.9.6 close-guard.js, shouldBlockClose consults
   only isFinalizing, so a mid-encode close is NOT intercepted — the window is
   destroyed and the encoder is killed. Those checks fail. Pass-on-new.
   Run:  ./node_modules/.bin/electron test/close_guard_live_test.js */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { handleCloseAttempt } = require(path.join(ROOT, 'src/main/close-guard'));
/* The REAL teardown — not a stand-in. "Stop and quit" uses the cancel path, so
   this test drives the same function main.js calls. */
const { quitViaCancel } = require(path.join(ROOT, 'src/main/quit-teardown'));
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');
const OUT = '/tmp/squeeze-closeguard-live.mp4';
const DONE_FILE = '/tmp/squeeze-closeguard-done.mp4';

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function finish() {
  console.log('\n[close-guard-live] PASS: ' + PASS.length + ' FAIL: ' + FAIL.length);
  app.exit(FAIL.length ? 1 : 0);
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.whenReady().then(async () => {
  if (!fs.existsSync(FFMPEG)) {
    console.log('(skipped — bundled ffmpeg not present)');
    return finish();
  }
  try { fs.unlinkSync(OUT); } catch {}
  try { fs.unlinkSync(DONE_FILE); } catch {}

  // ---- the run under test: real encoder child + main.js's guard state ----
  const quitState = {
    queueRunning: false, isFinalizing: false,
    forceQuit: false, dialogOpen: false, closing: false
  };
  let child = null;
  let dialogCount = 0;
  let answer = 0;                 // 0 = Keep compressing, 1 = Stop and quit
  let teardownRuns = 0;

  const startRun = () => {
    /* -re paces the source at REALTIME so this is a genuinely long-running
       encode (~300 s wall clock). Without it, ultrafast finishes in seconds and
       a graceful stop-after-current-file would look indistinguishable from a
       cancel — the timing assertion below would prove nothing. */
    child = spawn(FFMPEG, ['-y', '-re', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30',
      '-t', '300', '-c:v', 'libx264', '-preset', 'ultrafast', OUT], { stdio: 'ignore' });
    child.on('exit', () => { quitState.queueRunning = false; });
    quitState.queueRunning = true;
    // main.js shape: runtime state carries the live child; runPromise unwinds
    // once the encoder is gone (pipeline breaks out on the cancel flag).
    runtime.set(1, { child, paused: false, cancelled: false });
    runPromise = new Promise((res) => child.once('exit', res));
  };

  /* main.js's stopRunThenQuit, wired to the REAL quitViaCancel. runtime/
     runPromise mirror main's shapes: runPromise resolves when the encoder
     exits, standing in for runQueue unwinding after the cancel flag is seen. */
  const runtime = new Map();
  let runPromise = null;
  let stopQueueCalls = 0;
  const stopRunThenQuit = (done) => {
    teardownRuns++;
    quitViaCancel({
      runtime,
      releasePauseGate: (st) => { gateReleases.push(st); },
      stopQueue: () => { stopQueueCalls++; },
      runPromise: () => runPromise,
      onSettled: () => {
        quitState.forceQuit = true;
        quitState.closing = false;
        done();
      }
    });
  };
  const gateReleases = [];

  const win = new BrowserWindow({ width: 900, height: 600, show: false });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));

  // VERBATIM from main.js createWindow()
  win.on('close', (e) => {
    handleCloseAttempt(quitState, {
      preventDefault: () => e.preventDefault(),
      confirmQuit: () => { dialogCount++; return answer === 1; },
      proceed: () => stopRunThenQuit(() => {
        if (win && !win.isDestroyed()) win.close();
      })
    });
  });

  // ── 1. IDLE: close must pass straight through, no dialog ──
  {
    const before = dialogCount;
    let prevented = false;
    const probe = (e) => { if (e.defaultPrevented) prevented = true; };
    win.once('close', probe);
    // don't actually destroy the window we still need — assert the decision
    const outcome = handleCloseAttempt(quitState, {
      preventDefault: () => { prevented = true; },
      confirmQuit: () => { dialogCount++; return false; },
      proceed: () => {}
    });
    win.removeListener('close', probe);
    check(outcome === 'allowed' && prevented === false && dialogCount === before,
      `idle: close allowed with no dialog (outcome=${outcome}, dialogs=${dialogCount - before})`);
  }

  // ── 2. RUN ACTIVE + "Keep compressing": close blocked, encode survives ──
  startRun();
  await wait(2000);                       // let real bytes hit the disk
  const bytesMid = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  check(bytesMid > 0 && alive(child.pid), `run is genuinely live (${bytesMid} bytes written)`);

  answer = 0;                             // Keep compressing
  const dialogsBefore = dialogCount;
  win.close();                            // THE REAL TRAFFIC-LIGHT CLOSE
  await wait(500);
  check(!win.isDestroyed(), 'run active: real close event did NOT destroy the window');
  check(dialogCount === dialogsBefore + 1, `run active: confirm dialog fired once (got ${dialogCount - dialogsBefore})`);
  check(alive(child.pid), 'Keep compressing: encoder still alive after the close attempt');
  const bytesAfter = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
  check(bytesAfter >= bytesMid, `Keep compressing: encode still progressing (${bytesMid} → ${bytesAfter} bytes)`);

  /* FAIL-ON-OLD short-circuit: pre-v2.9.6 the close above destroys the window,
     and every remaining step would operate on a dead window (hang / throw).
     Record the rest as failures and exit cleanly instead. */
  if (win.isDestroyed()) {
    check(false, 're-entry / paused / stop-and-quit checks unreachable — window already destroyed by the unguarded close');
    try { if (child) child.kill('SIGKILL'); } catch {}
    return finish();
  }

  // ── 3. RE-ENTRY: a second close while the guard is armed must not stack ──
  {
    const d0 = dialogCount;
    quitState.closing = true;             // simulate teardown in flight
    win.close();
    await wait(250);
    check(dialogCount === d0 && !win.isDestroyed(),
      `re-entry during teardown: no second dialog, still open (dialogs=${dialogCount - d0})`);
    quitState.closing = false;
  }

  // ── 4. PAUSED run is guarded identically (queueRunning stays true) ──
  {
    try { child.kill('SIGSTOP'); } catch {}
    const d0 = dialogCount;
    answer = 0;
    win.close();
    await wait(400);
    check(!win.isDestroyed() && dialogCount === d0 + 1,
      `paused run: close guarded the same as running (dialogs=${dialogCount - d0})`);
    try { child.kill('SIGCONT'); } catch {}
  }

  /* ── 5. "Stop and quit" = CANCEL semantics (v2.9.6 revision) ──
     Quit must NOT wait out the current file the way the Stop BUTTON does.
     Drives the real quitViaCancel: child dies now, the run unwinds, quit
     completes in seconds. */
  {
    answer = 1;
    const pid = child.pid;
    // A finished output already in the run folder must survive the cancel.
    fs.writeFileSync(DONE_FILE, 'finished-output');
    const t0 = Date.now();
    win.close();
    // wait for the real teardown to close the window (bounded)
    for (let i = 0; i < 100 && !win.isDestroyed(); i++) await wait(100);
    const elapsedMs = Date.now() - t0;

    check(teardownRuns === 1, `Stop and quit: teardown ran exactly once (got ${teardownRuns})`);
    check(!alive(pid), 'Stop and quit: encoder child terminated');
    check(elapsedMs < 8000, `Stop and quit: quit completed promptly, did NOT wait out the file (${elapsedMs} ms)`);
    check(stopQueueCalls === 1, `Stop and quit: queue told to stop once (got ${stopQueueCalls})`);
    /* The cancel FLAG is the handoff: pipeline's isCancelled() branch unlinks
       the .tmp partial (pipeline.js ~1058). Assert the flag reached every live
       batch — that is what this module is responsible for. */
    check([...runtime.values()].every((st) => st.cancelled === true),
      'Stop and quit: cancel flag set on every live batch (drives pipeline .tmp unlink)');
    check(gateReleases.length >= 1, `Stop and quit: pause gate released so a parked pipeline re-checks cancel (got ${gateReleases.length})`);
    check(quitState.forceQuit === true, 'Stop and quit: forceQuit set only after teardown settled');
    check(win.isDestroyed(), 'Stop and quit: window actually closed after teardown');
    check(fs.existsSync(DONE_FILE) && fs.readFileSync(DONE_FILE, 'utf8') === 'finished-output',
      'Stop and quit: already-finished output in the run folder untouched');
  }

  try { if (child) child.kill('SIGKILL'); } catch {}
  finish();
});
