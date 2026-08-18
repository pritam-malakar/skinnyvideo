const { shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;

/* ─── Reveal an ORIGINAL source file in Finder (stat-gated) ───────────────
   Extracted from main's IPC wrapper so it can be exercised by tests against
   the REAL code path (same pattern as queue-runner.js). main.js owns the
   `reveal-in-finder` IPC registration; this owns the ground-truth gate.

   GROUND TRUTH FIRST: fsp.stat(p) before any reveal. A missing/unreadable
   original must NEVER reach shell.showItemInFolder — on a nonexistent path
   showItemInFolder silently no-ops or opens the wrong parent, so the operator
   gets no signal or the WRONG window. Instead we return a failure the renderer
   turns into a plain-language non-blocking notice.

   For a STARTED file-list batch the original can be legitimately gone (the
   run hardlinks each source into a temp dir, so the encode completes even if
   the original was moved/deleted mid-run). The failure path is CORRECT there,
   not a logic error.

   Returns { ok:true } only when the file really exists AND reveal was invoked;
   { ok:false, reason } otherwise. Deps are injected so Finder is never touched
   in tests while the stat gate runs against REAL files on disk:
     stat   — defaults to fsp.stat (real disk check)
     reveal — defaults to shell.showItemInFolder (real Finder reveal) */
async function revealInFinder(p, deps = {}, opts = {}) {
  const stat = deps.stat || fsp.stat;
  const reveal = deps.reveal || ((x) => shell.showItemInFolder(x));
  if (!p || typeof p !== 'string') return { ok: false, reason: 'invalid-path' };
  let st;
  try {
    st = await stat(p);         // throws ENOENT/EACCES if the target is gone
  } catch {
    return { ok: false, reason: 'missing' };
  }
  /* Directory targets (v2.10.0 History) additionally assert it IS a
     directory: a run folder whose name was later taken by a plain file must
     not be revealed as though the run folder were still there. */
  if (opts.expectDir && st && typeof st.isDirectory === 'function' && !st.isDirectory()) {
    return { ok: false, reason: 'not-a-directory' };
  }
  reveal(p);                    // reached ONLY when the target really exists
  return { ok: true };
}

/* ─── Reveal a run FOLDER in Finder (History rows) ────────────────────────
   Same async, stat-gated path as above — deliberately NOT main's legacy
   'reveal-path' handler, which guards with a SYNCHRONOUS fs.existsSync on
   the main thread (an unresponsive NAS mount freezes the whole UI) and
   returns nothing, so the renderer cannot tell success from silence. A
   History row's runDir can easily point at an unmounted volume, so it gets
   the non-blocking check and an {ok:false} the renderer can surface. */
function revealFolder(p, deps = {}) {
  return revealInFinder(p, deps, { expectDir: true });
}

module.exports = { revealInFinder, revealFolder };
