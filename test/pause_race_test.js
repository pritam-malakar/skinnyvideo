/* v2.8.1 — pause race fix (stale state.child + no pre-spawn pause gate).
   Drives the REAL src/main/queue-runner.js loop + REAL src/encoder/pipeline.js
   with the bundled ffmpeg (no renderer needed — pure main-side). The pause /
   resume handlers here MIRROR src/main/main.js's updated IPC handlers verbatim
   (set state.paused independent of a live child; clear it without requiring a
   SIGCONT-able child) so the gate + child-lifecycle under test is the shipped
   code path, not a simplified copy.

   DETERMINISM (mirrors the 2.8.0 skiprace harness — hold on an event, don't race
   the clock): the pause is applied SYNCHRONOUSLY inside the send() callback for
   the target file's 'file-start' event. file-start is emitted before the awaited
   ffprobe calls, which are before the pre-spawn gate — so state.paused is set
   before the pipeline reaches the gate, every run, regardless of encode speed.

   TEST A — probe-window pause (fail-then-pass, the regression):
     Two-file folder batch. On the SECOND file's file-start (its encoder has NOT
     spawned; the first file's child already exited) we:
       - snapshot state.child → must be null (DEFECT 1: per-file exit clears it,
         so a pause here never SIGSTOPs a dead pid); on old code it is the first
         file's exited child (non-null).
       - pause. The second encoder must NOT spawn while paused (DEFECT 2 gate);
         on old code it spawns straight through (file-progress/-done arrive).
     Then resume → the second file encodes to completion, and the queue does not
     hang.
   TEST B — mid-encode pause (guard, passes old+new): once the encoder is live,
     pause SIGSTOPs it (progress freezes, no file-done); resume SIGCONTs it and it
     completes. Confirms the existing live-suspend still works.

   Fixture: SKINNYVIDEO_TEST_CLIP(/_LONG) env, else test/fixtures/tiny_clip.mov /
   long_clip.mov. Skips cleanly if the bundled ffmpeg or fixtures are missing. */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { runQueue, releasePauseGate } = require(path.join(ROOT, 'src/main/queue-runner'));
const { ffmpegStatus, getBinaries } = require(path.join(ROOT, 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(40); } return pred(); };
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'TIMEOUT')]);

const TINY = process.env.SKINNYVIDEO_TEST_CLIP || path.join(__dirname, 'fixtures', 'tiny_clip.mov');
const LONG = process.env.SKINNYVIDEO_TEST_CLIP_LONG || path.join(__dirname, 'fixtures', 'long_clip.mov');

// ---- per-batch runtime state, exactly like main.js's runtime Map ----
const rtm = new Map();
const rt = (id) => { if (!rtm.has(id)) rtm.set(id, { child: null, paused: false, cancelled: false }); return rtm.get(id); };
// Pause/resume/cancel MIRROR of src/main/main.js (updated); uses the REAL
// releasePauseGate so the event-gate wake path can't drift from production.
const doPause = (id) => { const s = rt(id); if (s.paused || s.resolved) return false; s.paused = true; if (s.child) { try { s.child.kill('SIGSTOP'); } catch {} } return true; };
const doResume = (id) => { const s = rt(id); if (!s.paused) return false; s.paused = false; releasePauseGate(s); if (s.child) { try { s.child.kill('SIGCONT'); } catch {} } return true; };
const doCancel = (id) => { const s = rt(id); s.cancelled = true; if (s.paused) { if (s.child) { try { s.child.kill('SIGCONT'); } catch {} } s.paused = false; } releasePauseGate(s); if (s.child) { try { s.child.kill('SIGTERM'); } catch {} } };

