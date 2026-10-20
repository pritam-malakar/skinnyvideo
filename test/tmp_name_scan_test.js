/* 3.3.1 Item 5 — a user's own "*.tmp.mp4" is a video like any other.
   Plain node, REAL pipeline (scanFolder, runBatch) + REAL queue-runner, real
   clips made with the bundled ffmpeg (libx265 — no VideoToolbox needed; the
   encode uses the Preserve tier, which is libx265 too).

   ORDINARY   holiday.tmp.mp4 in an ordinary folder is scanned (not counted as
              skipped) and encoded: OK line in compress.log, holiday.tmp.mp4 in the
              run folder, outcome ok.
   RUN-FOLDER a .tmp.mp4 inside Compressed_2026-10-20_0101/ is skipped and counted.
   RECORDED   a recorded partial outside any run folder is skipped and counted —
              by scanFolder({ partials }), and by a real run through runQueue's
              recordedPartials (SKIPPED_OUTPUTS line, not encoded).

   FAIL-ON-OLD (3.3.0 / 399c3d2): walkAll skipped every *.tmp.mp4 / *.tmp_<n>.mp4
   by name, anywhere — holiday.tmp.mp4 was silently dropped (counted as an output).
   Run: node test/tmp_name_scan_test.js */
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

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-tmpname-')));
const clip = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = spawnSync(P.getBinaries().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1',
    '-c:v', 'libx265', '-x265-params', 'log-level=none', '-pix_fmt', 'yuv420p', p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return p;
};
const names = (scan) => scan.videos.map((v) => path.relative(SB, v.file)).sort();

(async () => {
  try {
    // ── ORDINARY ──
    const card = path.join(SB, 'Card');
    const holiday = clip(path.join(card, 'holiday.tmp.mp4'));
    clip(path.join(card, 'beach.mov'));
    let s = await P.scanFolder(card);
    check(names(s).join(',') === 'Card/beach.mov,Card/holiday.tmp.mp4' && s.skippedOutputs === 0,
      `ORDINARY: holiday.tmp.mp4 is scanned, nothing counted as skipped (${names(s)}; skipped ${s.skippedOutputs})`);

    const out = path.join(SB, 'Out'); fs.mkdirSync(out);
    const evs = [];
    const res = await P.runBatch({ src: card, dest: out, tier: 'preserve', kind: 'folder' }, {}, (e) => evs.push(e));
    const log = res.logPath ? fs.readFileSync(res.logPath, 'utf8') : '';
    const done = evs.filter((e) => e.type === 'file-done' && e.file === holiday);
    check(done.length === 1 && /^ok/.test(done[0].outcome) && new RegExp(`^OK ${holiday.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -> `, 'm').test(log),
      `ORDINARY: holiday.tmp.mp4 is encoded (outcome ${done.map((d) => d.outcome)}; processed ${res.processed} of ${res.totalFiles})`);
    check(!/SKIPPED_OUTPUTS/.test(log), 'ORDINARY: no SKIPPED_OUTPUTS line');

    // ── RUN-FOLDER ──
    const card2 = path.join(SB, 'Card2');
    clip(path.join(card2, 'a.mov'));
    clip(path.join(card2, 'Compressed_2026-10-20_0101', 'x.tmp.mp4'));
    s = await P.scanFolder(card2);
    check(names(s).join(',') === 'Card2/a.mov' && s.skippedOutputs === 1, `RUN-FOLDER: .tmp.mp4 inside a run folder skipped and counted (${names(s)}; skipped ${s.skippedOutputs})`);

    // ── RECORDED ──
    const card3 = path.join(SB, 'Card3');
    clip(path.join(card3, 'b.mov'));
    const rec = clip(path.join(card3, 'Elsewhere', 'y.tmp.mp4'));
    s = await P.scanFolder(card3, { partials: [rec] });
    check(names(s).join(',') === 'Card3/b.mov' && s.skippedOutputs === 1, `RECORDED: a recorded partial outside a run folder is skipped and counted (${names(s)}; skipped ${s.skippedOutputs})`);
    s = await P.scanFolder(card3);
    check(names(s).length === 2, `RECORDED: the same file, no longer recorded, is scanned (${names(s)})`);

    const out3 = path.join(SB, 'Out3'); fs.mkdirSync(out3);
    const rtm = new Map(); const rt = (id) => { if (!rtm.has(id)) rtm.set(id, {}); return rtm.get(id); };
    const sent = [];
    await runQueue([{ id: 1, kind: 'folder', src: card3, dest: out3, tier: 'preserve', dryRun: false, fileSources: [], skipped: [] }],
      { send: (ch, p) => sent.push([ch, p]), isStopRequested: () => false, rt, recordedPartials: () => [rec] });
    const st = sent.filter(([ch]) => ch === 'batch-status').pop();
    const r3 = st && st[1].result;
    const log3 = r3 && r3.logPath && fs.existsSync(r3.logPath) ? fs.readFileSync(r3.logPath, 'utf8') : '';
    check(r3 && r3.totalFiles === 1 && /SKIPPED_OUTPUTS 1 file\(s\) inside SkinnyVideo output folders/.test(log3) && !log3.includes('y.tmp.mp4 ->'),
      `RECORDED: a real run skips it too, with the SKIPPED_OUTPUTS log line (totalFiles ${r3 && r3.totalFiles})`);
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[tmp-name-scan] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
