const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

/* ─── Orphaned-partial detection ─────────────────────────────────────
   An interrupted run (app quit/crash mid-encode) leaves a "<name>.tmp.mp4"
   behind — the pipeline writes to .tmp.mp4 then renames to the final .mp4
   only on success, and the end-of-batch flatten that would have swept it
   never ran.

   A partial is identified by the EXACT path the pipeline recorded before
   writing it (main persists them as prefs.pendingPartials), never by its
   ".tmp.mp4" suffix: a source named "holiday.tmp.mov" produces a finished
   "holiday.tmp.mp4" that a suffix match would delete.

   Safety contract (shared by detection and deletion): a path is a deletable
   partial only when it is in the recorded set, still has a temp name
   ("<stem>.tmp.mp4" or "<stem>.tmp_<n>.mp4", see naming.reserveTempStem), sits
   under a "Compressed_" run folder, is a regular file (not a symlink), and its
   realpath is under the realpath of a known output root. Pure fs/path, no
   electron, so it is unit-testable in plain node. */

/* True when p's realpath is a known root or inside one. Missing paths and
   unresolvable roots never match. Shared with main's open-path/reveal-path. */
async function isUnderRoots(p, roots) {
  if (typeof p !== 'string' || !p) return false;
  let real;
  try { real = await fsp.realpath(p); } catch { return false; }
  for (const root of roots || []) {
    if (typeof root !== 'string' || !root) continue;
    let r;
    try { r = await fsp.realpath(root); } catch { continue; }
    if (real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
  }
  return false;
}

const TEMP_NAME = /\.tmp(_\d+)?\.mp4$/;

async function isDeletablePartial(p, recorded, roots) {
  if (typeof p !== 'string' || !recorded || !recorded.has(p)) return false;
  if (!TEMP_NAME.test(p) || !p.includes(`${path.sep}Compressed_`)) return false;
  try { if (!(await fsp.lstat(p)).isFile()) return false; } catch { return false; }
  return isUnderRoots(p, roots);
}

/* recorded: paths the pipeline recorded. roots: known output roots.
   Returns [{ path, size }] for those still on disk that pass the contract. */
async function findOrphanPartials(recorded, roots) {
  const set = new Set(Array.isArray(recorded) ? recorded : []);
  const out = [];
  for (const p of set) {
    if (!(await isDeletablePartial(p, set, roots))) continue;
    let size = 0;
    try { size = (await fsp.stat(p)).size; } catch {}
    out.push({ path: p, size });
  }
  return out;
}

/* Deletes only paths that pass the contract; anything else handed over (a
   finished output, an original, an unrecorded path) is ignored. */
async function deletePartials(paths, { recorded = [], roots = [] } = {}) {
  const set = new Set(recorded);
  let deleted = 0;
  for (const p of (Array.isArray(paths) ? paths : [])) {
    if (!(await isDeletablePartial(p, set, roots))) continue;
    try { await fsp.unlink(p); deleted++; } catch { /* already gone — fine */ }
  }
  return deleted;
}

module.exports = { isUnderRoots, isDeletablePartial, findOrphanPartials, deletePartials };
