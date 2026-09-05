// Color-tag vocabulary bridge regression test (v2.2.5).
//
// ROOT CAUSE LOCKED HERE: ffprobe reports color values via av_color_*_name()
// DISPLAY names; the encoder option tables accept a DIFFERENT vocabulary.
// Probe "bt470m" (color_trc) — standard on 2026 graded footage — used to be
// passed verbatim and killed EVERY encode on BOTH encoders with
// "Error applying encoder options: Invalid argument" (exit 234).
//
// Real bundled ffmpeg, real buildArgs, real runBatch — no mocks.
//   1. the arg builder's probe-name → option-name mapping (bt470m→gamma22 and
//      the rest of COLOR_NAME_TO_OPT) is asserted DIRECTLY — the app's
//      behaviour, not FFmpeg's vocabulary. (An older revision proved the gap
//      by running the raw value through the encoder; FFmpeg 8.1.2 grew a
//      bt470m alias, so that would prove nothing about the app. The mapping
//      stays: harmless where the alias exists, still load-bearing for any
//      value a future probe reports that the option table does not accept.)
//   2. fixed buildArgs maps bt470m→gamma22; runBatch end-to-end succeeds;
//      original untouched; layout flat after flatten
//   3. no-known-mapping value ("reserved") is DROPPED and the encode succeeds
//   4. backstop: an option value the encoder rejects (a deliberately BOGUS
//      token no FFmpeg release can ever accept — not a real-but-unsupported
//      colour name, which a later release could legitimise) triggers the
//      strip-color retry and the file still encodes
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const {
  getBinaries, runCmd, runBatch, buildArgs, buildFallbackArgs,
  encoderColorValue, COLOR_OPT_ACCEPTED, COLOR_NAME_TO_OPT
} = require('../src/encoder/pipeline');
const { flattenRunDir } = require('../src/encoder/flatten');

const PASS = [], FAIL = [];
function check(cond, label) { (cond ? PASS : FAIL).push(label); console.log((cond ? 'PASS' : 'FAIL') + ': ' + label); }
function header(t) { console.log('\n==== ' + t + ' ===='); }

