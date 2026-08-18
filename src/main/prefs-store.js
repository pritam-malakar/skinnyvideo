const fs = require('fs');
const path = require('path');

/* ─── Atomic JSON store write (v2.10.0) ───────────────────────────────────
   Extracted from main's savePrefs so it can be exercised by tests against the
   REAL code path (same pattern as ./reveal and ./queue-runner).

   WHY: the old savePrefs wrote straight over prefs.json with a bare
   fs.writeFileSync. open(2) with 'w' TRUNCATES first, so a crash or power
   loss between truncate and the last byte leaves a half-written prefs.json —
   and loadPrefs' catch turns any parse failure into `prefs = {}` SILENTLY.
   With only lastSrc/outputRoots/pendingDests in the file that window was
   narrow and the loss cheap. `history` (up to 50 entries) makes the payload
   much larger and the loss expensive: a torn write would wipe the run ledger
   with no error and no backup.

   HOW: serialize to a sibling temp in the SAME directory, fsync it so the
   bytes are durable, then renameSync over the target. rename(2) within one
   directory is atomic on APFS/HFS+, so a reader — including the next launch —
   sees EITHER the complete previous file or the complete new one, never the
   middle. A crash before the rename leaves prefs.json untouched and only a
   stray .tmp behind, which the next successful write replaces.

   Deps are injected so a test can model a torn write (a write that lands
   partial bytes and then dies) without actually killing the process:
     write  — defaults to open/writeFileSync/fsync/close on the temp path
     rename — defaults to fs.renameSync
   Returns true when the store was published, false when it was not (the
   caller's previous file is still intact in that case). */
function writeJsonAtomic(target, obj, deps = {}) {
  const write = deps.write || ((p, body) => {
    const fd = fs.openSync(p, 'w');
    try {
      fs.writeFileSync(fd, body);
      fs.fsyncSync(fd);          // durable BEFORE the rename publishes it
    } finally {
      fs.closeSync(fd);
    }
  });
  const rename = deps.rename || fs.renameSync;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    write(tmp, JSON.stringify(obj, null, 2));
    rename(tmp, target);         // atomic swap — old or new, never torn
    return true;
  } catch (e) {
    // Nothing was published. Clear the partial temp so it can't accumulate;
    // a real power loss skips this and the next write overwrites it anyway.
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    return false;
  }
}

module.exports = { writeJsonAtomic };
