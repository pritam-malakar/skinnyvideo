// Color-tag vocabulary bridge regression test (v2.2.5).
//
// ROOT CAUSE LOCKED HERE: ffprobe reports color values via av_color_*_name()
// DISPLAY names; the encoder option tables accept a DIFFERENT vocabulary.
// Probe "bt470m" (color_trc) — standard on 2026 graded footage — used to be
// passed verbatim and killed EVERY encode on BOTH encoders with
// "Error applying encoder options: Invalid argument" (exit 234).
//
// Real bundled ffmpeg, real buildArgs, real runBatch — no mocks.
//   1. fail-on-old: verbatim probe value (old construction) → exit 234 + signature
//   2. fixed buildArgs maps bt470m→gamma22; runBatch end-to-end succeeds;
//      original untouched; layout flat after flatten
//   3. no-known-mapping value ("reserved") is DROPPED and the encode succeeds
//   4. backstop: a bad value that slips PAST the whitelist triggers the
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
  // setparams stamps the frames (its filter table spells it "bt470m"), x264
  // writes it into the VUI, and ffprobe then reports the display name
  // "bt470m" — the exact divergence that killed the 2026 graded footage.
  header('setup: synthesize bt470m-tagged source');
  const clip = path.join(srcDir, 'graded_bt470m.mov');
  const gen = await runCmd(ffmpeg, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1',
    '-vf', 'setparams=color_primaries=bt709:color_trc=bt470m:colorspace=bt709:range=tv',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-an', clip], { stallTimeoutMs: 30000 });
  check(gen.code === 0 && fs.existsSync(clip), 'synthesized 1s clip tagged gamma22/bt470m');

  const probe = await runCmd(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=color_transfer', '-of', 'default=nw=1:nk=1', clip], { stallTimeoutMs: 15000 });
  const probedTrc = probe.stdout.trim();
  check(probedTrc === 'bt470m', `ffprobe reports the DISPLAY name bt470m (got "${probedTrc}") — vocabulary gap exists`);
  const srcBytes0 = (await fsp.stat(clip)).size;
  const srcMtime0 = (await fsp.stat(clip)).mtimeMs;

  // ── 1. fail-on-old: the OLD construction (probe value verbatim) dies with
  // the exact field signature, even with an EXISTING destination dir.
  header('1: old construction fails (exit 234, "Error applying encoder options")');
  const oldOut = path.join(sandbox, 'old_style.tmp.mp4');
  const oldArgs = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-stats', '-i', clip,
    '-c:v', 'hevc_videotoolbox', '-q:v', '62', '-tag:v', 'hvc1',
    '-color_primaries', 'bt709', '-color_trc', 'bt470m', '-colorspace', 'bt709', '-color_range', 'tv',
    '-an', '-map_metadata', '0', '-movflags', 'use_metadata_tags+faststart', oldOut];
  let oldErr = '';
  const oldRun = await runCmd(ffmpeg, oldArgs, { stallTimeoutMs: 30000, onStderr: (c) => { oldErr += c; } });
  check(oldRun.code === 234, `old args exit 234 (got ${oldRun.code})`);
  check(/Error applying encoder options/.test(oldErr), 'old args hit "Error applying encoder options"');
  check(!fs.existsSync(oldOut), 'old args produced no output');

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

  // ── 4. backstop: a value the whitelist DOESN'T catch (simulated future
  // vocabulary drift — bt470m force-whitelisted, mapping removed) reaches the
  // encoder, primary fails EINVAL, the strip-color retry rescues the file.
  header('4: backstop retry strips color tags after an option rejection');
  const savedMap = COLOR_NAME_TO_OPT.color_trc.bt470m;
  delete COLOR_NAME_TO_OPT.color_trc.bt470m;
  COLOR_OPT_ACCEPTED.color_trc.add('bt470m');
  try {
    const evil = buildArgs({ input: clip, tmpOut: oldOut, tier: 'regular', videoStream: vsProbe, audioStream: null });
    check(evil.includes('bt470m'), 'sabotaged whitelist lets the raw probe value through (backstop precondition)');
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
    COLOR_OPT_ACCEPTED.color_trc.delete('bt470m');
  }
  const srcStat2 = await fsp.stat(clip);
  check(srcStat2.size === srcBytes0 && srcStat2.mtimeMs === srcMtime0, 'original still untouched after all runs');

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
