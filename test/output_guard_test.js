/* v3.2.2 — short-but-playable outputs. Plain node against the REAL pipeline
   (runBatch / scanFolder) with a child_process.spawn spy installed BEFORE
   pipeline.js is required: ffprobe answers with per-path video-stream
   durations we choose, and an encode is a scripted child that writes its
   output and exits 0. Source files are real files on disk.

   SHORT      exit 0 but the output's VIDEO stream is half the source (format
              duration says full length, so a format-duration check would miss
              it) → file fails, `SHORT …` then `FAIL …` logged, no final file.
   TOLERANCE  0.5s short of 20s (under max(1s, 2%)) → still OK.
   WARN       exit 0, full length, decoder error on stderr → OK + `WARN …` line.
   CHANGING   source keeps growing through the 2s settle window → fails before
              any encoder spawns, `SOURCE_CHANGING …` logged.
   STABLE     source changed once after scan, then stable → encodes normally.
   SCANNER    a Compressed_<ts> run folder (with a growing .tmp.mp4) inside the
              source tree contributes nothing; a staged file-list batch is
              never filtered (explicit picks are honoured).

   FAIL-ON-OLD: success was `exit 0 && temp exists` with no duration check,
   stderr was discarded on success, nothing compared the source to its scan
   snapshot, and walkAll walked into Compressed_* folders.
   Run: node test/output_guard_test.js */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

// ── spawn spy — MUST be installed before pipeline.js is required ──
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
    const d = F.dur(file);
    setTimeout(() => {
      c.stdout.write(JSON.stringify(frames ? { frames: [{}] } : {
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', duration: String(d) }],
        format: { duration: '20.0', size: '100' } }));   // format always "full length"
      close(0);
    }, 5);
    return c;
  }
  if (args.includes('-version')) { setTimeout(() => { c.stdout.write('ffmpeg version fake\n'); close(0); }, 5); return c; }
  F.encodes++;
  fs.writeFileSync(file, 'encoded');
  let n = 0;
  const t = setInterval(() => {
    n++;
    c.stderr.write(`frame=${n} fps=30 time=00:00:0${n}.00 speed=1x\r`);
    if (n === 3 && F.stderrErr) c.stderr.write(F.stderrErr + '\n');
    if (n >= 6) { clearInterval(t); close(0); }
  }, 30);
  return c;
};

const ROOT = path.join(__dirname, '..');
const { runBatch, scanFolder, ffmpegStatus, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-outguard-')));

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

/* One single-file folder batch through the real runBatch. */
async function encodeOne(label, { dur, stderrErr, onStart } = {}) {
  const src = path.join(SB, label, 'Card');
  const dest = path.join(SB, label, 'Out');
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dest, { recursive: true });
  const clip = path.join(src, 'clip.mov');
  fs.writeFileSync(clip, Buffer.alloc(4096, 1));
  fake = { encodes: 0, stderrErr, dur: dur || (() => 20) };
  const events = [];
  const res = await runBatch({ src, dest, tier: 'regular', kind: 'folder' }, {}, (p) => {
    events.push(p);
    if (p.type === 'file-start' && onStart) onStart(clip);
  });
  const files = walk(dest);
  const logPath = files.find((f) => f.endsWith('compress.log'));
  return {
    clip, res, encodes: fake.encodes,
    done: events.find((p) => p.type === 'file-done'),
    log: logPath ? fs.readFileSync(logPath, 'utf8') : '',
    outputs: files.filter((f) => f.endsWith('.mp4')).map((f) => path.basename(f))
  };
}

