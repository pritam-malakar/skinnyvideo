/* scripts/print-args.js + scripts/bench.sh — the benchmark measures exactly
   the command the app builds, and compares at the source's own format.
     · print-args argv == pipeline.buildArgs for the same probe (no copy of the
       command anywhere), tier settings and overrides land, qv is capped at 85,
       a flag for the wrong tier is refused
     · bench.sh on a 10-bit 4:2:2 clip: encode succeeds, the comparison runs at
       yuv422p10le over every frame (never 8-bit), PSNR/SSIM/reclaim are
       numbers, VMAF is computed when a libvmaf ffmpeg exists (3.3.0), the JSON line parses, the temp folder is removed — and kept
       with --keep
   Run: node test/bench_test.js */
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const p = require('../src/encoder/pipeline');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-benchtest-')));
const { ffmpeg } = p.getBinaries();
const CLIP = path.join(SB, 'clip.mov');
const printArgs = (...a) => spawnSync('node', [path.join(ROOT, 'scripts/print-args.js'), ...a], { encoding: 'utf8' });
const bench = (...a) => spawnSync('bash', [path.join(ROOT, 'scripts/bench.sh'), ...a], { encoding: 'utf8', env: { ...process.env, TMPDIR: SB + '/' } });
const benchDirs = () => fs.readdirSync(SB).filter((f) => f.startsWith('sv-bench.'));

