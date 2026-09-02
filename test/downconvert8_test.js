/* downconvert8 regression (Nerd-mode "Downconvert 10-bit to 8-bit").
   Drives the REAL buildArgs + a REAL 2s encode of the 10-bit HLG clip.

   Asserts:
   A. {downconvert8:true} on a 10-bit source forces the 8-bit token (VT nv12 /
      x265 yuv420p) and DROPS main10/p010le, while the color args stay intact.
   B. {downconvert8:true} on an 8-bit source is a byte-identical NO-OP.
   C. absent/false = current behavior (10-bit preserved), byte-identical.
   D. REAL encode of IMG_0332.mov with downconvert8 ON → 8-bit Main output that
      still carries color_primaries=bt2020 + color_transfer=arib-std-b67.

   FAIL-ON-OLD: pre-flag buildArgs ignores downconvert8 → a 10-bit source still
   emits main10/p010le → assertion A fails. Run: node test/downconvert8_test.js */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..');
const { buildArgs, buildFallbackArgs, tierDefaults } = require(path.join(REPO, 'src/encoder/pipeline'));
const FFMPEG = path.join(REPO, 'resources/bin/ffmpeg');
const FFPROBE = path.join(REPO, 'resources/bin/ffprobe');
const CLIP = '/Users/macmini1/Downloads/IMG_0332.mov';
const SCRATCH = '/tmp/skinnyvideo_dc8';

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const has = (args, ...seq) => {                       // contiguous token subsequence?
  for (let i = 0; i + seq.length <= args.length; i++) {
    if (seq.every((t, k) => args[i + k] === t)) return true;
  }
  return false;
};

