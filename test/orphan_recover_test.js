/* 3.3.0 Item 4 — launch cleanup keeps complete leftovers.
   Plain node, REAL orphans.js + REAL pipeline.videoDuration (bundled ffprobe),
   real files made with the bundled ffmpeg.

   Fixture: one run folder with two RECORDED leftovers of 4 s sources:
     whole.tmp.mp4  — a full 4 s encode (crash between finish and rename)
     cut.tmp.mp4    — a truncated 1 s encode (crash mid-encode)
     gone.tmp.mp4   — a full encode whose source no longer exists
   CLASSIFY  whole → complete; cut → incomplete; gone → incomplete (source missing);
             an unrecorded leftover is never offered.
   RECOVER   recover(all three) renames ONLY whole → whole.mp4 (mtime from the
             source), logs `RECOVERED <src> -> <final>` in compress.log, leaves
             cut/gone untouched; a taken final name gets _2, never overwritten.
   DELETE    delete(cut) still works as in 3.2.2.
   RECORD    the real queue-runner hands main { final, source, runDir } for each partial,
             with the ORIGINAL source path even for a staged file-list batch.

   FAIL-ON-OLD (3.2.2): orphans.js had no completeness check and no recovery —
   every leftover was offered for deletion only.
   Run: node test/orphan_recover_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const O = require(path.join(ROOT, 'src/encoder/orphans'));
const P = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
if (!P.ffmpegStatus(P.getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); console.log('\nPASS: 0 FAIL: 0'); process.exit(0); }

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-orphanrec-')));
const ff = (args) => { const r = spawnSync(P.getBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
const V = (d) => ['-f', 'lavfi', '-i', `testsrc2=s=320x240:r=25:d=${d}`];

(async () => {
  try {
    const srcDir = path.join(SB, 'Card'); fs.mkdirSync(srcDir);
    const out = path.join(SB, 'Out'); const run = path.join(out, 'Compressed_2026-10-20_0500', 'Card');
    fs.mkdirSync(run, { recursive: true });
    const logPath = path.join(out, 'Compressed_2026-10-20_0500', 'compress.log');
    fs.writeFileSync(logPath, '# SkinnyVideo run started\n');
    const src = { whole: path.join(srcDir, 'whole.mov'), cut: path.join(srcDir, 'cut.mov'), gone: path.join(srcDir, 'gone.mov') };
    for (const s of Object.values(src)) ff([...V(4), '-c:v', 'libx265', '-x265-params', 'log-level=none', s]);
    const old = new Date('2024-01-02T03:04:05Z'); fs.utimesSync(src.whole, old, old);
    const tmp = { whole: path.join(run, 'whole.tmp.mp4'), cut: path.join(run, 'cut.tmp.mp4'), gone: path.join(run, 'gone.tmp.mp4'), stray: path.join(run, 'stray.tmp.mp4') };
    ff(['-i', src.whole, '-c', 'copy', tmp.whole]);
    ff(['-i', src.cut, '-t', '1', '-c', 'copy', tmp.cut]);
    ff(['-i', src.gone, '-c', 'copy', tmp.gone]);
    ff(['-i', src.whole, '-c', 'copy', tmp.stray]);
    fs.unlinkSync(src.gone);
    const recorded = [tmp.whole, tmp.cut, tmp.gone];
    const runTop0 = path.dirname(run);
    // 3.3.1 Item 1: records carry the run folder too (a record without one is Delete only)
    const info = Object.fromEntries(['whole', 'cut', 'gone'].map((k) => [tmp[k], { final: path.join(run, k + '.mp4'), source: src[k], runDir: runTop0 }]));
    const roots = [out];

    const found = await O.findOrphanPartials(recorded, roots);
    const cls = await O.classifyPartials(found, info, P.videoDuration);
    const by = Object.fromEntries(cls.map((c) => [path.basename(c.path), c]));
    check(by['whole.tmp.mp4'] && by['whole.tmp.mp4'].complete === true, 'CLASSIFY: full-length leftover is complete');
    check(by['cut.tmp.mp4'] && by['cut.tmp.mp4'].complete === false, 'CLASSIFY: truncated leftover is incomplete');
    check(by['gone.tmp.mp4'] && by['gone.tmp.mp4'].complete === false, 'CLASSIFY: leftover whose source is missing is incomplete');
    check(!by['stray.tmp.mp4'], 'CLASSIFY: an unrecorded .tmp.mp4 is never offered');

    // a finished file already holds "whole.mp4" in this folder? → _2. First: free name.
    const runTop = path.dirname(run);   // F2: kept files are lifted to the run folder, as flattenRunDir does
    const rec = await O.recoverPartials([tmp.whole, tmp.cut, tmp.gone, tmp.stray], { recorded, roots, info, durationOf: P.videoDuration });
    check(rec.length === 1 && rec[0] === path.join(runTop, 'whole.mp4'), `RECOVER: only the complete leftover is kept, as <run>/whole.mp4 (${rec.map((r) => path.relative(out, r))})`);
    check(!fs.existsSync(tmp.whole) && fs.existsSync(path.join(runTop, 'whole.mp4')) && !fs.existsSync(path.join(run, 'whole.mp4')), 'RECOVER: temp name gone, final name at the top of the run folder');
    check(fs.existsSync(tmp.cut) && fs.existsSync(tmp.gone) && fs.existsSync(tmp.stray), 'RECOVER: incomplete and unrecorded leftovers untouched, still in their subfolder');
    check(Math.abs(fs.statSync(path.join(runTop, 'whole.mp4')).mtimeMs - old.getTime()) < 2000, 'RECOVER: output takes the source\'s mtime');
    const log = fs.readFileSync(logPath, 'utf8');
    check(log.includes(`RECOVERED ${src.whole} -> ${path.join(runTop, 'whole.mp4')}`), 'RECOVER: `RECOVERED <src> -> <final>` in the run folder\'s compress.log');

    // name already taken → _2, never overwrite
    const tmp2 = path.join(run, 'whole.tmp_2.mp4');
    ff(['-i', src.whole, '-c', 'copy', tmp2]);
    const info2 = { [tmp2]: { final: path.join(run, 'whole.mp4'), source: src.whole, runDir: runTop0 } };
    const before = fs.statSync(path.join(runTop, 'whole.mp4')).size;
    const rec2 = await O.recoverPartials([tmp2], { recorded: [tmp2], roots, info: info2, durationOf: P.videoDuration });
    check(rec2.length === 1 && path.dirname(rec2[0]) === runTop && path.basename(rec2[0]) !== 'whole.mp4' && fs.statSync(path.join(runTop, 'whole.mp4')).size === before,
      `RECOVER: taken names get flattenRunDir's clash name and nothing is overwritten (${rec2.map((r) => path.relative(out, r))})`);

    // F2 fixture: a run whose only leftover is complete, inside a stage subfolder.
    {
      const run2 = path.join(out, 'Compressed_2026-10-20_0600'); const sub = path.join(run2, 'Selected files (1)', 'Card');
      fs.mkdirSync(sub, { recursive: true }); fs.writeFileSync(path.join(run2, 'compress.log'), '# run\n');
      const t = path.join(sub, 'whole.tmp.mp4'); ff(['-i', src.whole, '-c', 'copy', t]);
      const r = await O.recoverPartials([t], { recorded: [t], roots, info: { [t]: { final: path.join(sub, 'whole.mp4'), source: src.whole, runDir: run2 } }, durationOf: P.videoDuration });
      check(r[0] === path.join(run2, 'whole.mp4') && fs.existsSync(r[0]), `FLAT: kept file sits directly in the run folder under its final name (${r.map((x) => path.relative(out, x))})`);
      check(fs.readdirSync(run2).sort().join(',') === 'compress.log,whole.mp4', `FLAT: stage subfolders are gone (${fs.readdirSync(run2).join(', ')})`);
    }

    const del = await O.deletePartials([tmp.cut], { recorded, roots });
    check(del === 1 && !fs.existsSync(tmp.cut), 'DELETE: an incomplete leftover can still be deleted');

    // RECORD: the real queue-runner reports { final, source } with the ORIGINAL
    // source path for a staged file-list batch (the staged link is temporary).
    const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));
    const out3 = path.join(SB, 'Out3'); fs.mkdirSync(out3);
    const seen = [];
    const rtm = new Map(); const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
    await runQueue([{ id: 7, kind: 'files', fileSources: [src.whole], dest: out3, tier: 'regular' }],
      { send: () => {}, isStopRequested: () => false, rt, onPartial: (p, i) => seen.push([p, i]) });
    const [rp, ri] = seen[0] || [];
    check(seen.length === 1 && ri && ri.source === src.whole, `RECORD: onPartial gets the ORIGINAL source, not the staged link (${JSON.stringify(ri)})`);
    check(ri && path.dirname(ri.final) === path.dirname(rp) && /\.tmp(_\d+)?\.mp4$/.test(rp) && ri.final === rp.replace(/\.tmp(_\d+)?\.mp4$/, '.mp4'),
      `RECORD: final is the partial's own name without .tmp (${rp} → ${ri && ri.final})`);
    check(ri && /^Compressed_\d{4}-\d{2}-\d{2}_\d{4}$/.test(path.basename(ri.runDir || '')) && path.dirname(ri.runDir) === out3 && rp.startsWith(ri.runDir + path.sep),
      `RECORD: 3.3.1 — runDir is the partial's own run folder (${ri && ri.runDir})`);
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[orphan-recover] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
