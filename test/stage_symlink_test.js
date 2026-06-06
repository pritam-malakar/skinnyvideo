// Regression test for the SMB batch-start stall fix (Branch B / option iii).
//
// SYMPTOM: a file-list batch from a source the temp FS can't hardlink (an SMB
// NAS) was COPIED in full into internal temp before the first file encoded —
// stall ∝ total batch bytes. smbfs link() → ENOTSUP, so relocating temp can't
// help; the fix stages such sources as SYMLINKS (instant, zero-copy) instead.
//
// Two halves, both REAL files / REAL staging:
//   • stage.js: hardlink-capable source still HARDLINKS (no internal regression);
//     a source that can't hardlink is SYMLINKED, not copied; a missing source is
//     still recorded in `missing` (never a dangling symlink).
//   • pipeline.js walkAll: a symlinked staged entry is FOLLOWED and seen as a
//     video by scanFolder (old walkAll's isFile() check skipped symlinks → 0).
//
// FAIL-ON-OLD:
//   • walker test: old walkAll skips the symlink → scanFolder finds 0 videos.
//   • NAS test (when the share is mounted): old stage copies → entry is a real
//     file, not a symlink, and a full copy of the bytes lands in temp.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const { stageFileList } = require('../src/encoder/stage');
const { scanFolder, getBinaries } = require('../src/encoder/pipeline');

const NAS = '/Volumes/New Volume';
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const note = (l) => console.log('NOTE: ' + l);

// Make a tiny REAL mp4 with the bundled ffmpeg so scanFolder/ffprobe accept it.
function makeSampleMp4(dest) {
  const { ffmpeg } = getBinaries();
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x128:rate=10',
      '-pix_fmt', 'yuv420p', dest], (err) => err ? reject(err) : resolve());
  });
}

(async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-symlink-'));

  /* ── 1. Same-volume source still HARDLINKS (no internal regression) ───────
     sandbox is under os.tmpdir() — same volume as stageFileList's temp — so
     link() succeeds. Assert: NOT a symlink, shares the original's inode, no
     extra bytes. This guards we did not downgrade the internal path to symlink. */
  const localA = path.join(sandbox, 'localA.mov');
  await fsp.writeFile(localA, Buffer.alloc(4096, 1));
  const srcInoA = (await fsp.stat(localA)).ino;
  const hl = await stageFileList(101, [localA]);
  const hlEntry = path.join(hl.stageDir, 'localA.mov');
  const hlLstat = await fsp.lstat(hlEntry);
  check(!hlLstat.isSymbolicLink(), 'same-volume source is hardlinked, not symlinked');
  check((await fsp.stat(hlEntry)).ino === srcInoA, 'hardlinked entry shares the original inode (zero-copy)');
  check(hl.methods.linked === 1 && hl.methods.symlinked === 0 && hl.methods.copied === 0,
    'methods tally: same-volume = hardlinked=1 symlinked=0 copied=0');
  await fsp.rm(hl.tmpRoot, { recursive: true, force: true });
  check((await fsp.stat(localA)).ino === srcInoA, 'original untouched after hardlink staging cleanup');

  /* ── 2. A missing source never becomes a DANGLING symlink ─────────────────
     link() on a missing source throws ENOENT (not a hardlink-unsupported code),
     so the symlink fallback must NOT fire — it must be recorded in `missing` and
     leave no entry. Guards the new cantHardlink+access guard. */
  const gone = path.join(sandbox, 'gone.mov');
  const mix = await stageFileList(102, [localA, gone]);
  check(mix.missing.length === 1 && mix.missing[0] === gone, 'missing source recorded in `missing`');
  check(fs.readdirSync(mix.stageDir).length === 1, 'missing source left NO entry (no dangling symlink)');
  await fsp.rm(mix.tmpRoot, { recursive: true, force: true });

  /* ── 3. walkAll FOLLOWS a symlinked staged entry (deterministic, fail-on-old)
     Build a stage dir by hand with a SYMLINK to a real mp4, then scanFolder it.
     Old walkAll: symlink dirent isFile()===false → skipped → 0 videos (FAIL).
     New walkAll: stat-follows the link → 1 video (PASS). */
  const realMp4 = path.join(sandbox, 'real.mp4');
  await makeSampleMp4(realMp4);
  const stageDir = path.join(sandbox, 'Selected files (103)');
  await fsp.mkdir(stageDir, { recursive: true });
  await fsp.symlink(realMp4, path.join(stageDir, 'real.mp4'));
  const scan = await scanFolder(stageDir);
  check(scan.videos.length === 1, 'scanFolder follows a symlinked staged entry (old walkAll found 0)');
  check(scan.videos.length === 1 && scan.videos[0].size === (await fsp.stat(realMp4)).size,
    'symlinked entry reports the ORIGINAL real byte size via stat()');

  /* ── 4. REAL SMB: source that can't hardlink is SYMLINKED, not copied ─────
     Only runs when the NAS is mounted (the actual repro environment). We create
     our OWN small temp file on the share and delete it after — no dependence on
     existing NAS content. */
  let nasMounted = false;
  try { nasMounted = (await fsp.stat(NAS)).isDirectory(); } catch {}
  if (nasMounted) {
    const nasDir = path.join(NAS, '.squeeze-symlink-test-' + process.pid);
    let staged;
    try {
      await fsp.mkdir(nasDir, { recursive: true });
      const nasSrc = path.join(nasDir, 'nas.mov');
      await fsp.writeFile(nasSrc, Buffer.alloc(64 * 1024, 9)); // 64 KB real file
      const srcStat0 = await fsp.stat(nasSrc);

      staged = await stageFileList(104, [nasSrc]);
      const entry = path.join(staged.stageDir, 'nas.mov');
      const lst = await fsp.lstat(entry);
      check(lst.isSymbolicLink(), 'SMB source staged as a SYMLINK, not a copy (old code copied)');
      check(lst.isSymbolicLink() && (await fsp.readlink(entry)) === nasSrc,
        'symlink points at the original NAS source');
      // zero-copy: the staged entry carries no file bytes of its own.
      check(lst.size < 1024, 'staged symlink holds no copied bytes (size ≪ source)');
      check(staged.stageMap.get(entry) === nasSrc, 'stageMap maps symlink → original NAS path');
      check(staged.methods.symlinked === 1 && staged.methods.copied === 0 && staged.methods.linked === 0,
        'methods tally: SMB = symlinked=1 copied=0 (no full-file copy)');

      await fsp.rm(staged.tmpRoot, { recursive: true, force: true });
      const srcStat1 = await fsp.stat(nasSrc);
      check(srcStat1.ino === srcStat0.ino && srcStat1.mtimeMs === srcStat0.mtimeMs,
        'NAS original untouched (inode + mtime) after staging + cleanup');
    } finally {
      try { await fsp.rm(nasDir, { recursive: true, force: true }); } catch {}
    }
  } else {
    note('SMB share not mounted (' + NAS + ') — skipped the real cross-FS symlink assertion.');
    note('Run with the NAS mounted to cover the actual repro environment.');
  }

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
