'use strict';
/* ─── Keep the Mac awake during a run ───────────────────────────────────────
   A long encode must not be suspended by idle sleep. One blocker for the whole
   run: start() when the queue starts, stop() when it ends for any reason
   (finished, stopped, cancelled, quit). Both are idempotent, so a second
   start never leaks a blocker id and a stop with nothing running is a no-op.
   The blocker is injected so the lifecycle is testable without a real one. */
function createKeepAwake(blocker) {
  let id = null;
  return {
    start() {
      if (id !== null && blocker.isStarted(id)) return;
      id = blocker.start('prevent-app-suspension');
    },
    stop() {
      if (id === null) return;
      try { if (blocker.isStarted(id)) blocker.stop(id); } finally { id = null; }
    },
    isActive: () => id !== null && blocker.isStarted(id),
  };
}

module.exports = { createKeepAwake };
