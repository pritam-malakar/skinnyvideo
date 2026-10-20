/* 3.3.1 Item 1 — Keep on a leftover only ever touches its own recorded run folder.
   Plain node, REAL orphans.js + REAL pipeline.videoDuration (bundled ffprobe),
   real files made with the bundled ffmpeg.

   AUDIT     the external audit's layout: a project folder "Compressed_archives/"
             holding notes.txt (plus "Shoot 2025/notes.txt") and Output/Compressed_2026-10-20_0101/<stage>/clip.tmp.mp4
             (recorded, complete). Keep → clip.mp4 directly in Compressed_2026-10-20_0101/,
             and every path outside that run folder is byte-for-byte as before
             (full tree snapshot: path, size, mtime).
   NO-RUNDIR the recorded run folder is not on disk (record/disk mismatch) or the
             record carries no run folder (3.3.0 record) → classify says incomplete
             (Delete only), RECOVER-SKIP <path> (run folder not found) is logged,
             Keep refuses, Delete still works.
   DELETED   the run folder itself deleted before launch → nothing is offered.
   PREDICATE isRunFolderName matches only Compressed_YYYY-MM-DD_HHMM.

   FAIL-ON-OLD (3.3.0 / 399c3d2): recovery flattened the first ancestor named
   "Compressed_…" (Compressed_archives), lifting the run's files into the project.
   Run: node test/recover_run_dir_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const O = require(path.join(ROOT, 'src/encoder/orphans'));
const P = require(path.join(ROOT, 'src/encoder/pipeline'));
const N = require(path.join(ROOT, 'src/encoder/naming'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
if (!P.ffmpegStatus(P.getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); console.log('\nPASS: 0 FAIL: 0'); process.exit(0); }

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-rundir-')));
const ff = (args) => { const r = spawnSync(P.getBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };

function snapshot(dir, skip) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === skip) continue;
      const st = fs.lstatSync(p);
      out[path.relative(dir, p)] = e.isDirectory() ? 'dir' : `${st.size}@${st.mtimeMs}`;
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

(async () => {
  try {
    check(typeof N.isRunFolderName === 'function' && N.isRunFolderName('Compressed_2026-10-20_0101') && !N.isRunFolderName('Compressed_archives')
      && !N.isRunFolderName('Compressed_2026-10-20_0101 old') && !N.isRunFolderName('xCompressed_2026-10-20_0101'),
      'PREDICATE: only Compressed_YYYY-MM-DD_HHMM is a run folder');

    const src = path.join(SB, 'Card', 'clip.mov'); fs.mkdirSync(path.dirname(src));
    ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3', '-c:v', 'libx265', '-x265-params', 'log-level=none', src]);

    // ── AUDIT ──
    const project = path.join(SB, 'Compressed_archives');
    const out = path.join(project, 'Output');
    const runDir = path.join(out, 'Compressed_2026-10-20_0101');
    const stage = path.join(runDir, 'Selected files (1)', 'Card');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(project, 'notes.txt'), 'my notes\n');
    // notes.txt one level down too: old code lifted it out of its project subfolder
    fs.mkdirSync(path.join(project, 'Shoot 2025')); fs.writeFileSync(path.join(project, 'Shoot 2025', 'notes.txt'), 'shoot notes\n');
    fs.writeFileSync(path.join(runDir, 'compress.log'), '# run\n');
    const tmp = path.join(stage, 'clip.tmp.mp4');
    ff(['-i', src, '-c', 'copy', tmp]);
    const info = { [tmp]: { final: path.join(stage, 'clip.mp4'), source: src, runDir } };
    const before = snapshot(SB, runDir);
    const logs = [];
    const rec = await O.recoverPartials([tmp], { recorded: [tmp], roots: [out], info, durationOf: P.videoDuration, log: (m) => logs.push(m) });
    const after = snapshot(SB, runDir);
    check(rec.length === 1 && rec[0] === path.join(runDir, 'clip.mp4') && fs.existsSync(rec[0]),
      `AUDIT: Keep puts clip.mp4 directly in Compressed_2026-10-20_0101/ (${rec.map((r) => path.relative(SB, r))})`);
    check(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8') === 'my notes\n', 'AUDIT: notes.txt untouched in the project folder');
    check(fs.existsSync(path.join(project, 'Shoot 2025', 'notes.txt')) && !fs.existsSync(path.join(project, 'notes_2.txt')) && !fs.existsSync(path.join(project, 'Shoot 2025_notes.txt')),
      `AUDIT: Shoot 2025/notes.txt not moved out of its folder (${fs.readdirSync(project).join(', ')})`);
    const changed = diff(before, after);
    check(changed.length === 0, `AUDIT: nothing outside the run folder changed (${changed.join(', ') || 'none'})`);
    check(fs.existsSync(runDir) && fs.readdirSync(runDir).sort().join(',') === 'clip.mp4,compress.log', `AUDIT: run folder is flat (${fs.existsSync(runDir) ? fs.readdirSync(runDir).join(', ') : 'run folder gone'})`);
    check(fs.existsSync(path.join(runDir, 'compress.log')) && fs.readFileSync(path.join(runDir, 'compress.log'), 'utf8').includes(`RECOVERED ${src} -> ${path.join(runDir, 'clip.mp4')}`), 'AUDIT: RECOVERED line in the run folder\'s own compress.log');

    // ── NO-RUNDIR ──
    const out2 = path.join(SB, 'Out2');
    const run2 = path.join(out2, 'Compressed_2026-10-20_0202'); const sub2 = path.join(run2, 'Card');
    fs.mkdirSync(sub2, { recursive: true });
    const t2 = path.join(sub2, 'clip.tmp.mp4'); ff(['-i', src, '-c', 'copy', t2]);
    const t3 = path.join(sub2, 'clip.tmp_2.mp4'); ff(['-i', src, '-c', 'copy', t3]);
    const goneRun = path.join(out2, 'Compressed_2026-10-20_0203');   // recorded, then deleted
    const info2 = {
      [t2]: { final: path.join(sub2, 'clip.mp4'), source: src, runDir: goneRun },
      [t3]: { final: path.join(sub2, 'clip_2.mp4'), source: src }, // 3.3.0 record: no runDir
    };
    const logs2 = [];
    const found = await O.findOrphanPartials([t2, t3], [out2]);
    const cls = await O.classifyPartials(found, info2, P.videoDuration, { log: (m) => logs2.push(m) });
    check(cls.length === 2 && cls.every((c) => c.complete === false), `NO-RUNDIR: leftover is Delete only (${JSON.stringify(cls.map((c) => [path.basename(c.path), c.complete]))})`);
    check(logs2.includes(`RECOVER-SKIP ${t2} (run folder not found)`) && logs2.includes(`RECOVER-SKIP ${t3} (run folder not found)`), `NO-RUNDIR: RECOVER-SKIP logged (${JSON.stringify(logs2)})`);
    const pre2 = snapshot(SB);
    const rec2 = await O.recoverPartials([t2, t3], { recorded: [t2, t3], roots: [out2], info: info2, durationOf: P.videoDuration, log: () => {} });
    check(rec2.length === 0 && diff(pre2, snapshot(SB)).length === 0, 'NO-RUNDIR: Keep refuses and moves nothing');
    const del = await O.deletePartials([t2, t3], { recorded: [t2, t3], roots: [out2] });
    check(del === 2 && !fs.existsSync(t2) && !fs.existsSync(t3), 'NO-RUNDIR: Delete still works');

    // ── DELETED ──
    fs.mkdirSync(sub2, { recursive: true });
    const t4 = path.join(sub2, 'other.tmp.mp4'); ff(['-i', src, '-c', 'copy', t4]);
    fs.rmSync(run2, { recursive: true, force: true });
    const found4 = await O.findOrphanPartials([t4], [out2]);
    check(found4.length === 0, 'DELETED: run folder gone → leftover no longer offered');
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[recover-run-dir] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
