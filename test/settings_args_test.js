/* Nerd Mode foundation guard — settings-driven args are BYTE-IDENTICAL to the
   historical tier-switch args.

   Fixtures (test/fixtures/args_d7feacb.json) were captured from the PRISTINE
   arg builders at main d7feacb (v2.2.7), before buildArgs was parameterized:
   8 probe-shaped videoStream/audioStream variants (8-bit / 10-bit yuv420p10le
   / 10-bit p010le, aac / eac3 / pcm16 / pcm24 / no-audio, untagged / bt709 /
   bt470m+gamma28+fcc+pc / bt2020+HLG color) × 3 colorStamp shapes (none /
   full setparams / partial) × dropColorTags on/off × both tiers × both
   builders = 192 argv arrays.

   For every fixture the CURRENT code must reproduce the captured argv exactly,
   through BOTH entry paths:
     1. legacy: buildArgs({tier}) — no settings field (old tests, direct calls)
     2. settings: buildArgs({settings: tierDefaults(tier)}) with NO tier — the
        Nerd Mode path the renderer payload now drives
   Plus: tierDefaults must stay derived from TIER_CONSTANTS (no value drift),
   and an unknown tier must keep the historical no-video-args fall-through.

   Run:  node test/settings_args_test.js */
const path = require('path');
const { buildArgs, buildFallbackArgs, tierDefaults, TIER_CONSTANTS } =
  require(path.join(__dirname, '..', 'src/encoder/pipeline'));
const FIXTURES = require(path.join(__dirname, 'fixtures', 'args_d7feacb.json'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); if (!c) console.log('FAIL: ' + l); };

