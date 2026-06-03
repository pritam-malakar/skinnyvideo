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

   Returns { tmpRoot, stageDir, stageMap } on success; stageMap maps each temp
   path back to its ORIGINAL source path (so progress events can be translated
   for the renderer). THROWS if any source is missing/unstageable (e.g. it was
   deleted before this batch's turn) — main wraps this so that batch fails
   CLEANLY and the queue continues, instead of the throw escaping uncaught and
   leaving the batch stuck on "Running". Self-cleans its temp dir on failure.
   Pure fs/path (no electron) so it is unit-testable in plain node. */
async function stageFileList(batchId, fileSources) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-fl-'));
  try {
    const stageDir = path.join(tmpRoot, `Selected files (${batchId})`);
    await fsp.mkdir(stageDir, { recursive: true });
    const stageMap = new Map();
    const used = new Set();
    for (const fp of fileSources) {
      let base = path.basename(fp);
      let safe = base;
      let n = 1;
      while (used.has(safe)) {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        safe = `${stem} (${n})${ext}`;
        n++;
      }
      used.add(safe);
      const linkPath = path.join(stageDir, safe);
      stageMap.set(linkPath, fp);
      /* Hardlink so the entry shows up as a regular file to pipeline's
         readdir({withFileTypes:true}) walker. On a different filesystem
         (EXDEV — e.g. an external /Volumes/… source) fall back to a copy
         that uses APFS clonefile when available. A missing source throws
         ENOENT here → propagated so the caller fails the batch cleanly. */
      try {
        await fsp.link(fp, linkPath);
      } catch (e) {
        if (e && e.code === 'EXDEV') {
          await fsp.copyFile(fp, linkPath, fs.constants.COPYFILE_FICLONE);
        } else {
          throw e;
        }
      }
    }
    return { tmpRoot, stageDir, stageMap };
  } catch (e) {
    // Don't leak the temp dir if staging failed partway.
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { stageFileList };
