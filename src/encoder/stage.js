const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

/* ─── File-list staging ──────────────────────────────────────────────
   A file-list batch (file-pick / multi-file-drop, or a folder batch with
   per-file skips) is staged at RUN time: each original source is HARDLINKED
   into a temp dir (or copied across filesystems on EXDEV) so the encoder reads
   a stable temp path. This is what makes a STARTED job robust to the original
   being moved/deleted mid-run — the hardlink (or copy) keeps the data alive.

   Returns { tmpRoot, stageDir, stageMap, missing } on success; stageMap maps
   each temp path back to its ORIGINAL source path (so progress events can be
   translated for the renderer), and `missing` lists the sources that could NOT
   be staged (deleted/moved/unreadable before this batch's turn).

   PER-FILE ISOLATION (v2.1.14): a single unstageable source must fail ONLY that
   file, never the whole batch. So a per-file link/copy error (ENOENT, EACCES,
   …) is recorded in `missing` and staging CONTINUES with the rest — the caller
   encodes what staged and reports the missing ones as per-file source-missing
   failures. (Previously the first ENOENT threw and sank the entire batch,
   including its perfectly-encodable files — the v2.1.14 BUG 2 regression.)
   Only a catastrophic failure to create the temp staging area itself throws
   (nothing could be staged at all); the temp dir is self-cleaned on that throw.
   Pure fs/path (no electron) so it is unit-testable in plain node. */
async function stageFileList(batchId, fileSources) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-fl-'));
  try {
    const stageDir = path.join(tmpRoot, `Selected files (${batchId})`);
    await fsp.mkdir(stageDir, { recursive: true });
    const stageMap = new Map();
    const missing = [];
    const used = new Set();
    for (const fp of fileSources) {
      const base = path.basename(fp);
      let safe = base;
      let n = 1;
      while (used.has(safe)) {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        safe = `${stem} (${n})${ext}`;
        n++;
      }
      const linkPath = path.join(stageDir, safe);
      /* Hardlink so the entry shows up as a regular file to pipeline's
         readdir({withFileTypes:true}) walker. On a different filesystem
         (EXDEV — e.g. an external /Volumes/… source) fall back to a copy
         that uses APFS clonefile when available. ANY per-file failure
         (missing source, permission, failed cross-FS copy) is isolated to
         THIS file: record it and keep staging the rest. */
      let staged = false;
      try {
        await fsp.link(fp, linkPath);
        staged = true;
      } catch (e) {
        if (e && e.code === 'EXDEV') {
          try {
            await fsp.copyFile(fp, linkPath, fs.constants.COPYFILE_FICLONE);
            staged = true;
          } catch { /* falls through to missing */ }
        }
      }
      if (staged) {
        used.add(safe);            // reserve the basename slot only on success
        stageMap.set(linkPath, fp);
      } else {
        missing.push(fp);          // per-file failure — does not sink the batch
      }
    }
    return { tmpRoot, stageDir, stageMap, missing };
  } catch (e) {
    // Could not even create the staging area — nothing staged. Don't leak temp.
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { stageFileList };
