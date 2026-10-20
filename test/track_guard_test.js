/* 3.3.0 Item 1e — post-encode audio track guard, and dropped-track reporting.
   Plain node against the REAL runBatch with a child_process.spawn spy
   installed BEFORE pipeline.js is required (same harness as
   output_guard_test.js): ffprobe answers with the streams we choose per path,
   and an encode is a scripted child that writes its output and exits 0.

   MISSING   source 2 audio, output 1, exit 0 → file FAILS, `TRACKS <src>
             (source 2 audio, output 1)` then FAIL logged, no final file.
   MATCH     source 2 audio, output 2 → OK.
   DROPPED   source has an audio track the bundled ffmpeg cannot decode →
             not mapped, `DROPPED-AUDIO <src> track 2 (unknown)` logged, NOTE
             on the file-done event, file OK with 1 output track.
   SHORT     the duration guard still runs first.

   FAIL-ON-OLD (3.2.2): nothing compared output streams to the source, so the
   1-of-2 output was accepted (the audit bug), and nothing reported a track
   that could not be kept.
   Run: node test/track_guard_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const cp = require('child_process');
let fake = null;
cp.spawn = function (cmd, args) {
  const F = fake;
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  let closed = false;
  const close = (code) => {
    if (closed) return; closed = true;
    c.emit('exit', code, null);
    setTimeout(() => { c.stdout.end(); c.stderr.end(); c.emit('close', code, null); }, 10);
  };
  c.kill = () => { close(255); return true; };
  const file = args[args.length - 1];
  if (/ffprobe$/.test(cmd)) {
    const frames = args.some((a) => String(a).startsWith('frame='));
    const isOut = /\.tmp(_\d+)?\.mp4$/.test(file);
    const video = { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', duration: String(isOut ? F.outDur : 20) };
    const audio = (isOut ? F.outAudio : F.srcAudio).map((a, k) => ({ index: k + 1, codec_type: 'audio', channels: 2, ...a }));
    setTimeout(() => {
      c.stdout.write(JSON.stringify(frames ? { frames: [{}] } : { streams: [video, ...audio], format: { duration: '20.0', size: '100' } }));
      close(0);
    }, 5);
    return c;
  }
  if (args.includes('-version')) { setTimeout(() => { c.stdout.write('ffmpeg version fake\n'); close(0); }, 5); return c; }
  F.encodeArgs.push(args);
  fs.writeFileSync(file, 'encoded');
  setTimeout(() => { c.stderr.write('frame=1 fps=30 time=00:00:20.00 speed=1x\r'); close(0); }, 30);
  return c;
};

const ROOT = path.join(__dirname, '..');
const { runBatch, ffmpegStatus, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-trackguard-')));
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };

async function encodeOne(label, { srcAudio, outAudio, outDur = 20 }) {
  const src = path.join(SB, label, 'Card'), dest = path.join(SB, label, 'Out');
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'clip.mov'), Buffer.alloc(4096, 1));
  fake = { srcAudio, outAudio, outDur, encodeArgs: [] };
  const events = [];
  const res = await runBatch({ src, dest, tier: 'regular', kind: 'folder' }, {}, (p) => events.push(p));
  const files = walk(dest);
  const logPath = files.find((f) => f.endsWith('compress.log'));
  return {
    res, args: fake.encodeArgs,
    done: events.find((p) => p.type === 'file-done'),
    log: logPath ? fs.readFileSync(logPath, 'utf8') : '',
    outputs: files.filter((f) => f.endsWith('.mp4')).map((f) => path.basename(f))
  };
}
const AAC = { codec_name: 'aac', channel_layout: 'stereo' };

(async () => {
  if (!ffmpegStatus(getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); process.exit(0); }
  try {
    {
      const r = await encodeOne('missing', { srcAudio: [AAC, AAC], outAudio: [AAC] });
      check(r.done && r.done.outcome === 'fail', `MISSING: file fails when an audio track is missing (outcome ${r.done && r.done.outcome})`);
      check(r.done && r.done.reason === 'audio tracks missing from output', `MISSING: reason "audio tracks missing from output" (got ${r.done && r.done.reason})`);
      check(/^TRACKS .*clip\.mov \(source 2 audio, output 1\)\nFAIL .*clip\.mov/m.test(r.log), 'MISSING: log has `TRACKS <src> (source 2 audio, output 1)` then FAIL');
      check(!r.outputs.includes('clip.mp4') && !r.outputs.some((o) => o.includes('.tmp')), `MISSING: no final file, no temp left ([${r.outputs}])`);
    }
    {
      const r = await encodeOne('match', { srcAudio: [AAC, AAC], outAudio: [AAC, AAC] });
      check(r.done && r.done.outcome === 'ok' && r.outputs.includes('clip.mp4') && !/TRACKS/.test(r.log), `MATCH: 2 in, 2 out → OK (outcome ${r.done && r.done.outcome})`);
      const a = (r.args[0] || []).join(' ');
      check(/-map 0:0 -map 0:1 -c:a:0 copy -map 0:2 -c:a:1 copy/.test(a), `MATCH: both tracks mapped and copied (${a})`);
    }
    {
      const r = await encodeOne('dropped', { srcAudio: [AAC, { codec_name: 'unknown' }], outAudio: [AAC] });
      check(r.done && r.done.outcome === 'ok', `DROPPED: an undecodable track never fails the file (outcome ${r.done && r.done.outcome})`);
      check(/^DROPPED-AUDIO .*clip\.mov track 2 \(unknown\)$/m.test(r.log), 'DROPPED: log has `DROPPED-AUDIO <src> track 2 (unknown)`');
      check(r.done && Array.isArray(r.done.notes) && r.done.notes.some((n) => /Audio track 2/.test(n)), `DROPPED: file-done carries a NOTE for the row (${r.done && JSON.stringify(r.done.notes)})`);
      const a = (r.args[0] || []).join(' ');
      check(/-map 0:1 /.test(a) && !/-map 0:2/.test(a), `DROPPED: the undecodable track is not mapped (${a})`);
    }
    {
      const r = await encodeOne('short', { srcAudio: [AAC, AAC], outAudio: [AAC], outDur: 10 });
      check(r.done && r.done.reason === 'output shorter than source' && /^SHORT /m.test(r.log) && !/^TRACKS /m.test(r.log),
        `SHORT: the duration guard still fires first (reason ${r.done && r.done.reason})`);
    }
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[track-guard] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
