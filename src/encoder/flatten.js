const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { assignStems } = require('./naming');

/* ─── Output flattening ─────────────────────────────────────────────
   Pipeline writes outputs mirroring the source folder structure. After
   each batch we flatten that into a single canonical layout:
     <runDir>/<file>.mp4         (no per-source / per-batch subfolders)
   _FAILED/ is preserved as-is (failure forensics live there). Files
   already at runDir top level (compress.log) stay put.
   Lifted names come from ./naming, seeded with what is already at the top
   level (e.g. an earlier batch in the same run folder), so no output is
   ever overwritten: B/C0001.mp4 lands as B_C0001.mp4, then _2, _3.
   .tmp.mp4 partials — if any escaped pipeline's own cleanup — are
   deleted rather than promoted, so a partial never poses as a final.
   Pure fs/path only (no electron) so it is unit-testable in plain node. */
async function flattenRunDir(runDir) {
  const taken = new Set();
  try {
    for (const e of await fsp.readdir(runDir, { withFileTypes: true })) {
      if (e.isFile()) taken.add(path.basename(e.name, path.extname(e.name)).toLowerCase());
    }
  } catch { return 0; }

  const outputs = [];
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
        outputs.push(p);
      }
    }
  }
  await collect(runDir, 0);

  let lifted = 0;
  const stems = assignStems(outputs, taken);
  for (const p of outputs) {
    try { await fsp.rename(p, path.join(runDir, stems.get(p) + path.extname(p))); lifted++; } catch {}
  }

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