// Same variant tables the capture script used — keys must match fixture keys.
const VS = {
  v8aac:   { vs: { pix_fmt: 'yuv420p' }, as: { codec_name: 'aac' } },
  v10aac:  { vs: { pix_fmt: 'yuv420p10le' }, as: { codec_name: 'aac' } },
  v10p010: { vs: { pix_fmt: 'p010le' }, as: { codec_name: 'eac3' } },
  v8pcm:   { vs: { pix_fmt: 'yuv420p' }, as: { codec_name: 'pcm_s16le' } },
  v8noaud: { vs: { pix_fmt: 'yuv420p' }, as: null },
  v8bt709: { vs: { pix_fmt: 'yuv420p', color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709', color_range: 'tv' }, as: { codec_name: 'aac' } },
  v8bt470m:{ vs: { pix_fmt: 'yuv420p', color_primaries: 'bt470m', color_transfer: 'gamma28', color_space: 'fcc', color_range: 'pc' }, as: { codec_name: 'pcm_s24le' } },
  v10hlg:  { vs: { pix_fmt: 'yuv420p10le', color_primaries: 'bt2020', color_transfer: 'arib-std-b67', color_space: 'bt2020nc', color_range: 'tv' }, as: { codec_name: 'aac' } },
};
const STAMPS = {
  none: null,
  full: { color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709' },
  partial: { colorspace: 'bt2020nc' },
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 3.3.0 changed the stream block for everyone (explicit -map, every audio
   track, -timecode — see test/audio_tracks_test.js). That block always sits
   right before -map_metadata; drop it on both sides so these fixtures keep
   guarding everything else (video, colour, tail) byte for byte. */
const STREAM_FLAGS = /^(-map|-c:a(:\d+)?|-b:a(:\d+)?|-an|-timecode)$/;
function withoutStreamBlock(args) {
  const end = args.indexOf('-map_metadata');
  let start = end;
  while (start >= 2 && STREAM_FLAGS.test(args[start - 2])) start -= 2;
  if (start >= 1 && args[start - 1] === '-an') start -= 1;
  return [...args.slice(0, start), ...args.slice(end)];
}

let legacyOk = 0, settingsOk = 0;
for (const f of FIXTURES) {
  const [vk, sk, dropKey, tier, builder] = f.key.split('|');
  const { vs, as } = VS[vk];
  const stamp = STAMPS[sk];
  const drop = dropKey === 'drop=true';
  const fn = builder === 'primary' ? buildArgs : buildFallbackArgs;

  const legacy = fn({ input: '/in/clip.mov', tmpOut: '/out/clip.tmp.mp4', tier,
    videoStream: vs, audioStream: as, dropColorTags: drop, colorStamp: stamp });
  if (same(withoutStreamBlock(legacy), withoutStreamBlock(f.args))) legacyOk++;
  else check(false, `legacy path diverged: ${f.key}\n  want ${JSON.stringify(f.args)}\n  got  ${JSON.stringify(legacy)}`);

  const viaSettings = fn({ input: '/in/clip.mov', tmpOut: '/out/clip.tmp.mp4',
    settings: tierDefaults(tier),
    videoStream: vs, audioStream: as, dropColorTags: drop, colorStamp: stamp });
  if (same(withoutStreamBlock(viaSettings), withoutStreamBlock(f.args))) settingsOk++;
  else check(false, `settings path diverged: ${f.key}\n  want ${JSON.stringify(f.args)}\n  got  ${JSON.stringify(viaSettings)}`);
}
check(legacyOk === FIXTURES.length, `legacy tier path byte-identical (outside the stream block) for all ${FIXTURES.length} fixtures (got ${legacyOk})`);
check(settingsOk === FIXTURES.length, `settings path byte-identical (outside the stream block) for all ${FIXTURES.length} fixtures (got ${settingsOk})`);
// The stream block itself must still be identical between the two entry paths.
{
  const vs = { index: 0, pix_fmt: 'yuv420p' }, auds = [{ index: 1, codec_name: 'aac', channels: 2 }, { index: 2, codec_name: 'pcm_s24le', channels: 1 }];
  const a = buildArgs({ input: '/i.mov', tmpOut: '/o.mp4', tier: 'preserve', videoStream: vs, audioStreams: auds, timecode: '01:00:00:00' });
  const b = buildArgs({ input: '/i.mov', tmpOut: '/o.mp4', settings: tierDefaults('preserve'), videoStream: vs, audioStreams: auds, timecode: '01:00:00:00' });
  check(same(a, b), 'stream block identical through the legacy and settings paths');
}

// Defaults stay DERIVED from TIER_CONSTANTS — value drift breaks here.
check(same(tierDefaults('regular'), { vcodec: 'hevc_videotoolbox', qv: TIER_CONSTANTS.regular.qv }),
  'regular defaults derived from TIER_CONSTANTS');
check(same(tierDefaults('preserve'), { vcodec: 'libx265', crf: TIER_CONSTANTS.preserve.crf, preset: TIER_CONSTANTS.preserve.preset }),
  'preserve defaults derived from TIER_CONSTANTS');

// QV ceiling (v2.2.8): the arg-builder boundary clamps qv to 85 — a stale
// payload (e.g. old session memory at qv=90) can never reach the encoder
// over the ceiling. Defaults (62) untouched — the 192 fixtures above prove it.
const QV_MAX = require(path.join(__dirname, '..', 'src/encoder/pipeline')).QV_MAX;
check(QV_MAX === 85, 'QV_MAX is 85');
const over = buildArgs({ input: '/in/c.mov', tmpOut: '/out/c.tmp.mp4',
  settings: { vcodec: 'hevc_videotoolbox', qv: 90 },
  videoStream: { pix_fmt: 'yuv420p' }, audioStream: null });
const qvIdx = over.indexOf('-q:v');
check(qvIdx > -1 && over[qvIdx + 1] === '85', `payload qv=90 reaches the encoder clamped to 85 (got ${over[qvIdx + 1]})`);
const at85 = buildArgs({ input: '/in/c.mov', tmpOut: '/out/c.tmp.mp4',
  settings: { vcodec: 'hevc_videotoolbox', qv: 85 },
  videoStream: { pix_fmt: 'yuv420p' }, audioStream: null });
check(at85[at85.indexOf('-q:v') + 1] === '85', 'qv=85 passes through unclamped');

// Unknown tier keeps the historical fall-through: no -c:v injected.
const unk = buildArgs({ input: '/in/c.mov', tmpOut: '/out/c.tmp.mp4', tier: 'nope',
  videoStream: { pix_fmt: 'yuv420p' }, audioStream: null });
check(!unk.includes('-c:v'), 'unknown tier still injects no video codec args');
check(same(tierDefaults('nope'), {}), 'unknown tier resolves to empty settings');

console.log(`\nPASS: ${PASS.length} FAIL: ${FAIL.length}`);
process.exit(FAIL.length ? 1 : 0);
