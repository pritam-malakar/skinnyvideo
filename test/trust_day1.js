// Day-1 trust/resilience unit tests — flatten collision suffix (item 5)
// and orphaned-partial detection + delete safety (item 6). No electron,
// no ffmpeg: pure fs in an isolated tmp sandbox.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { flattenRunDir } = require('../src/encoder/flatten');
const { findOrphanPartials, isDeletablePartial, deletePartials } = require('../src/encoder/orphans');
const { copyToFailed, runCmd, isDestWritable } = require('../src/encoder/pipeline');

const PASS = [], FAIL = [];
function check(cond, label) { (cond ? PASS : FAIL).push(label); console.log((cond ? 'PASS' : 'FAIL') + ': ' + label); }
function header(t) { console.log('\n==== ' + t + ' ===='); }
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-trust-'));

  // ─────────────────────────────────────────────────────────────
  header('Item 5: flatten collision auto-suffix under flat output');
  // Mirror what the pipeline writes pre-flatten: a run folder with two
  // source subtrees that each hold a same-named "clip.mp4", a stray
  // .tmp.mp4 partial, a preserved _FAILED/ tree, and a top-level log.
  const runDir = path.join(sandbox, 'Compressed_2026-06-02_1200');
  const srcA = path.join(runDir, 'ShootA', 'Day1');
  const srcB = path.join(runDir, 'ShootB');
  await fsp.mkdir(srcA, { recursive: true });
  await fsp.mkdir(srcB, { recursive: true });
  await fsp.writeFile(path.join(srcA, 'clip.mp4'), 'AAA');           // collision #1
  await fsp.writeFile(path.join(srcB, 'clip.mp4'), 'BBB');           // collision #2
  await fsp.writeFile(path.join(srcB, 'unique.mp4'), 'UNIQUE');      // no collision
  await fsp.writeFile(path.join(srcA, 'half.tmp.mp4'), 'PARTIAL');   // stray partial → swept
  await fsp.writeFile(path.join(runDir, 'compress.log'), 'log');     // top-level → stays
  const failedDir = path.join(runDir, '_FAILED', 'ShootA');
  await fsp.mkdir(failedDir, { recursive: true });
  await fsp.writeFile(path.join(failedDir, 'broken.mov'), 'FAILSRC'); // preserved nested

  const lifted = await flattenRunDir(runDir);

  const top = fs.readdirSync(runDir).sort();
  const mp4s = top.filter((f) => f.endsWith('.mp4')).sort();
  check(lifted === 3, `lifted 3 outputs to top level (got ${lifted})`);
  check(mp4s.length === 3, `3 mp4 files at top level (got ${mp4s.join(', ')})`);
  check(mp4s.includes('clip.mp4') && mp4s.includes('clip_2.mp4'),
    'colliding clip.mp4 + clip_2.mp4 both present (suffix applied)');
  check(mp4s.includes('unique.mp4'), 'non-colliding unique.mp4 present');

  // No output lost: the three distinct payloads all survive somewhere.
  const payloads = mp4s.map((f) => read(path.join(runDir, f))).sort();
  check(JSON.stringify(payloads) === JSON.stringify(['AAA', 'BBB', 'UNIQUE'].sort()),
    'all three distinct payloads preserved — nothing overwritten');

  check(!exists(path.join(srcA, 'half.tmp.mp4')), '.tmp.mp4 partial swept (not promoted)');
  check(!top.includes('half.tmp.mp4') && !top.includes('half.mp4'),
    'partial did not surface as a final output');
  check(exists(path.join(runDir, 'compress.log')), 'top-level compress.log untouched');
  check(exists(path.join(failedDir, 'broken.mov')), '_FAILED/ tree preserved (not flattened)');
  check(!exists(srcA) && !exists(srcB), 'emptied source mirror folders pruned');

  // ─────────────────────────────────────────────────────────────
  header('Item 6: orphaned-partial detection + delete safety');
  const dest = path.join(sandbox, 'OperatorOutput');
  const run1 = path.join(dest, 'Compressed_2026-06-01_0900');
  const run1sub = path.join(run1, 'Sub');
  await fsp.mkdir(run1sub, { recursive: true });
  await fsp.writeFile(path.join(run1, 'a.tmp.mp4'), 'PARTIAL-A');   // orphan
  await fsp.writeFile(path.join(run1, 'b.mp4'), 'FINISHED-B');      // finished — NOT an orphan
  await fsp.writeFile(path.join(run1sub, 'c.tmp.mp4'), 'PARTIAL-C'); // orphan (nested)
  // A look-alike OUTSIDE any Compressed_ folder — must never be touched.
  const origDir = path.join(dest, 'Originals');
  await fsp.mkdir(origDir, { recursive: true });
  await fsp.writeFile(path.join(origDir, 'orig.tmp.mp4'), 'NOT-OURS');

  const found = await findOrphanPartials([dest]);
  const foundPaths = found.map((o) => o.path).sort();
  check(found.length === 2, `found 2 partials (got ${found.length})`);
  check(foundPaths.includes(path.join(run1, 'a.tmp.mp4'))
     && foundPaths.includes(path.join(run1sub, 'c.tmp.mp4')),
    'found both top-level and nested partials under Compressed_');
  check(!foundPaths.includes(path.join(run1, 'b.mp4')), 'finished .mp4 not flagged');
  check(!foundPaths.includes(path.join(origDir, 'orig.tmp.mp4')),
    'look-alike outside Compressed_ not flagged');

  // Safety predicate
  check(isDeletablePartial(path.join(run1, 'a.tmp.mp4')) === true, 'predicate: Compressed_ .tmp.mp4 → deletable');
  check(isDeletablePartial(path.join(run1, 'b.mp4')) === false, 'predicate: finished .mp4 → not deletable');
  check(isDeletablePartial(path.join(origDir, 'orig.tmp.mp4')) === false, 'predicate: .tmp.mp4 outside Compressed_ → not deletable');
  check(isDeletablePartial('/Users/me/footage/master.mov') === false, 'predicate: an original → not deletable');

  // deletePartials must refuse anything that fails the predicate, even if
  // explicitly handed to it.
  const refused = await deletePartials([
    path.join(origDir, 'orig.tmp.mp4'),   // outside Compressed_
    path.join(run1, 'b.mp4')              // finished output
  ]);
  check(refused === 0, 'deletePartials refused both unsafe paths (deleted 0)');
  check(exists(path.join(origDir, 'orig.tmp.mp4')), 'look-alike original still present');
  check(exists(path.join(run1, 'b.mp4')), 'finished output still present');

  // Now delete the genuine orphans.
  const deleted = await deletePartials(found.map((o) => o.path));
  check(deleted === 2, `deleted the 2 real orphans (got ${deleted})`);
  check(!exists(path.join(run1, 'a.tmp.mp4')) && !exists(path.join(run1sub, 'c.tmp.mp4')),
    'both orphan partials removed');
  check(exists(path.join(run1, 'b.mp4')), 'finished output survived orphan cleanup');

  // ─────────────────────────────────────────────────────────────
  header('Failed-file copy: present preserved, missing throws (no-copy path)');
  // This is the hinge the conditional _FAILED/ wording rests on: a present
  // source is copied (copied=true → "A copy is in _FAILED/"); a vanished
  // source makes copyToFailed throw (copied=false → "couldn't be read").
  const fcRun = path.join(sandbox, 'Compressed_2026-06-03_1000');
  await fsp.mkdir(fcRun, { recursive: true });
  const presentSrc = path.join(sandbox, 'present.mov');
  await fsp.writeFile(presentSrc, 'CORRUPT-BUT-PRESENT');

  let presentThrew = false;
  try { await copyToFailed(fcRun, 'file', presentSrc, presentSrc); }
  catch { presentThrew = true; }
  check(!presentThrew, 'present source: copyToFailed did not throw (copy made)');
  check(exists(path.join(fcRun, '_FAILED', 'present.mov')),
    'present source: original preserved under _FAILED/');

  const missingSrc = path.join(sandbox, 'gone.mov');   // never created
  let missingThrew = false;
  try { await copyToFailed(fcRun, 'file', missingSrc, missingSrc); }
  catch { missingThrew = true; }
  check(missingThrew, 'missing source: copyToFailed threw (no-copy path → honest wording)');
  check(!exists(path.join(fcRun, '_FAILED', 'gone.mov')),
    'missing source: no _FAILED/ copy was written');

  // ─────────────────────────────────────────────────────────────
  header('BUG 2: multi-root sweep finds all partials; finished + outside survive');
  // Two separate output roots, each with its own Compressed_ run folder.
  // Pre-fix the sweep only looked at the last run's dest and missed the rest.
  const rootA = path.join(sandbox, 'OutputA');
  const rootB = path.join(sandbox, 'OutputB');
  const cmpA = path.join(rootA, 'Compressed_2026-05-28_1927');
  const cmpB = path.join(rootB, 'Compressed_2026-06-01_0830');
  await fsp.mkdir(cmpA, { recursive: true });
  await fsp.mkdir(path.join(cmpB, 'Nested'), { recursive: true });
  await fsp.writeFile(path.join(cmpA, 'p1.tmp.mp4'), 'PARTIAL-1');
  await fsp.writeFile(path.join(cmpA, 'clip.mp4'), 'FINISHED-CLIP');          // finished — must survive
  await fsp.writeFile(path.join(cmpB, 'p2.tmp.mp4'), 'PARTIAL-2');
  await fsp.writeFile(path.join(cmpB, 'Nested', 'p3.tmp.mp4'), 'PARTIAL-3');
  // A real video sitting OUTSIDE any Compressed_ folder — must never match.
  const outsideMaster = path.join(rootB, 'master.mov');
  await fsp.writeFile(outsideMaster, 'PRECIOUS-ORIGINAL');

  const sweep = await findOrphanPartials([rootA, rootB]);
  check(sweep.length === 3, `multi-root sweep found all 3 partials (got ${sweep.length})`);
  const sizesAccurate = sweep.every((o) => o.size === fs.statSync(o.path).size && o.size > 0);
  check(sizesAccurate, 'each reported size equals the file’s actual bytes on disk');

  const deletedSweep = await deletePartials(sweep.map((o) => o.path));
  check(deletedSweep === 3, `deleted all 3 partials across both roots (got ${deletedSweep})`);
  check(exists(path.join(cmpA, 'clip.mp4')), 'finished clip.mp4 survived the sweep');
  check(read(path.join(cmpA, 'clip.mp4')) === 'FINISHED-CLIP', 'finished clip.mp4 bytes intact');
  check(exists(outsideMaster) && read(outsideMaster) === 'PRECIOUS-ORIGINAL',
    'outside-folder original survived untouched');

  // ─────────────────────────────────────────────────────────────
  header('BUG 3: stall watchdog, pause-awareness, destination reachability');
  // A silent long process is killed once the inactivity window elapses, and
  // runCmd resolves fast with stalled=true (never hangs the queue).
  const t0 = Date.now();
  const stalledRes = await runCmd('sleep', ['5'], { stallTimeoutMs: 250 });
  const stalledMs = Date.now() - t0;
  check(stalledRes.stalled === true && stalledRes.code === -1, 'silent process flagged stalled');
  check(stalledMs < 1500, `stall resolved fast (${stalledMs}ms, no hang)`);

  // A "paused" encode emits nothing too — the watchdog must NOT kill it.
  const t1 = Date.now();
  const pausedRes = await runCmd('sleep', ['1'], { stallTimeoutMs: 150, isPaused: () => true });
  const pausedMs = Date.now() - t1;
  check(!pausedRes.stalled && pausedRes.code === 0, 'paused (silent) process not killed by watchdog');
  check(pausedMs >= 900, `paused process ran to completion (${pausedMs}ms)`);

  // Normal chatty process under a generous window is unaffected.
  const okRes = await runCmd('sh', ['-c', 'echo hello'], { stallTimeoutMs: 5000 });
  check(okRes.code === 0 && /hello/.test(okRes.stdout) && !okRes.stalled, 'normal command unaffected by watchdog');

  // Reachability probe: real dir writable, vanished path not — and the check
  // returns fast either way.
  check((await isDestWritable(sandbox)) === true, 'isDestWritable true for a live writable dir');
  check((await isDestWritable(path.join(sandbox, 'nope', 'gone'))) === false,
    'isDestWritable false for a missing/unreachable path');

  // ─────────────────────────────────────────────────────────────
  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\n==== SUMMARY ====');
  console.log('PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { console.log('FAILED:'); for (const l of FAIL) console.log(' -', l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
