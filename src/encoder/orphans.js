const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

/* ─── Orphaned-partial detection ─────────────────────────────────────
   An interrupted run (app quit/crash mid-encode) leaves a "<name>.tmp.mp4"
   behind — the pipeline writes to .tmp.mp4 then renames to the final .mp4
   only on success, and the end-of-batch flatten that would have swept it
   never ran. Given the destination(s) of an interrupted run, find every
   leftover .tmp.mp4 partial under their "Compressed_" run folders.

   Safety contract (shared by the deletion path): we only ever consider a
   file for deletion when isDeletablePartial() returns true — it must end
   in ".tmp.mp4" AND sit under a path segment beginning "Compressed_".
   Originals and finished .mp4 outputs can never match. Pure fs/path, no
   electron, so it is unit-testable in plain node. */

function isDeletablePartial(p) {
  if (typeof p !== 'string') return false;
  if (!p.endsWith('.tmp.mp4')) return false;
  return p.includes(`${path.sep}Compressed_`);
}

async function collectPartials(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await collectPartials(p, out);
    } else if (e.isFile() && e.name.endsWith('.tmp.mp4')) {
      let size = 0;
      try { size = (await fsp.stat(p)).size; } catch {}
      out.push({ path: p, size });
    }
  }
}

async function findOrphanPartials(dests) {
  const out = [];
  for (const dest of dests || []) {
    if (!dest || typeof dest !== 'string') continue;
    let entries;
    try { entries = await fsp.readdir(dest, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith('Compressed_')) {
        await collectPartials(path.join(dest, e.name), out);
      }
    }
  }
  return out;
}

async function deletePartials(paths) {
  let deleted = 0;
  for (const p of (paths || [])) {
    if (!isDeletablePartial(p)) continue;
    try { await fsp.unlink(p); deleted++; } catch { /* already gone — fine */ }
  }
  return deleted;
}

module.exports = { isDeletablePartial, findOrphanPartials, deletePartials };
