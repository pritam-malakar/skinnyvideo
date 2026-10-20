/* 3.3.1 Item 3 — every encode attempt waits on the pause gate.
   REAL src/main/queue-runner.js + REAL src/encoder/pipeline.js; ffmpeg/ffprobe
   are a scripted fake child (spawn spy, as in pause_race_test.js), so no
   VideoToolbox or real encode is needed. Each encode follows fake.plan:
     'opt'  exit 1 with "Error applying encoder options" (colour-tag rejection → retry)
     'fail' exit 1, any other error (→ libx265 fallback)
     'ok'   exit 0 after a few progress ticks
   The pause lands synchronously right after an attempt's child exits (its
   'exit' event — state.child is already cleared), i.e. between two attempts
   of the same file, with no live child to SIGSTOP.

   RETRY     opt → [pause] → retry must not spawn until resume; then runs and the
             file is ok. No signal is sent to any child (nothing was alive to stop).
   FALLBACK  opt, fail → [pause] → libx265 fallback must not spawn until resume.
   PLAIN     fail → [pause] → fallback must not spawn until resume.
   CANCEL    opt → [pause] → cancel: no further spawn, file cancelled, no output.
   STOP      opt → [pause] → stop: the file still finishes (retry runs, batch
             not left "Paused"), the next file never starts.

   FAIL-ON-OLD (3.3.0 / 399c3d2): only the primary attempt awaited the gate; the
   retry and the fallback spawned and completed while paused.
   Run: node test/attempt_pause_gate_test.js */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const cp = require('child_process');
const realSpawn = cp.spawn;
let fake = null;
cp.spawn = function (cmd, args, opts) {
  if (!fake) return realSpawn.call(this, cmd, args, opts);
  const F = fake;
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough();
  let timer = null, closed = false, n = 0;
  const close = (code, after) => {
    if (closed) return; closed = true; clearInterval(timer);
    c.emit('exit', code, null);
    if (after) after();
    setTimeout(() => { c.stdout.end(); c.stderr.end(); c.emit('close', code, null); }, 10);
  };
  c.kill = (sig = 'SIGTERM') => { F.signals.push(sig); if (closed) return false; if (sig === 'SIGSTOP') { clearInterval(timer); timer = null; } else if (sig === 'SIGCONT') { if (!timer) tick(); } else close(255); return true; };
  if (/ffprobe$/.test(cmd)) {
    const frames = args.some((a) => String(a).startsWith('frame='));
    setTimeout(() => {
      c.stdout.write(JSON.stringify(frames ? { frames: [{}] } : {
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p', duration: '2.0' }],
        format: { duration: '2.0', size: '100' } }));
      close(0);
    }, 5);
    return c;
  }
  if (args.includes('-version')) { setTimeout(() => { c.stdout.write('ffmpeg version fake\n'); close(0); }, 5); return c; }
  const out = args[args.length - 1];
  const idx = F.spawns.length;
  const step = F.plan[idx] || 'ok';
  F.spawns.push({ at: Date.now(), args, pausedAtSpawn: F.isPaused() });
  fs.writeFileSync(out, 'partial');
  const hook = () => F.onExit && F.onExit(idx);
  const tick = () => {
    timer = setInterval(() => {
      n++;
      c.stderr.write(`frame=${n} time=00:00:0${Math.min(n, 2)}.00 speed=1x\r`);
      if (n >= 4) {
        if (step === 'ok') { fs.appendFileSync(out, 'done'); close(0, hook); }
        else {
          c.stderr.write(step === 'opt' ? '\n[hevc_videotoolbox @ 0x1] Error applying encoder options: Invalid argument\n' : '\nConversion failed!\n');
          try { fs.unlinkSync(out); } catch {}
          close(1, hook);
        }
      }
    }, 30);
  };
  tick();
  return c;
};

const ROOT = path.join(__dirname, '..');
const { runQueue, releasePauseGate, requestStop } = require(path.join(ROOT, 'src/main/queue-runner'));
const { beginCancel } = require(path.join(ROOT, 'src/main/quit-teardown'));
const { ffmpegStatus, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);