async function freshDir(d) { await fsp.rm(d, { recursive: true, force: true }); await fsp.mkdir(d, { recursive: true }); return d; }
function folderBatch(id, src, dest) {
  return { id, kind: 'folder', src, dest, tier: 'regular', dryRun: false, fileSources: [], skipped: [] };
}
// Walk DEST for an encoded output (not the source) and confirm it is a real,
// finished video: ffprobe reports a video stream AND a positive duration.
function findOutput(destRoot) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mov|mp4|mkv)$/i.test(e.name)) out.push(p); } };
  try { walk(destRoot); } catch {}
  return out;
}
function ffprobeValid(file) {
  const { ffprobe } = getBinaries();
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return false;
  try { const j = JSON.parse(r.stdout); const hasV = (j.streams || []).some((s) => s.codec_type === 'video'); const dur = Number(j.format && j.format.duration) || 0; return hasV && dur > 0; } catch { return false; }
}

async function testA() {
  const src = await freshDir(path.join(os.tmpdir(), 'skinnyvideo-pause-A-src'));
  const dest = await freshDir(path.join(os.tmpdir(), 'skinnyvideo-pause-A-out'));
  await fsp.copyFile(TINY, path.join(src, 'a_clip.mov'));
  await fsp.copyFile(LONG, path.join(src, 'b_clip.mov'));
  const BID = 'A1';

  const evs = [];
  let fileStarts = 0, f2path = null, childAt2ndStart = 'unset';
  const send = (ch, p) => {
    evs.push({ ch, p });
    if (ch === 'progress' && p.type === 'file-start') {
      fileStarts++;
      if (fileStarts === 2) {           // second file: encoder not yet spawned
        childAt2ndStart = rt(BID).child; // DEFECT 1 snapshot (before pausing)
        f2path = p.file;
        doPause(BID);                    // land the pause in the ffprobe window
      }
    }
  };

  const runP = withTimeout(runQueue([folderBatch(BID, src, dest)], { send, isStopRequested: () => false, rt }), 60000);
  await until(() => f2path !== null, 40000);
  /* Confirm window while paused. Spawn signal is state.child going LIVE (a new
     child, not the snapshot) — deterministic once ffprobe finishes, independent
     of how fast the first -stats line lands. On the fix the gate holds before
     the spawn so state.child stays null; on old code the ungated encoder spawns.
     Progress/-done events are a second, corroborating signal. */
  let spawnObserved = false;
  const wEnd = Date.now() + 2500;
  while (Date.now() < wEnd) {
    const c = rt(BID).child;
    if (c && c !== childAt2ndStart) spawnObserved = true;
    if (evs.some((e) => e.ch === 'progress' && e.p.file === f2path && (e.p.type === 'file-progress' || e.p.type === 'file-done'))) spawnObserved = true;
    if (spawnObserved) break;
    await sleep(100);
  }
  const spawnedWhilePaused = spawnObserved;

  check(childAt2ndStart === null, `DEFECT 1: state.child is null at the 2nd file-start — no dead-pid SIGSTOP (was: ${childAt2ndStart === null ? 'null' : 'exited-child ref'})`);
  check(!spawnedWhilePaused, `DEFECT 2: 2nd encoder did NOT spawn while paused (spawned-through: ${spawnedWhilePaused})`);

  doResume(BID);                         // must release the gate with no live child
  const res = await runP;
  const hung = res === 'TIMEOUT';
  const f2done = evs.some((e) => e.ch === 'progress' && e.p.type === 'file-done' && e.p.file === f2path && e.p.outcome !== 'fail');
  check(!hung, `resume after a no-child pause did NOT hang the queue (hung: ${hung})`);
  check(f2done, `2nd file encoded to completion after resume (file-done: ${f2done})`);
}