// HLG 10-bit videoStream (bt2020 + arib-std-b67), 8-bit variant, + aac audio.
const VS10 = { pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' };
const VS8  = { pix_fmt: 'yuv420p',     color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' };
const AS = { codec_name: 'aac' };
const mk = (tier, vs, extra) => buildArgs({
  input: 'in.mov', tmpOut: 'out.mp4', tier,
  settings: { ...tierDefaults(tier), ...(extra || {}) },
  videoStream: vs, audioStream: AS, dropColorTags: false, colorStamp: null,
});
const mkFb = (vs, extra) => buildFallbackArgs({
  input: 'in.mov', tmpOut: 'out.mp4', tier: 'preserve',
  settings: { ...tierDefaults('preserve'), ...(extra || {}) },
  videoStream: vs, audioStream: AS, dropColorTags: false, colorStamp: null,
});

// ── A: 10-bit + downconvert8 → forced 8-bit token, main10/p010le gone, color intact ──
{
  const vtOn = mk('regular', VS10, { downconvert8: true });
  check(has(vtOn, '-pix_fmt', 'nv12') && !has(vtOn, '-profile:v', 'main10') && !has(vtOn, '-pix_fmt', 'p010le'),
    `VT 10-bit + downconvert8 → -pix_fmt nv12, no main10/p010le`);
  check(has(vtOn, '-color_primaries', 'bt2020') && has(vtOn, '-color_trc', 'arib-std-b67')
    && has(vtOn, '-colorspace', 'bt2020nc') && has(vtOn, '-color_range', 'tv'),
    `VT forced-8-bit STILL carries color args (bt2020 + arib-std-b67 …)`);

  const x265On = mk('preserve', VS10, { downconvert8: true });
  check(has(x265On, '-pix_fmt', 'yuv420p') && !has(x265On, '-pix_fmt', 'yuv420p10le'),
    `x265 10-bit + downconvert8 → -pix_fmt yuv420p, no yuv420p10le`);
  check(has(x265On, '-color_primaries', 'bt2020') && has(x265On, '-color_trc', 'arib-std-b67'),
    `x265 forced-8-bit STILL carries color args`);
}

// ── A2: FALLBACK encoder honors downconvert8 the same way (libx265 backstop) ──
{
  const fbOn = mkFb(VS10, { downconvert8: true });
  check(has(fbOn, '-pix_fmt', 'yuv420p') && !has(fbOn, '-pix_fmt', 'yuv420p10le'),
    `fallback 10-bit + downconvert8 → -pix_fmt yuv420p, no yuv420p10le`);
  check(has(fbOn, '-color_primaries', 'bt2020') && has(fbOn, '-color_trc', 'arib-std-b67'),
    `fallback forced-8-bit STILL carries color args`);
  const fbOff = mkFb(VS10, {});
  check(has(fbOff, '-pix_fmt', 'yuv420p10le') && !has(fbOff, '-pix_fmt', 'yuv420p'),
    `fallback 10-bit + no flag → yuv420p10le (unchanged)`);
  const fb8on  = mkFb(VS8, { downconvert8: true });
  const fb8off = mkFb(VS8, {});
  check(JSON.stringify(fb8on) === JSON.stringify(fb8off),
    `fallback: downconvert8 on an 8-bit source is a byte-identical no-op`);
}

// ── B: 8-bit source + downconvert8 → NO-OP (byte-identical to no flag) ──
{
  for (const tier of ['regular', 'preserve']) {
    const on  = mk(tier, VS8, { downconvert8: true });
    const off = mk(tier, VS8, {});
    check(JSON.stringify(on) === JSON.stringify(off),
      `${tier}: downconvert8 on an 8-bit source is a byte-identical no-op`);
  }
}

// ── C: absent/false = current 10-bit behavior, byte-identical ──
{
  for (const tier of ['regular', 'preserve']) {
    const base  = mk(tier, VS10, {});                      // current (no flag)
    const off   = mk(tier, VS10, { downconvert8: false }); // explicit false
    check(JSON.stringify(base) === JSON.stringify(off), `${tier}: downconvert8:false ≡ absent (current 10-bit)`);
  }
  const vt10 = mk('regular', VS10, {});
  check(has(vt10, '-profile:v', 'main10') && has(vt10, '-pix_fmt', 'p010le'),
    `VT 10-bit default still preserves 10-bit (main10/p010le)`);
}

// ── D: REAL encode — IMG_0332 with downconvert8 ON → 8-bit Main + color survives ──
(() => {
  if (!fs.existsSync(CLIP) || !fs.existsSync(FFMPEG)) {
    check(false, `DECISIVE real-encode SKIPPED — clip or bundled ffmpeg missing (${CLIP})`);
    return;
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  // probe the real source → real videoStream/audioStream
  const pj = spawnSync(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_streams', CLIP], { encoding: 'utf8' });
  const streams = JSON.parse(pj.stdout).streams;
  const vs = streams.find((s) => s.codec_type === 'video');
  const as = streams.find((s) => s.codec_type === 'audio') || null;
  check(/10/.test(vs.pix_fmt), `source confirmed 10-bit (${vs.pix_fmt})`);

  const out = path.join(SCRATCH, 'dc8.mp4');
  const args = buildArgs({
    input: CLIP, tmpOut: out, tier: 'regular',
    settings: { ...tierDefaults('regular'), downconvert8: true },
    videoStream: vs, audioStream: as, dropColorTags: false, colorStamp: null,
  });
  args.splice(args.length - 1, 0, '-t', '2');   // 2s for speed, before output path
  const enc = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  check(enc.status === 0 && fs.existsSync(out), `forced-8-bit encode succeeded (exit ${enc.status})`);

  const pr = spawnSync(FFPROBE, ['-v', 'quiet', '-select_streams', 'v:0', '-show_entries',
    'stream=profile,pix_fmt,color_primaries,color_transfer,color_space', '-of', 'json', out], { encoding: 'utf8' });
  const o = JSON.parse(pr.stdout).streams[0];
  check(/^yuv420p$/.test(o.pix_fmt) && /Main$/.test(o.profile || ''),
    `DECISIVE: output is 8-bit (pix_fmt=${o.pix_fmt}, profile=${o.profile})`);
  check(o.color_primaries === 'bt2020' && o.color_transfer === 'arib-std-b67',
    `DECISIVE: 8-bit output STILL carries HLG color (primaries=${o.color_primaries}, transfer=${o.color_transfer})`);

  fs.rmSync(SCRATCH, { recursive: true, force: true });   // clean up scratch
})();

console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
process.exit(FAIL.length ? 1 : 0);
