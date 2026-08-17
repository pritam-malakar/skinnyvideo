'use strict';
/* ─── Quit teardown ─────────────────────────────────────────────────────────
   "Stop and quit" (the close-guard's destructive choice) uses the CANCEL path,
   NOT the Stop button's graceful stop-after-current-file. Quitting must not
   wait out a large in-flight encode — a quit that hangs for minutes with no
   feedback is not a quit. Cancel terminates the encoder immediately; the
   pipeline's isCancelled() branch then unlinks the .tmp partial it was
   writing. Files already finished in the run folder are never touched.

   THE TWO PATHS DIFFER ON PURPOSE:
     · Stop BUTTON  → graceful. stopRequested is read at file boundaries
                      (pipeline.js), so the current file finishes and is
                      finalized. Lives in ipcMain 'stop-queue'.
     · Stop and QUIT → immediate. This module. Child dies now, partial is
                      removed, quit completes in seconds.

   Extracted from main so the real teardown is importable by tests — the
   close-guard's live test drives THIS function, not a stand-in. */

const HARD_KILL_MS = 1000;

/* Flag + terminate ONE batch's encoder. Same sequence the cancel-batch IPC
   handler performs, so there is a single kill implementation. */
function beginCancel(state, deps = {}) {
  if (!state) return;
  const { releasePauseGate, hardKillMs = HARD_KILL_MS } = deps;
  state.cancelled = true;
  const child = state.child;
  /* Unpause FIRST: a SIGSTOPped child cannot act on SIGTERM, and a pipeline
     parked on the pause gate never re-checks the cancel flag until woken. */
  if (state.paused) {
    if (child) { try { child.kill('SIGCONT'); } catch {} }
    state.paused = false;
  }
  if (releasePauseGate) releasePauseGate(state);
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    // Bounded escalation for a child that ignores SIGTERM.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, hardKillMs);
  }
}

/* Cancel every live batch, then wait for the run to actually unwind before the
   caller closes. deps:
     runtime          — Map of batchId -> runtime state
     releasePauseGate — queue-runner's gate release
     stopQueue()      — prevent the loop from starting the NEXT batch
     runPromise       — the in-flight runQueue promise (or a getter, or null)
     onSettled()      — invoked once teardown is genuinely complete
   Returns a promise that resolves after onSettled. */
function quitViaCancel(deps) {
  const { runtime, releasePauseGate, stopQueue, runPromise, onSettled } = deps;
  if (stopQueue) stopQueue();
  if (runtime) {
    for (const state of runtime.values()) beginCancel(state, { releasePauseGate });
  }
  const p = (typeof runPromise === 'function' ? runPromise() : runPromise) || Promise.resolve();
  return Promise.resolve(p)
    .catch(() => { /* a failed/aborted run still quits */ })
    .then(() => { if (onSettled) onSettled(); });
}

module.exports = { beginCancel, quitViaCancel, HARD_KILL_MS };
