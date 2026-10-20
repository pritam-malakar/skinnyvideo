#!/usr/bin/env node
/* Print the exact ffmpeg command SkinnyVideo builds for one input + tier, as
   JSON. Probes the input the way runBatch does (same ffprobe, same stream
   pick, same colour stamp) and calls the pipeline's own buildArgs, so the
   benchmark can never drift from the app. Used by scripts/bench.sh.

   Usage: node scripts/print-args.js <input> <regular|better> <output.mp4>
                                     [--quality N | --crf N]
   regular = Make It Fast (VideoToolbox, --quality is its -q:v, capped at 85)
   better  = Slow But Better (libx265, --crf overrides CRF)                  */
const p = require('../src/encoder/pipeline');

const TIER = { regular: 'regular', better: 'preserve' };

async function main(argv) {
  const [input, tierName, output, flag, value] = argv;
  const tier = TIER[tierName];
  if (!input || !tier || !output) throw new Error('usage: print-args.js <input> <regular|better> <output.mp4> [--quality N | --crf N]');
  const settings = { ...p.tierDefaults(tier) };
  if (flag) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${flag} needs a number`);
    if (flag === '--quality' && tier === 'regular') settings.qv = n;
    else if (flag === '--crf' && tier === 'preserve') settings.crf = n;
    else throw new Error(`${flag} does not apply to tier ${tierName} (regular takes --quality, better takes --crf)`);
  }

  const probe = await p.ffprobeJson(input);
  const { videoStream: vs, audioStreams, timecode } = p.streamPlan(probe);
  if (!vs) throw new Error(`no video stream in ${input}`);
  const frameColor = await p.ffprobeFrameColor(input);
  const colorStamp = p.resolveColorStamp(frameColor, vs);
  const argv2 = p.buildArgs({ input, tmpOut: output, tier, settings, videoStream: vs, audioStreams, timecode, colorStamp });

  const { ffmpeg, ffprobe } = p.getBinaries();
  return {
    ffmpeg, ffprobe, tier: tierName, settings, argv: argv2,
    source: {
      bytes: require('fs').statSync(input).size,
      duration: Number(probe.format && probe.format.duration) || 0,   // what the app uses
      codec: vs.codec_name, profile: vs.profile || null,
      width: vs.width, height: vs.height, fps: vs.avg_frame_rate || vs.r_frame_rate,
      pix_fmt: vs.pix_fmt, color_range: vs.color_range || null,
      color_transfer: vs.color_transfer || null, color_primaries: vs.color_primaries || null,
      color_space: vs.color_space || null,
      hdr_metadata_dropped: p.detectDroppedHdrMeta(probe.streams, frameColor)
    }
  };
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
    .catch((e) => { process.stderr.write(`print-args: ${e.message}\n`); process.exit(2); });
}
module.exports = { main };