const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, { child: null, paused: false, cancelled: false }); return rtm.get(id); };
let stopFlag = false;
// Pause/resume mirror main.js's handlers (as pause_race_test.js); cancel/stop are the REAL functions.
const doPause = (id) => { const s = rt(id); if (s.paused || s.resolved || stopFlag) return false; s.paused = true; if (s.child) { try { s.child.kill('SIGSTOP'); } catch {} } return true; };
const doResume = (id) => { const s = rt(id); if (!s.paused) return false; s.paused = false; releasePauseGate(s); if (s.child) { try { s.child.kill('SIGCONT'); } catch {} } return true; };
const doCancel = (id) => beginCancel(rt(id), { releasePauseGate });
const resumed = [];
const doStop = () => requestStop(rtm, { setStopFlag: () => { stopFlag = true; }, onResumed: (id) => resumed.push(id) });

const outputs = (d) => { const o = []; const w = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) w(p); else if (/\.mp4$/.test(e.name)) o.push(p); } }; try { w(d); } catch {} return o; };

let seq = 0;
async function scenario(name, { plan, pauseAfter, files = ['f1.mov'], during }) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sv-attemptgate-'));
  const src = path.join(base, 'src'), dest = path.join(base, 'out');
  await fsp.mkdir(src); await fsp.mkdir(dest);
  for (const f of files) await fsp.writeFile(path.join(src, f), 'x');
  const BID = `G${++seq}`;
  stopFlag = false; resumed.length = 0;
  const F = fake = { plan, spawns: [], signals: [], isPaused: () => rt(BID).paused, pausedAt: null };
  F.onExit = (idx) => { if (idx === pauseAfter) { doPause(BID); F.pausedAt = Date.now(); } };
  const evs = [];
  const send = (ch, p) => evs.push({ ch, p });
  const runP = withTimeout(runQueue([{ id: BID, kind: 'folder', src, dest, tier: 'regular', dryRun: false, fileSources: [], skipped: [] }],
    { send, isStopRequested: () => stopFlag, rt }), 8000);
  const t0 = Date.now();
  while (F.pausedAt == null && Date.now() - t0 < 4000) await sleep(20);
  await sleep(800);   // hold the pause well past a whole fake encode (~150 ms)
  const whilePaused = F.spawns.length;
  await during(BID);
  const res = await runP;
  fake = null;
  const log = (() => { const d = fs.readdirSync(dest).find((x) => x.startsWith('Compressed_')); try { return fs.readFileSync(path.join(dest, d, 'compress.log'), 'utf8'); } catch { return ''; } })();
  const done = evs.filter((e) => e.ch === 'progress' && e.p.type === 'file-done').map((e) => e.p);
  const starts = evs.filter((e) => e.ch === 'progress' && e.p.type === 'file-start').map((e) => path.basename(e.p.file));
  const statuses = evs.filter((e) => e.ch === 'batch-status').map((e) => e.p.status);
  const r = { res, F, whilePaused, log, done, starts, statuses, outs: outputs(dest).map((p) => path.basename(p)) };
  await fsp.rm(base, { recursive: true, force: true });
  check(F.pausedAt != null, `${name}: pause landed between attempts (after attempt ${pauseAfter + 1})`);
  check(res !== 'TIMEOUT', `${name}: run settled (${res === 'TIMEOUT' ? 'TIMEOUT' : 'ok'})`);
  return r;
}


