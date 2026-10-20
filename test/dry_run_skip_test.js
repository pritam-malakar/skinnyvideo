/* 3.3.1 Item 6 — a folder dry run (Preview) leaves out skipped files.
   Plain node, REAL queue-runner + REAL pipeline.dryRunBatch, real clips made
   with the bundled ffmpeg (libx265, no VideoToolbox needed).

   SKIP-ONE  two-video folder, one skipped (live rt().skips, as main sets it) →
             the dry-summary says 1 video, Est. reclaim totals only the kept file,
             and the batch result counts 1 file.
   NO-SKIP   guard: with no skip both videos are counted (passes on old code too).

   FAIL-ON-OLD (3.3.0 / 399c3d2): dryRunBatch totalled every scanned video; the
   skip list reached it as batch.skip and was ignored — the preview said 2.
   Run: node test/dry_run_skip_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src/encoder/pipeline'));
const { runQueue } = require(path.join(ROOT, 'src/main/queue-runner'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
if (!P.ffmpegStatus(P.getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); console.log('\nPASS: 0 FAIL: 0'); process.exit(0); }

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dryskip-')));
const clip = (p, d) => {
  const r = spawnSync(P.getBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=320x240:r=25:d=${d}`,
    '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return p;
};

async function preview(src, skips) {
  const rtm = new Map(); const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
  if (skips) rt(1).skips = new Set(skips);
  const sent = [];
  await runQueue([{ id: 1, kind: 'folder', src, dest: path.join(SB, 'Out'), tier: 'regular', dryRun: true, fileSources: [], skipped: [] }],
    { send: (ch, p) => sent.push([ch, p]), isStopRequested: () => false, rt });
  const sum = sent.map(([, p]) => p).find((p) => p && p.type === 'dry-summary');
  const st = sent.filter(([ch]) => ch === 'batch-status').pop();
  return { sum, result: st && st[1].result };
}

(async () => {
  try {
    const card = path.join(SB, 'Card'); fs.mkdirSync(card);
    const a = clip(path.join(card, 'a.mov'), 1), b = clip(path.join(card, 'b.mov'), 3);
    const sa = fs.statSync(a).size, sb = fs.statSync(b).size;
    const est = (bytes) => bytes - bytes * 0.45;   // Regular tier's preview ratio

    const all = await preview(card);
    check(all.sum && all.sum.videos === 2 && Math.abs(all.sum.estReclaim - est(sa + sb)) < 1, `NO-SKIP: preview counts both videos (${all.sum && all.sum.videos}, est ${all.sum && Math.round(all.sum.estReclaim)})`);

    const one = await preview(card, [b]);
    check(one.sum && one.sum.videos === 1, `SKIP-ONE: preview says 1 video (got ${one.sum && one.sum.videos})`);
    check(one.sum && Math.abs(one.sum.estReclaim - est(sa)) < 1, `SKIP-ONE: Est. reclaim totals only the kept file (${one.sum && Math.round(one.sum.estReclaim)} vs ${Math.round(est(sa))})`);
    check(one.result && one.result.totalFiles === 1, `SKIP-ONE: batch result counts 1 file (got ${one.result && one.result.totalFiles})`);
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[dry-run-skip] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
