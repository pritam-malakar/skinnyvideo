/* Synthesized stand-in for the hand-made CompressorTest tree this suite was
   originally written against. That tree only ever existed in one developer's
   home folder, which left five tests dead on every other checkout. We build an
   equivalent with the bundled ffmpeg (lavfi sources, h264_videotoolbox/libx265)
   and cache it under test/fixtures/generated/, so it costs one build per checkout.

   ensureFixtures() returns null when the bundled ffmpeg is missing — callers then
   skip() with a printed reason instead of failing. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FFMPEG = path.join(REPO, 'resources/bin/ffmpeg');
const ROOT = path.join(REPO, 'test/fixtures/generated');
const RECIPE = 'v1';                       // bump to force a rebuild
const STAMP = path.join(ROOT, '.built-' + RECIPE);

const SOURCE = path.join(ROOT, 'Source');
const PROJECT_A = path.join(SOURCE, 'Project A');

const paths = {
  root: ROOT,
  source: SOURCE,
  projectA: PROJECT_A,
  smallClip: path.join(PROJECT_A, 'C0224.mov'),   // 4K H264 + PCM, ~3s
  hdrClip: path.join(ROOT, 'hdr', 'IMG_0332.mov'),// 720p 10-bit HLG/bt2020
  longClip: path.join(ROOT, 'gate', 'FAQs.mov'),  // 1080p, ~120s — still encoding
  outputBase: path.join(ROOT, 'Output'),
};

function skip(reason) {
  console.log('SKIP: ' + reason);
}

function run(args) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed (' + r.status + '): ' + (r.stderr || '').trim());
}

function build() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const d of [PROJECT_A, path.join(ROOT, 'hdr'), path.join(ROOT, 'gate'), paths.outputBase]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // C0224.mov — the clip pilot asserts 4K on, with PCM audio so the AAC
  // re-encode assertion stays meaningful.
  run(['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=3',
       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
       '-c:v', 'h264_videotoolbox', '-b:v', '12M', '-pix_fmt', 'yuv420p',
       '-c:a', 'pcm_s16le', '-shortest', paths.smallClip]);

  // Two more videos so Project A holds the 3 the scan test expects.
  for (const name of ['C0225.mov', 'C0226.mov']) {
    run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2',
         '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
         '-c:v', 'h264_videotoolbox', '-b:v', '2M', '-pix_fmt', 'yuv420p',
         '-c:a', 'aac', '-shortest', path.join(PROJECT_A, name)]);
  }

  // Three non-video files so the "ignored" count matches.
  run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1:duration=1',
       '-frames:v', '1', '-c:v', 'mjpeg', path.join(PROJECT_A, 'still_a.jpg')]);
  for (const name of ['still_b.png', 'still_c.png']) {
    run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=1:duration=1',
         '-frames:v', '1', '-c:v', 'png', path.join(PROJECT_A, name)]);
  }

  // 10-bit HLG/bt2020 source for the downconvert-to-8-bit check.
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2',
       '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
       '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
       '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
       '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
       '-c:a', 'aac', '-shortest', '-tag:v', 'hvc1', paths.hdrClip]);

  // A clip long enough that it is still encoding after a short one finishes.
  run(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=120',
       '-f', 'lavfi', '-i', 'sine=frequency=220:duration=120',
       '-c:v', 'h264_videotoolbox', '-b:v', '1M', '-pix_fmt', 'yuv420p',
       '-c:a', 'aac', '-shortest', paths.longClip]);

  fs.writeFileSync(STAMP, new Date().toISOString() + '\n');
}

let cached;
function ensureFixtures() {
  if (cached !== undefined) return cached;
  if (!fs.existsSync(FFMPEG)) {
    cached = null;
    return cached;
  }
  try {
    if (!fs.existsSync(STAMP)) {
      console.log('(building test fixtures with the bundled ffmpeg — first run only)');
      build();
    }
    fs.mkdirSync(paths.outputBase, { recursive: true });
    cached = paths;
  } catch (e) {
    console.log('(fixture build failed: ' + e.message + ')');
    cached = null;
  }
  return cached;
}

module.exports = { ensureFixtures, skip, FFMPEG, paths };
