/* 3.3.0 Item 1 — every audio track, timecode, MJPEG and cover-art stream pick.
   Real bundled ffmpeg, real runBatch, synthetic sources built here. Each
   source is encoded as a one-file folder batch and the OUTPUT is ffprobed.

   TWO-AAC     1 video + 2 AAC (stereo, mono)  → 2 audio tracks, both copied, 2 ch + 1 ch
   PCM-MONO×2  1 video + 2 mono PCM s24le      → 2 AAC tracks, 1 ch each (never merged)
   PCM+SUB     PCM stereo + a subtitle track   → 1 AAC stereo, no subtitle stream
   AC3-5.1     5.1 AC-3                        → copied, 6 ch 5.1
   MJPEG       MJPEG-coded video, no cover art → encoded (was ignored as non-video)
   TC-MOV      MOV with timecode 01:00:00:00   → output tagged 01:00:00:00 + tmcd track
   TC-OTHER    timecode only on a non-video stream (Sony keeps it on rtmd)
                                               → carried via -timecode; TIMECODE log line
   COVER-FIRST cover-art attached_pic (larger) before the real video → the real video is encoded
   Both tiers on TWO-AAC.

   FAIL-ON-OLD (3.2.2): no -map, so ffmpeg's default selection kept ONE audio
   track; pickVideoStream rejected codec "mjpeg"; timecode not on the video
   stream was lost; the default video pick took the larger cover art.
   Run: node test/audio_tracks_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'src/encoder/pipeline'));
const { ffmpeg: FF } = P.getBinaries();

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

if (!P.ffmpegStatus(P.getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); console.log('\nPASS: 0 FAIL: 0'); process.exit(0); }

const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-audiotracks-')));
const V = ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=2'];
const A = (f, lay) => ['-f', 'lavfi', '-i', `sine=f=${f}:d=2,aformat=channel_layouts=${lay}`];
function ff(args) {
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixture ffmpeg failed: ' + r.stderr);
}

/* Encode one source as a single-file folder batch; return output probe + log. */
async function encode(label, srcFile, tier = 'regular') {
  const src = path.join(SB, label, 'Card'), dest = path.join(SB, label, 'Out');
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
  const clip = path.join(src, path.basename(srcFile));
  fs.renameSync(srcFile, clip);
  const events = [];
  const res = await P.runBatch({ src, dest, tier, kind: 'folder' }, {}, (e) => events.push(e));
  const runDir = res.runDir;
  const log = runDir && fs.existsSync(path.join(runDir, 'compress.log')) ? fs.readFileSync(path.join(runDir, 'compress.log'), 'utf8') : '';
  const out = runDir ? fs.readdirSync(runDir, { recursive: true }).filter((f) => f.endsWith('.mp4') && !f.includes('.tmp')).map((f) => path.join(runDir, f))[0] : null;
  const probe = out ? await P.ffprobeJson(out) : null;
  const streams = (probe && probe.streams) || [];
  return {
    res, log, out, probe, events,
    video: streams.filter((s) => s.codec_type === 'video'),
    audio: streams.filter((s) => s.codec_type === 'audio'),
    subs: streams.filter((s) => s.codec_type === 'subtitle'),
    data: streams.filter((s) => s.codec_type === 'data'),
    done: events.find((e) => e.type === 'file-done')
  };
}
const desc = (a) => a.map((s) => `${s.codec_name}/${s.channels}ch/${s.channel_layout}`).join(', ');

