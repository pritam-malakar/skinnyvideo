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
    /* Per-batch tally of HOW each source was staged, surfaced to the run log so
       the SMB zero-copy fix is observable in the field: a NAS batch should read
       symlinked=N, copied=0 (a non-zero `copied` means a source FS supported
       neither hardlink nor symlink and we fell back to a full copy). */
    const methods = { linked: 0, symlinked: 0, copied: 0 };
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
      /* Stage each source as a stable entry the pipeline walker can read, in
         strict zero-copy-first order:
           1. HARDLINK — shares the original's inode, so deleting/moving the
              original mid-encode stays safe. Works only when the temp dir and
              the source share a hardlink-capable filesystem (internal APFS,
              same-volume HFS+). Strongest guarantee → always tried first.
           2. SYMLINK — when the source FS can't hardlink: a different volume
              (EXDEV) or a filesystem with no hardlink support at all
              (ENOTSUP/EOPNOTSUPP/EPERM — e.g. an SMB/NAS share, exFAT). A COPY
              here would move the WHOLE file to internal temp before encoding —
              that is exactly the size-proportional batch-start stall. A symlink
              is instant and zero-copy; the encoder reads the original through
              it. Trade-off vs a hardlink: deleting the original mid-encode is no
              longer insulated by the staged entry — the pipeline's pre-encode
              isSourceReadable guard + inactivity watchdog cover a vanished
              source. (Branch B / option iii, chosen for SMB sources where
              hardlinks are physically impossible — link() → ENOTSUP.)
           3. COPY — last resort ONLY if symlink ALSO fails (a source FS that
              supports neither): the file still stages, at the cost of the copy.
              Never reached for SMB (symlink succeeds there).
         symlink() would happily create a DANGLING link to a missing target,
         masking a genuinely missing source (which must land in `missing`, not be
         silently "staged"), so the fallback runs only for hardlink-unsupported
         error codes AND only when the source actually exists. Any OTHER per-file
         error (ENOENT/EACCES — missing/unreadable source) leaves staged=false →
         recorded in `missing`, isolated to THIS file (v2.1.14). */
      let staged = false;
      try {
        await fsp.link(fp, linkPath);
        staged = true; methods.linked++;
      } catch (e) {
        const code = e && e.code;
        const cantHardlink = code === 'EXDEV' || code === 'ENOTSUP'
          || code === 'EOPNOTSUPP' || code === 'EPERM';
        let srcExists = false;
        if (cantHardlink) {
          try { await fsp.access(fp); srcExists = true; } catch { /* missing → record */ }
        }
        if (srcExists) {
          try {
            await fsp.symlink(fp, linkPath);
            staged = true; methods.symlinked++;
          } catch {
            try {
              await fsp.copyFile(fp, linkPath, fs.constants.COPYFILE_FICLONE);
              staged = true; methods.copied++;
            } catch { /* falls through to missing */ }
          }
        }
      }
      if (staged) {
        used.add(safe);            // reserve the basename slot only on success
        stageMap.set(linkPath, fp);
      } else {
        missing.push(fp);          // per-file failure — does not sink the batch
      }
    }
    return { tmpRoot, stageDir, stageMap, missing, methods };
  } catch (e) {
    // Could not even create the staging area — nothing staged. Don't leak temp.
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { stageFileList };
