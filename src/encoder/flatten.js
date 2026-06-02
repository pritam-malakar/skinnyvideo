const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

/* ─── Output flattening ─────────────────────────────────────────────
   Pipeline writes outputs mirroring the source folder structure. After
   each batch we flatten that into a single canonical layout:
     <runDir>/<file>.mp4         (no per-source / per-batch subfolders)
   _FAILED/ is preserved as-is (failure forensics live there). Files
   already at runDir top level (compress.log) stay put.
   On name collision (same basename across multiple sources/batches in
   the same run folder), append "_2"/"_3"/… so no output is lost.
   .tmp.mp4 partials — if any escaped pipeline's own cleanup — are
   deleted rather than promoted, so a partial never poses as a final.
   Pure fs/path only (no electron) so it is unit-testable in plain node. */
async function flattenRunDir(runDir) {
  const taken = new Set();
  try {
    for (const e of await fsp.readdir(runDir, { withFileTypes: true })) {
      if (e.isFile()) taken.add(e.name);
    }
  } catch { return 0; }

  let lifted = 0;

  async function collect(dir, depth) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && e.name === '_FAILED') continue;   // keep nested
        await collect(p, depth + 1);
      } else if (e.isFile() && depth > 0) {
        if (e.name.endsWith('.tmp.mp4')) {
          try { await fsp.unlink(p); } catch {}
          continue;
        }
        let name = e.name;
        let safe = name;
        let n = 2;
        while (taken.has(safe)) {
          const ext = path.extname(name);
          const stem = name.slice(0, name.length - ext.length);
          safe = `${stem}_${n}${ext}`;
          n++;
        }
        taken.add(safe);
        try { await fsp.rename(p, path.join(runDir, safe)); lifted++; } catch {}
      }
    }
  }
  await collect(runDir, 0);

  async function pruneEmpty(dir, depth) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (depth === 0 && e.name === '_FAILED') continue;
      await pruneEmpty(path.join(dir, e.name), depth + 1);
    }
    if (depth > 0) { try { await fsp.rmdir(dir); } catch {} }
  }
  await pruneEmpty(runDir, 0);

  return lifted;
}

module.exports = { flattenRunDir };
