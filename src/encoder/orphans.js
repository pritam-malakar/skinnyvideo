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

/* ─── Complete leftovers (3.3.0) ──────────────────────────────────────
   A crash between "encode finished" and "rename to the final name" leaves a
   whole file under its temp name. `info` maps each recorded partial to
   { final, source } (recorded by main before ffmpeg writes it; source is the
   ORIGINAL file, not a staged link). A leftover is complete when its video
   stream is as long as its source's, within the duration guard's tolerance
   (max(1 s, 2%)). Source gone, or either duration unknown → incomplete.
   durationOf(file) → seconds | null (pipeline.videoDuration). */
async function classifyPartials(orphans, info, durationOf) {
  const out = [];
  for (const o of orphans || []) {
    const meta = (info && info[o.path]) || {};
    let complete = false;
    if (typeof meta.source === 'string' && typeof meta.final === 'string') {
      const srcDur = await Promise.resolve(durationOf(meta.source)).catch(() => null);
      const outDur = srcDur ? await Promise.resolve(durationOf(o.path)).catch(() => null) : null;
      complete = !!(srcDur && outDur != null && srcDur - outDur <= Math.max(1.0, srcDur * 0.02));
    }
    out.push({ ...o, complete, final: meta.final || null, source: meta.source || null });
  }
  return out;
}

/* Renames each COMPLETE recorded leftover onto its final name (next free
   _N if taken — never overwrites), copies the source's mtime like a normal
   finish, and appends `RECOVERED <src> -> <final>` to its run folder's
   compress.log. Same safety contract as deletion, and completeness is
   re-checked here — the renderer's word is never trusted. The final name
   must sit in the partial's own folder. Returns the new paths. */
async function recoverPartials(paths, { recorded = [], roots = [], info = {}, durationOf } = {}) {
  const set = new Set(recorded);
  const recovered = [];
  for (const p of (Array.isArray(paths) ? paths : [])) {
    if (!(await isDeletablePartial(p, set, roots))) continue;
    const [c] = await classifyPartials([{ path: p }], info, durationOf);
    if (!c.complete || path.dirname(c.final) !== path.dirname(p)) continue;
    const { dir, name, ext } = path.parse(c.final);
    let dest = c.final;
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${name}_${n}${ext}`);
    try { await fsp.rename(p, dest); } catch { continue; }
    try { const st = await fsp.stat(c.source); await fsp.utimes(dest, st.atime, st.mtime); } catch {}
    const parts = p.split(path.sep);
    const runIdx = parts.findIndex((seg) => seg.startsWith('Compressed_'));
    if (runIdx > 0) {
      const logPath = path.join(parts.slice(0, runIdx + 1).join(path.sep), 'compress.log');
      try { await fsp.appendFile(logPath, `RECOVERED ${c.source} -> ${dest} (finished encode kept after an interrupted run)\n`); } catch {}
    }
    recovered.push(dest);
  }
  return recovered;
}

module.exports = { isUnderRoots, isDeletablePartial, findOrphanPartials, deletePartials, classifyPartials, recoverPartials };
