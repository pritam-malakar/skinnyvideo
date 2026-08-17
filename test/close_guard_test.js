/* Soft close-guard regression (v2.2.8).
   Quitting while a file is flushing to disk must be intercepted with a confirm;
   "Quit anyway" must pass through (forceQuit); and when NOT finalizing the close
   must proceed untouched. Pure unit test of the decision module — no Electron
   window/dialog. Also covers the progress→flag mapping main wires into `send`.

   FAIL-ON-OLD: src/main/close-guard.js does not exist before v2.2.8, so this
   file cannot even require() → FAIL. Pass-on-new.
   Run:  node test/close_guard_test.js */
const path = require('path');
const { shouldBlockClose, handleCloseAttempt, applyProgressToQuitState, RUN_DIALOG } =
  require(path.join(__dirname, '..', 'src/main/close-guard'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

function deps(answer) {
  const calls = { preventDefault: 0, confirmQuit: 0, proceed: 0 };
  return {
    calls,
    preventDefault: () => { calls.preventDefault++; },
    confirmQuit: () => { calls.confirmQuit++; return answer; },
    proceed: () => { calls.proceed++; }
  };
}

// ── predicate ──
check(shouldBlockClose({ isFinalizing: true,  forceQuit: false }) === true,  'block when finalizing & not forced');
check(shouldBlockClose({ isFinalizing: false, forceQuit: false }) === false, 'allow when not finalizing');
check(shouldBlockClose({ isFinalizing: true,  forceQuit: true  }) === false, 'allow when forceQuit set (bypass)');

// ── not finalizing → close proceeds, no dialog ──
{
  const st = { isFinalizing: false, forceQuit: false };
  const d = deps(false);
  const out = handleCloseAttempt(st, d);
  check(out === 'allowed' && d.calls.preventDefault === 0 && d.calls.confirmQuit === 0,
    `not finalizing → allowed, untouched (out=${out}, preventDefault=${d.calls.preventDefault})`);
}

// ── finalizing + "Wait" → blocked (close prevented, no proceed, flag intact) ──
{
  const st = { isFinalizing: true, forceQuit: false };
  const d = deps(false);
  const out = handleCloseAttempt(st, d);
  check(out === 'blocked' && d.calls.preventDefault === 1 && d.calls.proceed === 0 && st.forceQuit === false,
    `finalizing + Wait → blocked (out=${out}, prevent=${d.calls.preventDefault}, proceed=${d.calls.proceed}, force=${st.forceQuit})`);
}

/* ── confirm → forced. v2.9.6 CONTRACT CHANGE: forceQuit is NOT set here.
   Teardown is async (await the encoder's real exit), so the module only marks
   state.closing and hands off; the caller sets forceQuit once the encoder has
   actually exited. Setting it synchronously would let a second red-button
   click through MID-TEARDOWN — the exact race this guard exists to prevent. */
{
  const st = { queueRunning: true, isFinalizing: false, forceQuit: false };
  const d = deps(true);
  const out = handleCloseAttempt(st, d);
  check(out === 'forced' && d.calls.preventDefault === 1 && d.calls.proceed === 1
        && st.closing === true && st.forceQuit === false,
    `confirm → forced, teardown owns forceQuit (out=${out}, proceed=${d.calls.proceed}, closing=${st.closing}, force=${st.forceQuit})`);
  // RE-ENTRY: a close arriving while teardown runs is swallowed — no second
  // dialog, no second proceed(), no force-kill.
  const d2 = deps(true);
  const out2 = handleCloseAttempt(st, d2);
  check(out2 === 'suppressed' && d2.calls.preventDefault === 1
        && d2.calls.confirmQuit === 0 && d2.calls.proceed === 0,
    `close during teardown → suppressed, no stacked dialog (out=${out2}, confirm=${d2.calls.confirmQuit}, proceed=${d2.calls.proceed})`);
  // once teardown completes the caller sets forceQuit → the real close passes
  st.forceQuit = true; st.closing = false;
  const d3 = deps(false);
  const out3 = handleCloseAttempt(st, d3);
  check(out3 === 'allowed' && d3.calls.preventDefault === 0,
    `after teardown sets forceQuit, real close allowed (out=${out3})`);
}

/* ── v2.9.6 THE BUG: mid-encode (running, NOT finalizing) must block. ──
   Pre-fix these all FAIL: shouldBlockClose only consulted isFinalizing, so the
   red button sailed through the entire encode, killed ffmpeg, and left a
   partial with no moov atom. */
{
  check(shouldBlockClose({ queueRunning: true, isFinalizing: false, forceQuit: false }) === true,
    'BUG v2.9.6: block mid-encode (queueRunning, not finalizing)');
  check(shouldBlockClose({ queueRunning: false, isFinalizing: false, forceQuit: false }) === false,
    'idle → allow (no run, no finalize)');
  check(shouldBlockClose({ queueRunning: true, isFinalizing: false, forceQuit: true }) === false,
    'queueRunning but forceQuit → allow (teardown done)');

  // A PAUSED run needs no special case: queueRunning stays true across pause,
  // and a paused batch still holds a suspended child + a partial on disk.
  const paused = { queueRunning: true, isFinalizing: false, forceQuit: false };
  const dp = deps(false);
  const outp = handleCloseAttempt(paused, dp);
  check(outp === 'blocked' && dp.calls.preventDefault === 1 && dp.calls.confirmQuit === 1,
    `paused run guarded identically to running (out=${outp})`);

  // mid-encode close is CONFIRMED, not silently allowed
  const st = { queueRunning: true, isFinalizing: false, forceQuit: false };
  const d = deps(false);
  const out = handleCloseAttempt(st, d);
  check(out === 'blocked' && d.calls.preventDefault === 1 && d.calls.proceed === 0,
    `mid-encode + Keep compressing → blocked, run untouched (out=${out}, proceed=${d.calls.proceed})`);
}

/* ── dialog copy is the operator-facing contract ── */
{
  check(RUN_DIALOG.message === 'A compression run is in progress',
    `RUN_DIALOG message (got "${RUN_DIALOG.message}")`);
  check(RUN_DIALOG.buttons[0] === 'Keep compressing' && RUN_DIALOG.buttons[1] === 'Stop and quit'
        && RUN_DIALOG.defaultId === 0 && RUN_DIALOG.cancelId === 0,
    `RUN_DIALOG buttons: Keep compressing (default) / Stop and quit (got ${JSON.stringify(RUN_DIALOG.buttons)}, default=${RUN_DIALOG.defaultId})`);
  /* Copy states the CANCEL contract: the current file stops, finished ones
     survive. The earlier graceful wording ("leaves the file unfinished") is
     wrong now — quit no longer waits out the file. */
  check(RUN_DIALOG.detail === 'Quitting stops the current file — finished videos are kept.',
    `RUN_DIALOG detail matches cancel semantics (got "${RUN_DIALOG.detail}")`);
}

// ── progress stream → isFinalizing flag ──
{
  const st = { isFinalizing: false, forceQuit: false };
  applyProgressToQuitState(st, 'progress', { type: 'finalizing' });
  check(st.isFinalizing === true, 'finalizing payload → isFinalizing true');
  applyProgressToQuitState(st, 'progress', { type: 'file-done' });
  check(st.isFinalizing === false, 'file-done payload → isFinalizing false');
  applyProgressToQuitState(st, 'progress', { type: 'finalizing' });
  applyProgressToQuitState(st, 'progress', { type: 'file-start' });
  check(st.isFinalizing === false, 'file-start payload → isFinalizing false');
  applyProgressToQuitState(st, 'progress', { type: 'finalizing' });
  applyProgressToQuitState(st, 'batch-status', { status: 'Done' });
  check(st.isFinalizing === true, 'non-progress channel ignored (flag unchanged)');
}

console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
process.exit(FAIL.length ? 1 : 0);
