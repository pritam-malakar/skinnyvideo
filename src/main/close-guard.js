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

   state = { queueRunning, isFinalizing, forceQuit, dialogOpen, closing }
     queueRunning — v2.9.6: true for the WHOLE run. This is the real guard.
                    Pause needs no special case: a paused batch never leaves
                    the run, so queueRunning stays true (suspended child +
                    partial .tmp on disk — exactly what must be protected).
     isFinalizing — the container-flush sub-window. Kept because main still
                    tracks it off the progress stream, but it is now a SUBSET
                    of queueRunning, not the guard itself. Guarding on it
                    alone was the v2.9.5 bug: false for the entire encode, so
                    the red button sailed through and killed the encoder,
                    leaving a partial with no moov atom.
     forceQuit    — set once teardown has finished, so the re-entrant
                    close/quit it triggers isn't intercepted again.
     dialogOpen   — a confirm is already on screen; further close attempts are
                    swallowed rather than stacking a second dialog.
     closing      — teardown is running; same, and never re-kills. */

/* Legacy export — the flush-window wording, kept for callers/tests that still
   reference it. The live guard uses RUN_DIALOG. */
const QUIT_DIALOG = {
  type: 'warning',
  buttons: ['Wait', 'Quit anyway'],
  defaultId: 0,          // Enter → Wait (the safe choice)
  cancelId: 0,           // Esc → Wait
  title: 'Squeeze',
  message: 'Squeeze is still writing your file to disk.',
  detail: 'Quitting now will corrupt it. Quit anyway?'
};

const RUN_DIALOG = {
  type: 'warning',
  buttons: ['Keep compressing', 'Stop and quit'],
  defaultId: 0,          // Enter → Keep compressing (the safe choice)
  cancelId: 0,           // Esc → Keep compressing
  noLink: true,          // render as plain buttons, not a "Stop and quit" link
  title: 'Squeeze',
  message: 'A compression run is in progress',
  detail: 'Quitting stops the current file — finished videos are kept.'
};

/* Intercept this close/quit? Any live run (or the flush window) blocks, unless
   teardown has already finished and set forceQuit. */
function shouldBlockClose(state) {
  if (!state || state.forceQuit) return false;
  return !!(state.queueRunning || state.isFinalizing);
}

/* What should this close attempt do?
     'allow'    — nothing running (or already forced): let it close.
     'suppress' — blocked, but a dialog is already up or teardown is running:
                  swallow it. This is the re-entry guard — a second red-button
                  click must never stack a dialog or re-enter teardown.
     'confirm'  — blocked: show the confirm. */
function closeDecision(state) {
  if (!shouldBlockClose(state)) return 'allow';
  if (state.dialogOpen || state.closing) return 'suppress';
  return 'confirm';
}

/* Run the guard for one close/quit attempt.
   deps.preventDefault() — stop the pending close/quit.
   deps.confirmQuit()    — show the modal; return true iff "Quit anyway".
   deps.proceed()        — perform the real close/quit (after forceQuit is set).
   Returns 'allowed' (no interception), 'blocked' (operator chose Wait), or
   'forced' (operator chose Quit anyway). */
function handleCloseAttempt(state, deps) {
  const decision = closeDecision(state);
  if (decision === 'allow') return 'allowed';
  deps.preventDefault();
  if (decision === 'suppress') return 'suppressed';

  /* Dialog is modal-sync, but flag it anyway: on the app-quit path a second
     event can arrive around it, and the flag is what makes that a no-op. */
  state.dialogOpen = true;
  let confirmed;
  try { confirmed = deps.confirmQuit(); } finally { state.dialogOpen = false; }
  if (!confirmed) return 'blocked';

  /* Teardown owns the close from here. forceQuit is NOT set yet — it is set by
     the caller once the encoder has actually exited, so a close attempt during
     teardown still gets suppressed rather than racing the real quit. */
  state.closing = true;
  deps.proceed();
  return 'forced';
}

/* Fold a forwarded progress message into the quit state. The finalizing signal
   raises the flag; the next file-start or any file-done (done/fail/cancel/skip
   all emit file-done) lowers it. Ignores non-progress channels. */
function applyProgressToQuitState(state, channel, payload) {
  if (!state || channel !== 'progress' || !payload) return;
  if (payload.type === 'finalizing') state.isFinalizing = true;
  else if (payload.type === 'file-done' || payload.type === 'file-start') state.isFinalizing = false;
}

module.exports = {
  QUIT_DIALOG, RUN_DIALOG,
  shouldBlockClose, closeDecision, handleCloseAttempt, applyProgressToQuitState
};
