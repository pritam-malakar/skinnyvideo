// Pilot for the new "file list" staging path. Exercises the same temp-symlink
// wrapping that main.js does, then runs runBatch unchanged.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { runBatch, getBinaries, isVideoFile } = require('../src/encoder/pipeline');

const TEST_ROOT = '/Users/macmini1/Downloads/CompressorTest';
const SOURCE_PROJECT = path.join(TEST_ROOT, 'Source', 'Project A');
const SMALL_CLIP = path.join(SOURCE_PROJECT, 'C0224.mov');
const OUTPUT_BASE = path.join(TEST_ROOT, 'Output');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c?'PASS':'FAIL')+': '+l); };
const header = (t) => console.log('\n==== '+t+' ====');

function snapshotTree(root) {
  const out = [];
  function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        out.push(`${p}\t${st.size}\t${Math.floor(st.mtimeMs)}`);
      }
    }
  }
  walk(root);
  return out.sort();
}

async function stageFilesAsBatch(batchId, fileSources, dest, tier) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-fl-'));
  const niceName = `Selected files (${batchId})`;
  const stageDir = path.join(tmpRoot, niceName);
  await fsp.mkdir(stageDir, { recursive: true });
  const used = new Set();
  for (const fp of fileSources) {
    let base = path.basename(fp);
    let safe = base;
    let n = 1;
    while (used.has(safe)) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      safe = `${stem} (${n})${ext}`; n++;
    }
    used.add(safe);
    const linkPath = path.join(stageDir, safe);
    try {
      await fsp.link(fp, linkPath);
    } catch (e) {
      if (e && e.code === 'EXDEV') await fsp.copyFile(fp, linkPath, fs.constants.COPYFILE_FICLONE);
      else throw e;
    }
  }
  return { stageDir, tmpRoot };
}

(async () => {
  const bins = getBinaries();
  check(fs.existsSync(bins.ffmpeg) && fs.existsSync(bins.ffprobe), 'bundled binaries present');
  check(await isVideoFile(SMALL_CLIP), 'small clip probes as video');

  // Baseline of the real Source — must remain byte-identical.
  const beforeSource = snapshotTree(path.join(TEST_ROOT, 'Source'));

  header('Test A: file-list batch with 1 picked file');
  const destA = path.join(OUTPUT_BASE, 'files_test_a');
  await fsp.rm(destA, { recursive: true, force: true });
  await fsp.mkdir(destA, { recursive: true });
  const { stageDir: sa, tmpRoot: ta } = await stageFilesAsBatch(1, [SMALL_CLIP], destA, 'regular');
  // confirm symlink in stage dir
  const linkStat = await fsp.lstat(path.join(sa, 'C0224.mov'));
  check(linkStat.isFile() && !linkStat.isSymbolicLink(), 'staged entry visible as regular file');
  let r;
  try {
    r = await runBatch({ src: sa, dest: destA, tier: 'regular' }, () => false, () => {});
  } finally {
    await fsp.rm(ta, { recursive: true, force: true });
  }
  check(r.processed === 1 && r.failed === 0, '1 file processed via file-list path');
  // Output should live under <runDir>/Selected files (1)/C0224.mp4
  const expectedNiceDir = path.join(r.runDir, 'Selected files (1)');
  check(fs.existsSync(expectedNiceDir), 'output mirrors into "Selected files (1)" sub-folder');
  check(fs.existsSync(path.join(expectedNiceDir, 'C0224.mp4')), 'C0224.mp4 written there');
  check(!fs.existsSync(ta), 'temp stage dir cleaned up after run');

  header('Test B: file-list batch with 2 picked files (different sources)');
  // Use the small clip + a synthesized portrait clip so we have two distinct files.
  const synthDir = path.join(OUTPUT_BASE, 'files_test_b_src');
  await fsp.rm(synthDir, { recursive: true, force: true });
  await fsp.mkdir(synthDir, { recursive: true });
  const { ffmpeg } = bins;
  const synthA = path.join(synthDir, 'syn_a.mp4');
  const synthRes = spawnSync(ffmpeg, [
    '-y','-hide_banner','-loglevel','error',
    '-f','lavfi','-i', 'testsrc=size=640x480:duration=1:rate=30',
    '-c:v','libx264','-pix_fmt','yuv420p', synthA
  ]);
  check(synthRes.status === 0, 'synthesized second file');

  const destB = path.join(OUTPUT_BASE, 'files_test_b');
  await fsp.rm(destB, { recursive: true, force: true });
  await fsp.mkdir(destB, { recursive: true });
  const { stageDir: sb, tmpRoot: tb } = await stageFilesAsBatch(2, [SMALL_CLIP, synthA], destB, 'regular');
  const linksB = (await fsp.readdir(sb)).sort();
  check(linksB.length === 2 && linksB.includes('C0224.mov') && linksB.includes('syn_a.mp4'),
    '2 symlinks present in stage dir');
  let rb;
  try {
    rb = await runBatch({ src: sb, dest: destB, tier: 'regular' }, () => false, () => {});
  } finally {
    await fsp.rm(tb, { recursive: true, force: true });
  }
  check(rb.processed === 2 && rb.failed === 0, 'both files processed');
  const niceB = path.join(rb.runDir, 'Selected files (2)');
  check(fs.existsSync(path.join(niceB, 'C0224.mp4')), 'C0224.mp4 in nice subfolder');
  check(fs.existsSync(path.join(niceB, 'syn_a.mp4')), 'syn_a.mp4 in nice subfolder');

  header('Test C: source tree untouched');
  const afterSource = snapshotTree(path.join(TEST_ROOT, 'Source'));
  const same = beforeSource.length === afterSource.length && beforeSource.every((l, i) => l === afterSource[i]);
  check(same, 'Source/ tree byte-identical (size + mtime) after file-list runs');

  console.log('\n==== SUMMARY ====');
  console.log('PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log('FAILED:', l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
