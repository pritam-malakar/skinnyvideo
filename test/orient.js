// Synthesize portrait/square/small-edge clips under Output (never touching Source)
// then run aggressive tier and verify scale rules.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawnSync } = require('child_process');
const { runBatch, getBinaries } = require('../src/encoder/pipeline');

const TEST_ROOT = '/Users/macmini1/Downloads/CompressorTest';
const OUT = path.join(TEST_ROOT, 'Output', 'orient_test');
const PASS=[], FAIL=[];
function check(cond, label){ (cond?PASS:FAIL).push(label); console.log((cond?'PASS':'FAIL')+': '+label); }

async function makeClip(name, w, h, dur = 1) {
  await fsp.mkdir(OUT, { recursive: true });
  const out = path.join(OUT, name);
  const { ffmpeg } = getBinaries();
  const r = spawnSync(ffmpeg, [
    '-y','-hide_banner','-loglevel','error',
    '-f','lavfi','-i', `testsrc=size=${w}x${h}:duration=${dur}:rate=30`,
    '-c:v','libx264','-pix_fmt','yuv420p', out
  ]);
  if (r.status !== 0) throw new Error('Failed to synth ' + name + ': ' + r.stderr.toString());
  return out;
}

async function getDims(file) {
  const { ffprobe } = getBinaries();
  const r = spawnSync(ffprobe, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json', file]);
  const j = JSON.parse(r.stdout.toString());
  return { w: j.streams[0].width, h: j.streams[0].height };
}

(async () => {
  await fsp.rm(OUT, { recursive: true, force: true });

  console.log('Synthesizing test clips...');
  const landscape = await makeClip('land_4k.mp4', 3840, 2160);
  const portrait  = await makeClip('port_4k.mp4', 2160, 3840);
  const square    = await makeClip('square_4k.mp4', 2160, 2160);
  const small     = await makeClip('small_720.mp4', 1280, 720);
  console.log('Synth complete.');

  const cases = [
    { src: landscape, expect: { w: 1920, h: 1080 }, label: 'landscape 4K → 1920x1080' },
    { src: portrait,  expect: { w: 1080, h: 1920 }, label: 'portrait 4K → 1080x1920' },
    { src: square,    expect: { w: 1080, h: 1080 }, label: 'square 4K → 1080x1080' },
    { src: small,     expect: { w: 1280, h: 720  }, label: 'small (short edge <1080) NOT upscaled' }
  ];

  for (const c of cases) {
    const dest = path.join(OUT, '_dst_' + path.basename(c.src, '.mp4'));
    await fsp.mkdir(dest, { recursive: true });
    const r = await runBatch({ src: c.src, dest, tier: 'aggressive' }, () => false, () => {});
    if (r.processed !== 1) { check(false, c.label + ' [encode failed]'); continue; }
    const outFile = fs.readdirSync(r.runDir).find(f => f.endsWith('.mp4'));
    const d = await getDims(path.join(r.runDir, outFile));
    console.log('  ', c.label, '→ actual', d.w + 'x' + d.h);
    check(d.w === c.expect.w && d.h === c.expect.h, c.label);
  }

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log('FAILED:', l); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