// CHANGE 4 — LONG-FREEZE RESUME: SIGSTOP a live encode, hold, SIGCONT, and prove
// the encode RESUMES TO COMPLETION with a valid output (guards resume-into-broken-pipe).
async function testB() {
  const src = await freshDir(path.join(os.tmpdir(), 'skinnyvideo-pause-B-src'));
  const dest = await freshDir(path.join(os.tmpdir(), 'skinnyvideo-pause-B-out'));
  await fsp.copyFile(LONG, path.join(src, 'only.mov'));
  const BID = 'B1';

  const evs = [];
  const progCount = () => evs.filter((e) => e.ch === 'progress' && e.p.type === 'file-progress').length;
  const doneCount = () => evs.filter((e) => e.ch === 'progress' && e.p.type === 'file-done').length;
  const send = (ch, p) => { evs.push({ ch, p }); };

  const runP = withTimeout(runQueue([folderBatch(BID, src, dest)], { send, isStopRequested: () => false, rt }), 90000);
  await until(() => progCount() >= 1, 40000);   // encoder live
  doPause(BID);                                  // SIGSTOP the live child
  const atPause = progCount();
  await sleep(2500);                             // real suspend/continue cycle
  const frozen = progCount() === atPause && doneCount() === 0;
  check(frozen, `mid-encode pause froze the live child — no progress/done while paused (progress ${atPause}→${progCount()}, done ${doneCount()})`);

  doResume(BID);                                 // SIGCONT
  const res = await runP;
  const hung = res === 'TIMEOUT';
  const doneOk = evs.some((e) => e.ch === 'progress' && e.p.type === 'file-done' && e.p.outcome !== 'fail');
  const outs = findOutput(dest);
  const outValid = outs.length > 0 && ffprobeValid(outs[0]);
  check(!hung, `resume after mid-encode pause did not hang (hung: ${hung})`);
  check(doneOk && outValid, `frozen encode RESUMED to completion — output present and ffprobe-valid (done: ${doneOk}, valid: ${outValid}, files: ${outs.length})`);
}

// CHANGE 3 — teardown while paused in the probe window (no live child). The event
// gate must release on stop/cancel and the queue must not hang. mode 'stop'|'cancel'.
async function testTeardown(mode) {
  const src = await freshDir(path.join(os.tmpdir(), `skinnyvideo-pause-td-${mode}-src`));
  const dest = await freshDir(path.join(os.tmpdir(), `skinnyvideo-pause-td-${mode}-out`));
  await fsp.copyFile(TINY, path.join(src, 'a_clip.mov'));
  await fsp.copyFile(LONG, path.join(src, 'b_clip.mov'));
  const BID = `TD-${mode}`;

  const evs = [];
  let fileStarts = 0, f2path = null;
  let stopFlag = false;
  const send = (ch, p) => {
    evs.push({ ch, p });
    if (ch === 'progress' && p.type === 'file-start') {
      fileStarts++;
      if (fileStarts === 2) { f2path = p.file; doPause(BID); }   // pause: no live child
    }
  };

  const runP = withTimeout(runQueue([folderBatch(BID, src, dest)], { send, isStopRequested: () => stopFlag, rt }), 60000);
  await until(() => f2path !== null, 40000);
  await sleep(300);                        // firmly parked on the gate, paused
  if (mode === 'stop') { stopFlag = true; releasePauseGate(rt(BID)); }   // mirror stop-queue
  else doCancel(BID);                                                    // mirror cancel-batch

  const res = await runP;
  const hung = res === 'TIMEOUT';
  const f2done = evs.some((e) => e.ch === 'progress' && e.p.type === 'file-done' && e.p.file === f2path && e.p.outcome !== 'fail');
  check(!hung, `${mode} while paused (no child) released the gate — queue tore down, no hang (hung: ${hung})`);
  check(!f2done, `${mode} while paused: the held 2nd encoder did NOT run (encoded-anyway: ${f2done})`);
}

(async () => {
  const st = ffmpegStatus(getBinaries());
  if (!st.ok || !fs.existsSync(TINY) || !fs.existsSync(LONG)) {
    console.log('SKIP: bundled ffmpeg or fixtures missing — pause_race_test needs a real encode');
    process.exit(0);
  }
  try {
    await testA();
    await testTeardown('stop');
    await testTeardown('cancel');
    await testB();
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})();