(async () => {
  try {
    // ── unit: the per-track codec rule ──
    try {
      const { keep, dropped } = P.planAudio([
        { codec_name: 'aac', channels: 2, channel_layout: 'stereo' },
        { codec_name: 'alac', channels: 2 }, { codec_name: 'ac3', channels: 6, channel_layout: '5.1' },
        { codec_name: 'eac3', channels: 6 }, { codec_name: 'pcm_s24le', channels: 1, channel_layout: 'mono' },
        { codec_name: 'opus', channels: 2, channel_layout: 'stereo' }, { codec_name: 'pcm_s16le', channels: 8, channel_layout: '7.1' },
        { codec_name: 'flac', channels: 3, channel_layout: '2.1' }, { codec_name: 'unknown', channels: 2 }
      ]);
      check(JSON.stringify(keep.map((k) => k.encoder)) === JSON.stringify(['copy', 'copy', 'copy', 'copy', 'aac_at', 'aac_at', 'aac', 'aac']),
        `rule: AAC/ALAC/AC-3/E-AC-3 copied; others AAC; aac_at only where it keeps the layout (7.1, 2.1 → built-in aac) (got ${keep.map((k) => k.encoder)})`);
      check(dropped.length === 1 && dropped[0].track === 9 && dropped[0].codec === 'unknown', 'rule: an undecodable track is dropped as track 9, never fatal');
      const args = P.streamArgs({ index: 0 }, [{ index: 1, codec_name: 'aac', channels: 2 }, { index: 2, codec_name: 'pcm_s24le', channels: 1, channel_layout: 'mono' }], '01:00:00:00').join(' ');
      check(args === '-map 0:0 -map 0:1 -c:a:0 copy -map 0:2 -c:a:1 aac_at -b:a:1 320k -timecode 01:00:00:00', `stream args shape (${args})`);
    } catch (e) { check(false, 'unit: per-track rule threw: ' + e.message); }

    // ── TWO-AAC, both tiers ──
    for (const tier of ['regular', 'preserve']) {
      const f = path.join(SB, `two_aac_${tier}.mov`);
      ff([...V, ...A(440, 'stereo'), ...A(880, 'mono'), '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'aac', '-t', '2', f]);
      const r = await encode(`two_aac_${tier}`, f, tier);
      check(r.done && r.done.outcome === 'ok', `TWO-AAC ${tier}: encodes OK (${r.done && r.done.outcome})`);
      check(r.audio.length === 2, `TWO-AAC ${tier}: 2 audio tracks out (got ${r.audio.length}: ${desc(r.audio)})`);
      check(r.audio.every((s) => s.codec_name === 'aac') && r.audio[0] && r.audio[0].channels === 2 && r.audio[1] && r.audio[1].channels === 1,
        `TWO-AAC ${tier}: AAC stereo then AAC mono, source order (${desc(r.audio)})`);
    }
    // ── PCM-MONO×2 ──
    {
      const f = path.join(SB, 'pcm_mono2.mov');
      ff([...V, ...A(440, 'mono'), ...A(660, 'mono'), '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'pcm_s24le', '-t', '2', f]);
      const r = await encode('pcm_mono2', f);
      check(r.audio.length === 2 && r.audio.every((s) => s.codec_name === 'aac' && s.channels === 1 && s.channel_layout === 'mono'),
        `PCM-MONO×2: two AAC mono tracks, not merged (got ${desc(r.audio)})`);
      check(r.audio.every((s) => Number(s.bit_rate) > 200000), `PCM-MONO×2: transcoded at high bitrate (${r.audio.map((s) => s.bit_rate)})`);
    }
    // ── PCM+SUB ──
    {
      const srt = path.join(SB, 'sub.srt');
      fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,500\nhello\n');
      const f = path.join(SB, 'pcm_sub.mov');
      ff([...V, ...A(440, 'stereo'), '-i', srt, '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'pcm_s16le', '-c:s', 'mov_text', '-t', '2', f]);
      const r = await encode('pcm_sub', f);
      check(r.done && r.done.outcome === 'ok', `PCM+SUB: encodes OK (${r.done && r.done.outcome})`);
      check(r.audio.length === 1 && r.audio[0].codec_name === 'aac' && r.audio[0].channels === 2, `PCM+SUB: one AAC stereo (${desc(r.audio)})`);
      check(r.subs.length === 0, `PCM+SUB: no subtitle stream in the output (got ${r.subs.length})`);
    }
    // ── AC3-5.1 ──
    {
      const f = path.join(SB, 'ac3_51.mov');
      ff([...V, ...A(440, '5.1'), '-map', '0', '-map', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'ac3', '-t', '2', f]);
      const srcLayout = (await P.ffprobeJson(f)).streams.find((s) => s.codec_type === 'audio').channel_layout;   // ac3 writes 5.1(side)
      const r = await encode('ac3_51', f);
      check(r.audio.length === 1 && r.audio[0].codec_name === 'ac3' && r.audio[0].channels === 6 && r.audio[0].channel_layout === srcLayout,
        `AC3-5.1: AC-3 copied, 6 ch, layout ${srcLayout} kept (${desc(r.audio)})`);
    }
    // ── MJPEG video ──
    {
      const f = path.join(SB, 'mjpeg.avi');
      ff([...V, ...A(440, 'stereo'), '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-q:v', '3', '-c:a', 'pcm_s16le', '-t', '2', f]);
      const r = await encode('mjpeg', f);
      check(r.res.totalFiles === 1 && r.done && r.done.outcome === 'ok', `MJPEG: picked as video and encoded (totalFiles ${r.res.totalFiles}, outcome ${r.done && r.done.outcome})`);
      check(r.video.length === 1 && r.video[0].codec_name === 'hevc', `MJPEG: output is HEVC (${r.video.map((s) => s.codec_name)})`);
    }
    // ── TC-MOV ──
    {
      const f = path.join(SB, 'tc.mov');
      ff([...V, ...A(440, 'stereo'), '-map', '0', '-map', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'pcm_s16le', '-timecode', '01:00:00:00', '-t', '2', f]);
      const r = await encode('tc_mov', f);
      const tag = r.video[0] && r.video[0].tags && r.video[0].tags.timecode;
      check(tag === '01:00:00:00', `TC-MOV: output video timecode 01:00:00:00 (got ${tag})`);
      check(r.data.some((s) => s.codec_tag_string === 'tmcd'), `TC-MOV: output has a tmcd track (${r.data.map((s) => s.codec_tag_string)})`);
      check(/^TIMECODE .*tc\.mov 01:00:00:00$/m.test(r.log), 'TC-MOV: log has `TIMECODE <src> 01:00:00:00`');
    }
    // ── TC-OTHER: timecode only on a non-video stream ──
    {
      const f = path.join(SB, 'tc_other.mkv');
      ff([...V, ...A(440, 'stereo'), '-map', '0', '-map', '1', '-c:v', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'flac',
        '-metadata:s:a:0', 'timecode=10:14:17:14', '-t', '2', f]);
      const r = await encode('tc_other', f);
      const tag = r.video[0] && r.video[0].tags && r.video[0].tags.timecode;
      check(tag === '10:14:17:14' && r.data.some((s) => s.codec_tag_string === 'tmcd'), `TC-OTHER: timecode from a non-video stream carried + tmcd track (got ${tag})`);
    }
    // ── COVER-FIRST: a larger cover image precedes the real video ──
    {
      const cover = path.join(SB, 'cover.png');
      ff(['-f', 'lavfi', '-i', 'color=c=red:s=1280x720', '-frames:v', '1', cover]);
      const f = path.join(SB, 'cover_first.mp4');
      ff(['-i', cover, ...V, ...A(440, 'stereo'), '-map', '0', '-map', '1', '-map', '2', '-c:v:0', 'png', '-disposition:v:0', 'attached_pic',
        '-c:v:1', 'libx265', '-x265-params', 'log-level=none', '-c:a', 'aac', '-t', '2', f]);
      const r = await encode('cover_first', f);
      check(r.done && r.done.outcome === 'ok', `COVER-FIRST: encodes OK (${r.done && r.done.outcome} ${r.done && r.done.reason || ''})`);
      check(r.video.length === 1 && r.video[0].width === 320 && r.video[0].height === 240,
        `COVER-FIRST: the real 320×240 video was encoded, not the 1280×720 cover (${r.video.map((s) => s.width + 'x' + s.height)})`);
    }
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[audio-tracks] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