(async () => {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-f', 'lavfi', '-i', 'sine=d=1',
    '-pix_fmt', 'yuv422p10le', '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', '-shortest', CLIP]);

  // print-args == buildArgs over the pipeline's own probe.
  const out = path.join(SB, 'o.mp4');
  const r = printArgs(CLIP, 'better', out);
  const plan = JSON.parse(r.stdout);
  const probe = await p.ffprobeJson(CLIP);
  const vs = p.pickVideoStream(probe.streams);
  const direct = p.buildArgs({ input: CLIP, tmpOut: out, tier: 'preserve', settings: p.tierDefaults('preserve'),
    videoStream: vs, audioStreams: p.streamPlan(probe).audioStreams, timecode: p.streamPlan(probe).timecode, colorStamp: p.resolveColorStamp(await p.ffprobeFrameColor(CLIP), vs) });
  check(JSON.stringify(plan.argv) === JSON.stringify(direct), 'print-args argv is exactly pipeline.buildArgs for the same input');
  const a = plan.argv.join(' ');
  check(/-c:v libx265 -crf 18 -preset medium/.test(a) && /-pix_fmt yuv420p10le/.test(a) && /-c:a:0 aac_at -b:a:0 320k/.test(a) && plan.argv[plan.argv.length - 1] === out,
    `better: x265 CRF 18 medium, 10-bit kept, PCM → AAC 320k, output last (${a})`);
  check(/-crf 22 /.test(JSON.parse(printArgs(CLIP, 'better', out, '--crf', '22').stdout).argv.join(' ')), '--crf 22 overrides the CRF');
  const reg = JSON.parse(printArgs(CLIP, 'regular', out, '--quality', '99').stdout).argv.join(' ');
  check(/-c:v hevc_videotoolbox -q:v 85 /.test(reg) && /-profile:v main10 -pix_fmt p010le/.test(reg), `regular --quality 99 is capped at 85, Main 10 (${reg})`);
  const wrong = printArgs(CLIP, 'regular', out, '--crf', '20');
  check(wrong.status === 2 && /does not apply/.test(wrong.stderr), '--crf on regular is refused');

  // bench.sh end to end.
  const b = bench(CLIP, 'regular');
  const lines = b.stdout.trim().split('\n');
  let j = null; try { j = JSON.parse(lines[lines.length - 1]); } catch {}
  check(b.status === 0 && j && j.encode_exit === 0, `bench.sh regular exits 0 with a JSON line (status ${b.status}; ${b.stderr.trim().slice(-200)})`);
  if (j) {
    check(j.compare.pix_fmt === 'yuv422p10le' && j.compare.frames === 25, `compared all 25 frames at the source's yuv422p10le (${JSON.stringify(j.compare)})`);
    check(j.output.pix_fmt === 'yuv420p10le', `output stayed 10-bit (${j.output.pix_fmt})`);
    check(j.psnr_db.average > 30 && j.ssim.all > 0.9 && j.ssim.all <= 1, `PSNR ${j.psnr_db.average} dB, SSIM ${j.ssim.all} are plausible numbers`);
    check(Number.isFinite(j.reclaim_pct) && Number.isFinite(j.realtime_x) && j.wall_s > 0, `reclaim ${j.reclaim_pct}%, ${j.realtime_x}× realtime`);
    check(/Apple|Intel/.test(j.machine.chip) && /^ffmpeg version/.test(j.machine.ffmpeg) && /^\d/.test(j.machine.x265 || ''), `machine reported (${JSON.stringify(j.machine)})`);
    check(/PSNR\s+average/.test(b.stdout) && /SSIM\s+All/.test(b.stdout), 'human-readable table printed');
    // 3.3.0: VMAF when any libvmaf-capable ffmpeg exists (bundled first, then Homebrew/PATH).
    const vmafFF = [p.getBinaries().ffmpeg, process.env.SV_VMAF_FFMPEG, '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
      .find((f) => f && fs.existsSync(f) && / libvmaf /.test(spawnSync(f, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || ''));
    check('vmaf' in j && /VMAF\s/.test(b.stdout), `VMAF field in the JSON and a VMAF row in the table (${JSON.stringify(j.vmaf)})`);
    if (vmafFF) check(j.vmaf && j.vmaf.mean > 50 && j.vmaf.mean <= 100 && j.vmaf.ffmpeg === vmafFF && j.vmaf.model === 'vmaf_v0.6.1' && j.vmaf.exit === 0,
      `VMAF computed by ${vmafFF}: mean ${j.vmaf && j.vmaf.mean}, default model`);
    else check(j.vmaf === null, 'no libvmaf ffmpeg on this machine → VMAF is null, not invented');
  }
  check(benchDirs().length === 0, `work folder removed without --keep (${benchDirs()})`);
  const k = bench('--keep', CLIP, 'regular');
  const kept = benchDirs();
  check(k.status === 0 && kept.length === 1 && fs.existsSync(path.join(SB, kept[0], 'out.mp4')), `--keep leaves the work folder (${kept})`);
  for (const d of kept) fs.rmSync(path.join(SB, d), { recursive: true, force: true });

  /* Variable frame rate (iPhone-style): the app writes a constant-rate MP4, so
     pairing frames by timestamp drifts a frame off and PSNR collapses. The
     comparison must put the source on the output's frame grid. Every
     other frame is one 1/6000 s tick late, as iPhones record; pairing by
     timestamp then compares against the previous frame (about 30 dB here). */
  const VFR = path.join(SB, 'vfr.mov');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=60:d=3',
    '-vf', "settb=1/6000,setpts='N*100+mod(N,2)'", '-fps_mode', 'passthrough', '-enc_time_base', '1/6000',
    '-video_track_timescale', '6000', '-c:v', 'prores_ks', '-pix_fmt', 'yuv422p10le', VFR]);
  const v = bench(VFR, 'better');
  let vj = null; try { vj = JSON.parse(v.stdout.trim().split('\n').pop()); } catch {}
  check(vj && vj.psnr_db.y > 40, `VFR source: frames aligned, PSNR Y ${vj && vj.psnr_db.y} dB > 40 (misaligned pairing scores far lower)`);
})().catch((e) => { FAIL.push('unexpected throw: ' + e.message); console.error(e); })
  .finally(() => {
    fs.rmSync(SB, { recursive: true, force: true });
    console.log(`\n[bench] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
    process.exit(FAIL.length ? 1 : 0);
  });
