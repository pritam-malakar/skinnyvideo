// Regression tests for v2.1.7 — BUG B (source-missing fast-fail, no hang) and
// BUG C (cancel always terminates a wedged/unresponsive child). Unit checks
// run anywhere; the end-to-end mid-run-deletion test needs the CompressorTest
// fixture + bundled ffmpeg.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, runCmd, isSourceReadable, getBinaries } = require('../src/encoder/pipeline');

const PASS = [], FAIL = [];
function check(cond, label) { (cond ? PASS : FAIL).push(label); console.log((cond ? 'PASS' : 'FAIL') + ': ' + label); }
function header(t) { console.log('\n==== ' + t + ' ===='); }

const { ensureFixtures } = require('./fixture_helper');
const FX = ensureFixtures();
// '' when the bundled ffmpeg is absent, so the existsSync guard below skips cleanly.
const SMALL_CLIP = FX ? FX.smallClip : '';

(async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'skinnyvideo-reg-'));

  // ── BUG B unit: isSourceReadable ───────────────────────────────
  header('BUG B: isSourceReadable');
  const present = path.join(sandbox, 'present.mov');
  await fsp.writeFile(present, 'x');
  check((await isSourceReadable(present)) === true, 'existing file → readable');
  check((await isSourceReadable(path.join(sandbox, 'gone.mov'))) === false, 'missing file → not readable (fast)');
  check((await isSourceReadable(null)) === false, 'null → not readable');

  // ── BUG C unit: runCmd cancel poll terminates a silent child fast ──
  header('BUG C: runCmd resolves immediately on cancel (no wait for close)');
  let cancelled = false;
  const t0 = Date.now();
  // `sleep 30` emits nothing and won't exit — only the cancel poll can end it.
  const p = runCmd('sleep', ['30'], { stallTimeoutMs: 60000, isCancelled: () => cancelled });
  setTimeout(() => { cancelled = true; }, 300);
  const r = await p;
  const ms = Date.now() - t0;
  check(r.cancelled === true, 'runCmd resolved with cancelled:true');
  check(ms < 1500, `cancel resolved fast (${ms}ms — not stuck, not waiting the 60s stall)`);

  // ── End-to-end: a source removed mid-run fast-fails, queue continues ──
  header('BUG B e2e: source deleted mid-run → fast-fail + continue (no hang)');
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('  (skipped — fixture clip or bundled ffmpeg not present)');
  } else {
    const src = path.join(sandbox, 'Source');
    await fsp.mkdir(src, { recursive: true });
    const clipA = path.join(src, 'A_clip.mov');
    const clipB = path.join(src, 'B_clip.mov');
    await fsp.copyFile(SMALL_CLIP, clipA);
    await fsp.copyFile(SMALL_CLIP, clipB);
    const dest = path.join(sandbox, 'Out');
    await fsp.mkdir(dest, { recursive: true });

    // On the FIRST file-start, delete the OTHER clip's source. By the time the
    // loop reaches it, the per-file source pre-check fails → source-missing.
    let deleted = null;
    const onProgress = (d) => {
      if (d.type === 'file-start' && !deleted) {
        const other = d.basename && d.basename.startsWith('A') ? clipB : clipA;
        try { fs.unlinkSync(other); deleted = other; } catch {}
      }
    };

    const startedAt = Date.now();
    const res = await runBatch({ src, dest, tier: 'regular' }, () => false, onProgress);
    const elapsed = Date.now() - startedAt;

    console.log('  result:', { processed: res.processed, failed: res.failed, failedNoCopy: res.failedNoCopy, ms: elapsed });
    check(res.processed === 1, 'one file processed (the surviving clip)');
    check(res.failed === 1, 'one file failed (the deleted source)');
    check(res.failedNoCopy === 1, 'failure classified as source-unreadable / no-copy');
    check(res.destLost === false, 'destination not falsely blamed');
    check(elapsed < 60000, `run finished promptly (${elapsed}ms — no multi-minute hang)`);
    // surviving source untouched
    const survivor = deleted === clipA ? clipB : clipA;
    check(fs.existsSync(survivor), 'surviving source still present (originals untouched)');
    // runBatch writes the mirrored structure (main.js flattens later), so count
    // .mp4 outputs recursively.
    const countMp4 = (dir) => {
      let n = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) n += countMp4(p);
        else if (e.isFile() && e.name.endsWith('.mp4')) n++;
      }
      return n;
    };
    const mp4Count = fs.existsSync(res.runDir) ? countMp4(res.runDir) : 0;
    check(mp4Count === 1, `exactly one .mp4 output produced (got ${mp4Count})`);
  }

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\n==== SUMMARY ====');
  console.log('PASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { console.log('FAILED:'); for (const l of FAIL) console.log(' -', l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