(async () => {
  const { ffmpeg, ffprobe } = getBinaries();
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-color-'));
  const srcDir = path.join(sandbox, 'Graded');
  const destDir = path.join(sandbox, 'out');
  await fsp.mkdir(srcDir, { recursive: true });
  await fsp.mkdir(destDir, { recursive: true });

  // ── Synthesize a source whose PROBE reports color_trc=bt470m.
  // setparams stamps the frames (its filter table spells it "bt470m"), the
  // H.264 encoder writes it into the VUI, and ffprobe then reports the display
  // name "bt470m" — the exact divergence that killed the 2026 graded footage.
  // h264_videotoolbox (system framework): the bundled ffmpeg is a minimal
  // native + libx265 + VideoToolbox build with no libx264.
  header('setup: synthesize bt470m-tagged source');
  const clip = path.join(srcDir, 'graded_bt470m.mov');
  const gen = await runCmd(ffmpeg, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1',
    '-vf', 'setparams=color_primaries=bt709:color_trc=bt470m:colorspace=bt709:range=tv',
    '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p',
    '-an', clip], { stallTimeoutMs: 30000 });
  check(gen.code === 0 && fs.existsSync(clip), 'synthesized 1s clip tagged gamma22/bt470m');

  const probe = await runCmd(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer', '-of', 'default=nw=1:nk=1', clip], { stallTimeoutMs: 15000 });
  const probedTrc = probe.stdout.trim();
  check(probedTrc === 'bt470m', `ffprobe reports the DISPLAY name bt470m (got "${probedTrc}")`);
  const srcBytes0 = (await fsp.stat(clip)).size;
  const srcMtime0 = (await fsp.stat(clip)).mtimeMs;

  // ── 1. the mapping itself: probe display names the option tables spell
  // differently are translated, values both vocabularies share pass through
  // unchanged, and every mapping target is on the accepted whitelist.
  header('1: arg builder maps probe display names → encoder option names');
  const oldOut = path.join(sandbox, 'old_style.tmp.mp4');
  check(encoderColorValue('color_trc', 'bt470m') === 'gamma22', 'color_trc bt470m → gamma22');
  check(encoderColorValue('color_trc', 'bt470bg') === 'gamma28', 'color_trc bt470bg → gamma28');
  check(encoderColorValue('colorspace', 'gbr') === 'rgb', 'colorspace gbr → rgb');
  check(encoderColorValue('color_trc', 'bt709') === 'bt709' && encoderColorValue('color_primaries', 'bt2020') === 'bt2020'
    && encoderColorValue('colorspace', 'bt2020nc') === 'bt2020nc' && encoderColorValue('color_range', 'tv') === 'tv',
    'shared-vocabulary values pass through unchanged');
  check(encoderColorValue('color_trc', 'unknown') === null && encoderColorValue('color_trc', null) === null,
    'unknown / missing → no tag');
  const mapTargetsAccepted = Object.entries(COLOR_NAME_TO_OPT).every(([opt, m]) =>
    Object.values(m).every((v) => COLOR_OPT_ACCEPTED[opt].has(v)));
  check(mapTargetsAccepted, 'every COLOR_NAME_TO_OPT target is on the accepted whitelist (mapping can never emit a rejected value)');
  const rawProbeArgs = buildArgs({ input: clip, tmpOut: oldOut, tier: 'regular',
    videoStream: { color_primaries: 'bt709', color_transfer: 'bt470m', color_space: 'gbr', color_range: 'tv', pix_fmt: 'yuv420p' }, audioStream: null });
  check(!rawProbeArgs.includes('bt470m') && !rawProbeArgs.includes('gbr') && rawProbeArgs.includes('gamma22') && rawProbeArgs.includes('rgb'),
    'buildArgs never passes a raw display name where the vocabularies diverge');

  // ── 2. fixed path end-to-end: buildArgs maps bt470m→gamma22, real runBatch
  // encodes, original untouched, flatten leaves a flat run dir.
  header('2: fixed buildArgs + real runBatch succeed on the bt470m source');
  const vsProbe = { color_primaries: 'bt709', color_transfer: 'bt470m', color_space: 'bt709', color_range: 'tv', pix_fmt: 'yuv420p' };
  const newArgs = buildArgs({ input: clip, tmpOut: oldOut, tier: 'regular', videoStream: vsProbe, audioStream: null });
  check(newArgs.includes('gamma22') && !newArgs.includes('bt470m'), 'buildArgs translates bt470m → gamma22');
  const fbArgs = buildFallbackArgs({ input: clip, tmpOut: oldOut, tier: 'regular', videoStream: vsProbe, audioStream: null });
  check(fbArgs.includes('gamma22') && !fbArgs.includes('bt470m'), 'buildFallbackArgs translates bt470m → gamma22');

  const res = await runBatch({ src: srcDir, dest: destDir, tier: 'regular' }, () => false, null);
  const log1 = fs.readFileSync(res.logPath, 'utf8');
  check(res.processed === 1 && res.failed === 0, `runBatch processed=1 failed=0 (got p=${res.processed} f=${res.failed})`);
  check(/^OK /m.test(log1) && !/RETRY-OK|OK-FALLBACK|OK-NOCOLOR/.test(log1), 'primary encoder succeeded first try (no fallback, no retry)');
  check(!fs.existsSync(path.join(res.runDir, '_FAILED')), 'no _FAILED dir');
  const lifted = await flattenRunDir(res.runDir);
  const top = fs.readdirSync(res.runDir, { withFileTypes: true });
  check(top.every((e) => e.isFile()), `run dir FLAT after flatten (lifted=${lifted})`);
  check(top.some((e) => e.name === 'graded_bt470m.mp4'), 'final .mp4 present at top level');
  const outTrc = await runCmd(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer', '-of', 'default=nw=1:nk=1',
    path.join(res.runDir, 'graded_bt470m.mp4')], { stallTimeoutMs: 15000 });
  check(outTrc.stdout.trim() === 'bt470m', `output PRESERVES the gamma-2.2 transfer tag (got "${outTrc.stdout.trim()}")`);
  const srcStat1 = await fsp.stat(clip);
  check(srcStat1.size === srcBytes0 && srcStat1.mtimeMs === srcMtime0, 'original untouched (size + mtime)');

  // ── 3. no-known-mapping value is dropped, encode still succeeds.
  header('3: unmapped value ("reserved") dropped, encode succeeds');
  check(encoderColorValue('color_primaries', 'reserved') === null, 'encoderColorValue drops "reserved" (no mapping)');
  const vsReserved = { ...vsProbe, color_primaries: 'reserved' };
  const dropArgs = buildArgs({ input: clip, tmpOut: oldOut, tier: 'regular', videoStream: vsReserved, audioStream: null });
  check(!dropArgs.includes('-color_primaries') && !dropArgs.includes('reserved'), 'buildArgs omits the unmapped tag entirely');
  check(dropArgs.includes('gamma22'), 'other (valid) tags kept');
  const dropRun = await runCmd(ffmpeg, dropArgs, { stallTimeoutMs: 60000 });
  check(dropRun.code === 0 && fs.existsSync(oldOut), 'encode succeeds with the tag dropped');
  try { await fsp.unlink(oldOut); } catch {}

  // ── 4. backstop: a value the whitelist DOESN'T catch reaches the encoder,
  // the primary fails EINVAL, the strip-color retry rescues the file. The
  // mapping is sabotaged so the clip's bt470m becomes a token that NO ffmpeg
  // release can ever accept (it is not a colour name at all) — this tests the
  // retry path firing, not which names this month's FFmpeg happens to know.
  header('4: backstop retry strips color tags after an option rejection');
  const BOGUS = 'skinnyvideo-bogus-trc';
  const savedMap = COLOR_NAME_TO_OPT.color_trc.bt470m;
  COLOR_NAME_TO_OPT.color_trc.bt470m = BOGUS;
  COLOR_OPT_ACCEPTED.color_trc.add(BOGUS);
  try {
    const evil = buildArgs({ input: clip, tmpOut: oldOut, tier: 'regular', videoStream: vsProbe, audioStream: null });
    check(evil.includes(BOGUS) && !evil.includes('gamma22'), 'sabotaged mapping sends the bogus token to the encoder (backstop precondition)');
    let evilErr = '';
    const evilRun = await runCmd(ffmpeg, evil, { stallTimeoutMs: 30000, onStderr: (c) => { evilErr += c; } });
    check(evilRun.code !== 0 && /Error applying encoder options/.test(evilErr) && !fs.existsSync(oldOut),
      `bogus token is rejected with the backstop signature (exit ${evilRun.code})`);
    const destDir2 = path.join(sandbox, 'out2');
    await fsp.mkdir(destDir2, { recursive: true });
    const res2 = await runBatch({ src: srcDir, dest: destDir2, tier: 'regular' }, () => false, null);
    const log2 = fs.readFileSync(res2.logPath, 'utf8');
    check(/PRIMARY-FAIL .*Error applying encoder options/.test(log2), 'primary failed with the option-rejection signature');
    check(/RETRY-OK/.test(log2), 'backstop retry triggered and succeeded');
    check(/OK-NOCOLOR/.test(log2), 'file logged OK-NOCOLOR (encoded without color tags)');
    check(res2.processed === 1 && res2.failed === 0, `backstop run processed=1 failed=0 (got p=${res2.processed} f=${res2.failed})`);
    check(!fs.existsSync(path.join(res2.runDir, '_FAILED')), 'no _FAILED dir on the backstop path');
  } finally {
    COLOR_NAME_TO_OPT.color_trc.bt470m = savedMap;
    COLOR_OPT_ACCEPTED.color_trc.delete(BOGUS);
  }
  const srcStat2 = await fsp.stat(clip);
  check(srcStat2.size === srcBytes0 && srcStat2.mtimeMs === srcMtime0, 'original still untouched after all runs');

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