(async () => {
  if (!ffmpegStatus(getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); process.exit(0); }
  try {
    // ── SHORT: the output's video stream is half the source's ──
    {
      const r = await encodeOne('short', { dur: (f) => (/\.tmp\.mp4$/.test(f) ? 10 : 20) });
      check(r.done && r.done.outcome === 'fail', `SHORT: file fails (outcome ${r.done && r.done.outcome})`);
      check(r.done && r.done.reason === 'output shorter than source', `SHORT: reason "output shorter than source" (got ${r.done && r.done.reason})`);
      check(/^SHORT .*clip\.mov \(source 20\.00s, output 10\.00s\)\nFAIL .*clip\.mov/m.test(r.log),
        'SHORT: log has `SHORT <src> (source 20.00s, output 10.00s)` followed by the FAIL line');
      check(!r.outputs.includes('clip.mp4') && !r.outputs.some((o) => o.includes('.tmp')),
        `SHORT: no final-name file and no temp left (outputs [${r.outputs}])`);
    }
    // ── TOLERANCE: 0.5s short of 20s is within max(1s, 2%) ──
    {
      const r = await encodeOne('tolerance', { dur: (f) => (/\.tmp\.mp4$/.test(f) ? 19.5 : 20) });
      check(r.done && r.done.outcome === 'ok' && r.outputs.includes('clip.mp4'), `TOLERANCE: 19.5s of 20s is accepted (outcome ${r.done && r.done.outcome})`);
    }
    // ── WARN: decoder errors on an otherwise successful encode ──
    {
      const r = await encodeOne('warn', { stderrErr: '[h264 @ 0x1] Invalid NAL unit size (211371 > 20559).' });
      check(r.done && r.done.outcome === 'ok', `WARN: outcome unchanged by the warning alone (got ${r.done && r.done.outcome})`);
      check(/^WARN .*clip\.mov decoder reported errors: \[h264 @ 0x1\] Invalid NAL unit size/m.test(r.log),
        'WARN: log has `WARN <src> decoder reported errors: <first matching line>`');
    }
    // ── CHANGING: the source keeps growing through the settle window ──
    {
      let grow = null;
      const r = await encodeOne('changing', { onStart: (clip) => {
        fs.appendFileSync(clip, 'more');
        grow = setInterval(() => fs.appendFileSync(clip, 'more'), 300);
      } });
      clearInterval(grow);
      check(r.done && r.done.outcome === 'fail' && r.done.reason === 'file was still being written',
        `CHANGING: file fails with "file was still being written" (got ${r.done && r.done.outcome} / ${r.done && r.done.reason})`);
      check(r.encodes === 0, `CHANGING: ffmpeg never spawned (encodes ${r.encodes})`);
      check(/^SOURCE_CHANGING .*clip\.mov \(size changed between scan and encode\)$/m.test(r.log),
        'CHANGING: log has `SOURCE_CHANGING <src> (size changed between scan and encode)`');
      check(r.res.failed === 1, `CHANGING: counted as a failure (failed=${r.res.failed})`);
    }
    // ── STABLE: changed once after scan, then still → encodes ──
    {
      const r = await encodeOne('stable', { onStart: (clip) => fs.appendFileSync(clip, 'tail') });
      check(r.done && r.done.outcome === 'ok' && r.encodes === 1 && !/SOURCE_CHANGING/.test(r.log),
        `STABLE: settled source encodes normally (outcome ${r.done && r.done.outcome}, encodes ${r.encodes})`);
    }
    // ── SCANNER: our own run folders never re-enter a scan ──
    {
      fake = { encodes: 0, dur: () => 20 };
      const src = path.join(SB, 'scan', 'Card');
      const run = path.join(src, 'Compressed_2026-10-15_0612');
      fs.mkdirSync(path.join(src, 'Trip'), { recursive: true }); fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(src, 'a.mov'), 'x');
      fs.writeFileSync(path.join(src, 'Trip', 'b.mov'), 'x');
      fs.writeFileSync(path.join(run, 'a.mp4'), 'finished output');
      const growing = path.join(run, 'b.tmp.mp4');
      fs.writeFileSync(growing, 'partial');
      fs.writeFileSync(path.join(run, 'compress.log'), 'log');      // not a video: never counted
      fs.writeFileSync(path.join(src, 'Trip', 'c.tmp_2.mp4'), 'x');  // a stray partial outside a run folder
      const g = setInterval(() => fs.appendFileSync(growing, 'more'), 50);
      const s = await scanFolder(src);
      clearInterval(g);
      const found = s.videos.map((v) => path.relative(src, v.file)).sort();
      check(!found.some((f) => f.startsWith('Compressed_')), `SCANNER: zero files from the Compressed_* folder (found [${found}])`);
      check(JSON.stringify(found) === JSON.stringify(['Trip/b.mov', 'a.mov']), `SCANNER: ordinary sources still found (found [${found}])`);
      check(s.skippedOutputs === 3, `SCANNER: skipped output files are counted — 2 in the run folder + 1 stray .tmp_2.mp4 (got ${s.skippedOutputs})`);
      fake = { encodes: 0, dur: () => 20 };
      const sdest = path.join(SB, 'scan', 'SOut'); fs.mkdirSync(sdest);
      await runBatch({ src, dest: sdest, tier: 'regular', kind: 'folder' }, {}, () => {});
      const slog = fs.readFileSync(walk(sdest).find((f) => f.endsWith('compress.log')), 'utf8');
      check(/^SKIPPED_OUTPUTS 3 file\(s\) inside SkinnyVideo output folders$/m.test(slog),
        'SCANNER: compress.log has `SKIPPED_OUTPUTS 3 file(s) inside SkinnyVideo output folders`');
      // An explicit pick is honoured: a staged file-list dir is never filtered.
      const stage = path.join(SB, 'scan', 'Stage');
      fs.mkdirSync(path.join(stage, 'Compressed_2026-10-15_0612'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'Compressed_2026-10-15_0612', 'again.mp4'), 'x');
      const dest = path.join(SB, 'scan', 'Out'); fs.mkdirSync(dest);
      const r = await runBatch({ src: stage, dest, tier: 'regular', kind: 'files' }, {}, () => {});
      check(r.processed === 1, `SCANNER: a picked file inside a Compressed_* folder still encodes in a file-list batch (processed ${r.processed})`);
      const plain = await encodeOne('noskips');
      check(!/SKIPPED_OUTPUTS/.test(plain.log) && (await scanFolder(path.dirname(plain.clip))).skippedOutputs === 0,
        'SCANNER: nothing skipped → count 0 and no SKIPPED_OUTPUTS line');
    }
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[output-guard] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
