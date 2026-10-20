// Color-carry regression test (v2.2.6) — faithful pass-through of DECLARED color.
//
// ffmpeg 8 encoders take color from FRAME metadata; sources declaring color
// only in the container (QuickTime colr atom — the 2026 graded .mov shape)
// came out color_transfer=unknown. The carry stamps container-declared values
// onto untagged frames via setparams (metadata-only). MINIMAL INTERVENTION is
// load-bearing and guarded here:
//   1. fully-tagged frames  → NO -vf, args byte-identical, tags preserved
//   2. colr-only (fail-on-old) → stamped, output declares the color
//   3. stream-vs-frame mismatch → frames win, never overwritten
//   4. untagged everywhere → stays untagged, never invent a tag
//   5. PQ colr-only carries (HDR transfer)
//   6. HDR mastering/CLL side data → detected, logged, surfaced in events+result
// Real bundled ffmpeg + real runBatch throughout.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const {
  getBinaries, runCmd, runBatch, buildArgs, buildFallbackArgs,
  resolveColorStamp, detectDroppedHdrMeta, ffprobeFrameColor
} = require('../src/encoder/pipeline');
const { flattenRunDir } = require('../src/encoder/flatten');

const PASS = [], FAIL = [];
function check(cond, label) { (cond ? PASS : FAIL).push(label); console.log((cond ? 'PASS' : 'FAIL') + ': ' + label); }
function header(t) { console.log('\n==== ' + t + ' ===='); }