(async () => {
  if (!ffmpegStatus(getBinaries()).ok) { console.log('SKIP: bundled ffmpeg missing'); console.log('\nPASS: 0 FAIL: 0'); process.exit(0); }
  try {
    // ── RETRY ──
    let resumeAt = 0;
    let r = await scenario('RETRY', { plan: ['opt', 'ok'], pauseAfter: 0, during: async (id) => { resumeAt = Date.now(); doResume(id); } });
    check(r.whilePaused === 1, `RETRY: no spawn while paused (spawns during pause: ${r.whilePaused})`);
    check(r.F.spawns.length === 2 && r.F.spawns[1].at >= resumeAt && !r.F.spawns[1].pausedAtSpawn, `RETRY: the retry spawned only after resume, unpaused (${r.F.spawns.map((s) => s.at - resumeAt).join(', ')} ms vs resume)`);
    check(r.F.signals.length === 0, `RETRY: no signal sent — nothing alive to stop or continue (${JSON.stringify(r.F.signals)})`);
    check(/PRIMARY-FAIL[\s\S]*RETRY-OK/.test(r.log) && r.done.length === 1 && r.done[0].outcome === 'ok' && r.outs.includes('f1.mp4'), `RETRY: PRIMARY-FAIL then RETRY-OK, file ok (${r.done.map((d) => d.outcome)}, [${r.outs}])`);

    // ── FALLBACK after the retry ──
    r = await scenario('FALLBACK', { plan: ['opt', 'fail', 'ok'], pauseAfter: 1, during: async (id) => { resumeAt = Date.now(); doResume(id); } });
    check(r.whilePaused === 2, `FALLBACK: no fallback spawn while paused (spawns during pause: ${r.whilePaused})`);
    const fb = r.F.spawns[2];
    check(r.F.spawns.length === 3 && fb.at >= resumeAt && fb.args.join(' ').includes('libx265'), `FALLBACK: libx265 fallback spawned only after resume (${r.F.spawns.length} spawns)`);
    check(/RETRY-FAIL/.test(r.log) && r.done.length === 1 && r.done[0].outcome === 'ok-fallback', `FALLBACK: file ok via fallback (${r.done.map((d) => d.outcome)})`);

    // ── PLAIN primary failure → fallback ──
    r = await scenario('PLAIN', { plan: ['fail', 'ok'], pauseAfter: 0, during: async (id) => { resumeAt = Date.now(); doResume(id); } });
    check(r.whilePaused === 1, `PLAIN: no fallback spawn while paused (spawns during pause: ${r.whilePaused})`);
    check(r.F.spawns.length === 2 && r.F.spawns[1].at >= resumeAt && r.F.spawns[1].args.join(' ').includes('libx265'), 'PLAIN: fallback spawned only after resume');

    // ── CANCEL while paused between attempts ──
    r = await scenario('CANCEL', { plan: ['opt', 'ok'], pauseAfter: 0, during: async (id) => { doCancel(id); } });
    check(r.F.spawns.length === 1, `CANCEL: cancel between attempts spawns nothing more (${r.F.spawns.length} spawns)`);
    check(r.done.length === 1 && r.done[0].outcome === 'cancelled' && r.outs.length === 0, `CANCEL: file cancelled, no output (${r.done.map((d) => d.outcome)}, [${r.outs}])`);

    // ── STOP while paused between attempts ──
    r = await scenario('STOP', { plan: ['opt', 'ok', 'ok'], pauseAfter: 0, files: ['f1.mov', 'f2.mov'], during: async () => { doStop(); } });
    check(r.F.spawns.length === 2 && !r.F.spawns[1].pausedAtSpawn, `STOP: current file's retry still runs, unpaused (${r.F.spawns.length} spawns, paused at retry: ${r.F.spawns[1] && r.F.spawns[1].pausedAtSpawn})`);
    check(r.done.length === 1 && r.done[0].outcome === 'ok' && !r.starts.includes('f2.mov'), `STOP: file 1 finished ok, file 2 never started (${r.done.map((d) => d.outcome)}; starts ${r.starts})`);
    check(r.statuses[r.statuses.length - 1] === 'Stopped' && resumed.length === 1, `STOP: batch ends Stopped and was reported running again (statuses ${JSON.stringify(r.statuses)}, resumed ${JSON.stringify(resumed)})`);
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  console.log(`\n[attempt-pause-gate] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
