/* Soft close-guard regression (v2.2.8).
   Quitting while a file is flushing to disk must be intercepted with a confirm;
   "Quit anyway" must pass through (forceQuit); and when NOT finalizing the close
   must proceed untouched. Pure unit test of the decision module — no Electron
   window/dialog. Also covers the progress→flag mapping main wires into `send`.

   FAIL-ON-OLD: src/main/close-guard.js does not exist before v2.2.8, so this
   file cannot even require() → FAIL. Pass-on-new.
   Run:  node test/close_guard_test.js */
const path = require('path');
const { shouldBlockClose, handleCloseAttempt, applyProgressToQuitState } =
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

// ── finalizing + "Quit anyway" → forced (prevent + proceed + forceQuit set) ──
{
  const st = { isFinalizing: true, forceQuit: false };
  const d = deps(true);
  const out = handleCloseAttempt(st, d);
  check(out === 'forced' && d.calls.preventDefault === 1 && d.calls.proceed === 1 && st.forceQuit === true,
    `finalizing + Quit anyway → forced (out=${out}, proceed=${d.calls.proceed}, force=${st.forceQuit})`);
  // the re-entrant close it triggers must now pass straight through
  const d2 = deps(false);
  const out2 = handleCloseAttempt(st, d2);
  check(out2 === 'allowed' && d2.calls.preventDefault === 0,
    `after force, re-entrant close allowed (out=${out2})`);
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
