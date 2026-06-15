'use strict';
/* ─── Soft close-guard ──────────────────────────────────────────────────────
   While a file is being WRITTEN to disk (the finalizing window — ffmpeg done
   encoding, flushing the container, often a slow SMB moov write), quitting the
   app terminates the process and kills the encoder mid-write, corrupting the
   output. This guard turns a quit attempt during that window into a single
   plain-language confirmation. It is NEVER a hard block (no closable:false) —
   the operator can always proceed.

   The decision is split from Electron so it's unit-testable with no real
   window/dialog:
     · shouldBlockClose(state)        — pure predicate
     · handleCloseAttempt(state, deps) — runs the guard via injected deps
     · applyProgressToQuitState(...)   — flips state.isFinalizing from the
                                         progress stream main already forwards

   state = { isFinalizing: boolean, forceQuit: boolean }
     isFinalizing — true only while the running file is flushing to disk.
     forceQuit    — set once the operator confirms "Quit anyway", so the
                    re-entrant close/quit it triggers isn't intercepted again. */

const QUIT_DIALOG = {
  type: 'warning',
  buttons: ['Wait', 'Quit anyway'],
  defaultId: 0,          // Enter → Wait (the safe choice)
  cancelId: 0,           // Esc → Wait
  title: 'Squeeze',
  message: 'Squeeze is still writing your file to disk.',
  detail: 'Quitting now will corrupt it. Quit anyway?'
};

/* Intercept this close/quit? Only while finalizing and not already forced. */
function shouldBlockClose(state) {
  return !!(state && state.isFinalizing && !state.forceQuit);
}

/* Run the guard for one close/quit attempt.
   deps.preventDefault() — stop the pending close/quit.
   deps.confirmQuit()    — show the modal; return true iff "Quit anyway".
   deps.proceed()        — perform the real close/quit (after forceQuit is set).
   Returns 'allowed' (no interception), 'blocked' (operator chose Wait), or
   'forced' (operator chose Quit anyway). */
function handleCloseAttempt(state, deps) {
  if (!shouldBlockClose(state)) return 'allowed';
  deps.preventDefault();
  if (deps.confirmQuit()) {
    state.forceQuit = true;
    deps.proceed();
    return 'forced';
  }
  return 'blocked';
}

/* Fold a forwarded progress message into the quit state. The finalizing signal
   raises the flag; the next file-start or any file-done (done/fail/cancel/skip
   all emit file-done) lowers it. Ignores non-progress channels. */
function applyProgressToQuitState(state, channel, payload) {
  if (!state || channel !== 'progress' || !payload) return;
  if (payload.type === 'finalizing') state.isFinalizing = true;
  else if (payload.type === 'file-done' || payload.type === 'file-start') state.isFinalizing = false;
}

module.exports = { QUIT_DIALOG, shouldBlockClose, handleCloseAttempt, applyProgressToQuitState };