(async () => {
  const { ffmpeg, ffprobe } = getBinaries();
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-carry-'));
  const mk = async (d) => { const p = path.join(sandbox, d); await fsp.mkdir(p, { recursive: true }); return p; };

  const probeStream = async (f) => {
    const r = await runCmd(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range',
      '-print_format', 'json', f], { stallTimeoutMs: 15000 });
    return JSON.parse(r.stdout).streams[0] || {};
  };
  const gen = async (out, vf) => {
    const a = ['-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1'];
    if (vf) a.push('-vf', vf);
    // h264_videotoolbox: the bundled ffmpeg has no libx264 (native + libx265 + VideoToolbox only).
    a.push('-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', '-an', out);
    return (await runCmd(ffmpeg, a, { stallTimeoutMs: 30000 })).code === 0;
  };
  // colr-only shape: VUI carries primaries/matrix but transfer EXPLICITLY
  // unspecified; a stream-copy remux overrides codecpar → container colr
  // declares the transfer. Mirrors the real 2026 graded .mov exactly.
  const remuxColr = async (src, out, trc) => (await runCmd(ffmpeg,
    ['-y', '-nostdin', '-v', 'error', '-i', src, '-c', 'copy', '-color_trc:v', trc, out],
    { stallTimeoutMs: 30000 })).code === 0;
  const runOne = async (srcDir, events) => {
    const dest = await mk('dest_' + path.basename(srcDir));
    const res = await runBatch({ src: srcDir, dest, tier: 'regular' }, () => false,
      events ? ((e) => events.push(e)) : null);
    const log = res.logPath ? fs.readFileSync(res.logPath, 'utf8') : '';
    await flattenRunDir(res.runDir);
    return { res, log };
  };

  // ── 1. MANDATORY GUARD: fully-tagged source → NO -vf, byte-identical args.
  header('1: fully tagged frames → no -vf injected, args byte-identical');
  const d1 = await mk('src1');
  await gen(path.join(d1, 'tagged.mov'), 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  const fc1 = await ffprobeFrameColor(path.join(d1, 'tagged.mov'));
  const vs1 = await probeStream(path.join(d1, 'tagged.mov'));
  check(resolveColorStamp(fc1, vs1) === null, 'resolveColorStamp returns null for fully-tagged source');
  const argsStamp = buildArgs({ input: 'i.mov', tmpOut: 'o.mp4', tier: 'regular', videoStream: vs1, audioStream: null, colorStamp: resolveColorStamp(fc1, vs1) });
  const argsBare = buildArgs({ input: 'i.mov', tmpOut: 'o.mp4', tier: 'regular', videoStream: vs1, audioStream: null });
  check(JSON.stringify(argsStamp) === JSON.stringify(argsBare), 'args BYTE-IDENTICAL to no-carry construction');
  check(!argsStamp.includes('-vf'), 'no -vf present');
  const r1 = await runOne(d1);
  check(r1.res.processed === 1 && !/COLOR-STAMP/.test(r1.log), 'runBatch: encoded with NO stamp line in log');
  const o1 = await probeStream(path.join(r1.res.runDir, 'tagged.mp4'));
  check(o1.color_transfer === 'bt709', `tags still preserved (got ${o1.color_transfer})`);

  // ── 2. colr-only — the 2026 shape. FAIL-ON-OLD: pre-carry output was unknown.
  header('2: colr-only source → stamped, output declares the color (fail-on-old)');
  const d2 = await mk('src2');
  const base2 = path.join(sandbox, 'base2.mov');
  await gen(base2, 'setparams=color_primaries=bt709:colorspace=bt709:range=tv');
  await remuxColr(base2, path.join(d2, 'colronly.mov'), 'gamma22');
  const fc2 = await ffprobeFrameColor(path.join(d2, 'colronly.mov'));
  const vs2 = await probeStream(path.join(d2, 'colronly.mov'));
  // ffprobe JSON omits a field that is unknown — undefined and 'unknown' are the same state.
  check((fc2.color_transfer === 'unknown' || fc2.color_transfer === undefined) && vs2.color_transfer === 'bt470m',
    `source shape matches 2026 footage: frame=unknown stream=bt470m (got f=${fc2.color_transfer} s=${vs2.color_transfer})`);
  const stamp2 = resolveColorStamp(fc2, vs2);
  check(stamp2 && stamp2.color_trc === 'bt470m' && !stamp2.color_primaries,
    'stamp = ONLY the missing field (trc), tagged fields untouched');
  const r2 = await runOne(d2);
  check(r2.res.processed === 1 && /COLOR-STAMP .*color_trc=bt470m/.test(r2.log), 'stamp applied + logged');
  const o2 = await probeStream(path.join(r2.res.runDir, 'colronly.mp4'));
  check(o2.color_transfer === 'bt470m', `output DECLARES bt470m (old code: unknown) (got ${o2.color_transfer})`);

  // ── 3. mismatch: frames say bt709, container colr says gamma22 → frames win.
  header('3: stream-vs-frame mismatch → frames win, never overwritten');
  const d3 = await mk('src3');
  const base3 = path.join(sandbox, 'base3.mov');
  await gen(base3, 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  await remuxColr(base3, path.join(d3, 'mismatch.mov'), 'gamma22');
  const fc3 = await ffprobeFrameColor(path.join(d3, 'mismatch.mov'));
  check(fc3.color_transfer === 'bt709', 'frames carry bt709 (bitstream truth)');
  check(resolveColorStamp(fc3, await probeStream(path.join(d3, 'mismatch.mov'))) === null,
    'no stamp on mismatch — bitstream-declared color never overwritten');
  const r3 = await runOne(d3);
  const o3 = await probeStream(path.join(r3.res.runDir, 'mismatch.mp4'));
  check(o3.color_transfer === 'bt709', `output keeps the FRAME color (got ${o3.color_transfer})`);

  // ── 4. untagged everywhere → stays untagged. Never invent color.
  header('4: untagged source → untagged output');
  const d4 = await mk('src4');
  await gen(path.join(d4, 'untagged.mov'), null);
  const fc4 = await ffprobeFrameColor(path.join(d4, 'untagged.mov'));
  const vs4 = await probeStream(path.join(d4, 'untagged.mov'));
  check(resolveColorStamp(fc4, vs4) === null, 'no stamp for untagged source');
  const r4 = await runOne(d4);
  check(r4.res.processed === 1 && !/COLOR-STAMP/.test(r4.log), 'encoded with no stamp');
  const o4 = await probeStream(path.join(r4.res.runDir, 'untagged.mp4'));
  check(!o4.color_transfer || o4.color_transfer === 'unknown', `output stays untagged (got ${o4.color_transfer})`);

  // ── 5. PQ declared colr-only → HDR transfer carries.
  header('5: PQ colr-only → smpte2084 carried');
  const d5 = await mk('src5');
  const base5 = path.join(sandbox, 'base5.mov');
  await gen(base5, 'setparams=color_primaries=bt2020:colorspace=bt2020nc:range=tv');
  await remuxColr(base5, path.join(d5, 'pq.mov'), 'smpte2084');
  const r5 = await runOne(d5);
  const o5 = await probeStream(path.join(r5.res.runDir, 'pq.mp4'));
  check(o5.color_transfer === 'smpte2084', `PQ transfer carried (got ${o5.color_transfer})`);

  // ── 6. HDR10 mastering/CLL side data is CARRIED by both encoders (3.3.0,
  //    DIAGNOSTIC 1.6), so it is never reported as dropped. Dolby Vision is.
  header('6: HDR10 not reported as dropped; Dolby Vision reported per encoder');
  const d6 = await mk('src6');
  const gen6 = await runCmd(ffmpeg, ['-y', '-nostdin', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1',
    '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
    '-c:v', 'libx265', '-crf', '30', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400',
    '-an', path.join(d6, 'hdr10.mov')], { stallTimeoutMs: 60000 });
  check(gen6.code === 0, 'synthesized HDR10 clip with mastering display + CLL SEI');
  const fc6 = await ffprobeFrameColor(path.join(d6, 'hdr10.mov'));
  check(/Mastering display/.test(JSON.stringify(fc6)), 'source frames carry mastering display side data');
  const det = detectDroppedHdrMeta(null, fc6, 'libx265');
  check(det.length === 0, `HDR10 mastering + CLL are not reported as dropped (got: ${det.join(', ') || 'nothing'})`);
  const ev6 = [];
  const r6 = await runOne(d6, ev6);
  check(!/HDR-METADATA/.test(r6.log), 'no HDR-METADATA line for an HDR10 source');
  check(r6.res.hdrMetaDropped === 0, `result.hdrMetaDropped === 0 (got ${r6.res.hdrMetaDropped})`);
  const doneEv = ev6.find((e) => e.type === 'file-done' && e.outcome === 'ok');
  check(doneEv && doneEv.hdrMeta === undefined, 'file-done carries no hdrMeta (no chip)');
  const fo6 = await ffprobeFrameColor(path.join(r6.res.runDir, 'hdr10.mp4'));
  check(/Mastering display/.test(JSON.stringify(fo6)) && /Content light/.test(JSON.stringify(fo6)),
    'the output really carries mastering display + content light');
  check(r6.res.processed === 1, 'HDR file encodes fine');
  // Dolby Vision (probe shape of the iPhone 12 clip, DIAGNOSTIC 1.6).
  const dvStreams = [{ codec_type: 'video', side_data_list: [{ side_data_type: 'DOVI configuration record' }] }];
  const dvFrame = { side_data_list: [{ side_data_type: 'Dolby Vision RPU Data' }, { side_data_type: 'Dolby Vision Metadata' }] };
  check(JSON.stringify(detectDroppedHdrMeta(dvStreams, dvFrame, 'hevc_videotoolbox')) === JSON.stringify(['Dolby Vision configuration record']),
    'Dolby Vision, Make It Fast: configuration record only');
  check(JSON.stringify(detectDroppedHdrMeta(dvStreams, dvFrame, 'libx265')) === JSON.stringify(['Dolby Vision configuration record', 'Dolby Vision per-frame data']),
    'Dolby Vision, Slow But Better / fallback: configuration record + per-frame data');

  // ── invariants across all runs
  header('invariants');
  for (const r of [r1, r2, r3, r4, r5, r6]) {
    const top = fs.readdirSync(r.res.runDir, { withFileTypes: true });
    if (!top.every((e) => e.isFile())) { check(false, `flat violated in ${r.res.runDir}`); }
  }
  check(true, 'all run dirs flat after flatten');

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
