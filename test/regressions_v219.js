// v2.1.9 regression: BUG B — the CURRENTLY-ENCODING file's source vanishes
// mid-encode. The source poll must kill the child FAST (a few seconds), not
// wait out the 60s inactivity stall (which read as a hang). Needs the
// CompressorTest fixture + bundled ffmpeg.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runBatch, getBinaries } = require('../src/encoder/pipeline');

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SMALL_CLIP = '/Users/macmini1/Downloads/CompressorTest/Source/Project A/C0224.mov';

(async () => {
  if (!fs.existsSync(SMALL_CLIP) || !fs.existsSync(getBinaries().ffmpeg)) {
    console.log('(skipped — fixture clip or bundled ffmpeg not present)');
    return;
  }
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'squeeze-v219-'));
  const src = path.join(sandbox, 'Source');
  await fsp.mkdir(src, { recursive: true });
  const clip = path.join(src, 'rolling.mov');
  await fsp.copyFile(SMALL_CLIP, clip);
  const dest = path.join(sandbox, 'Out');
  await fsp.mkdir(dest, { recursive: true });

  // Delete the source the moment encoding is underway (first progress tick).
  let encodingSrc = null, deleted = false, deletedAtMs = 0;
  const startTs = Date.now();
  const onProgress = (d) => {
    if (d.type === 'file-start') encodingSrc = d.file;
    if (d.type === 'file-progress' && !deleted && encodingSrc) {
      try { fs.unlinkSync(encodingSrc); deleted = true; deletedAtMs = Date.now() - startTs; } catch {}
    }
  };

  // 'preserve' (libx265) is slow enough that the source poll fires mid-encode.
  const res = await runBatch({ src, dest, tier: 'preserve' }, () => false, onProgress);
  const elapsed = Date.now() - startTs;

  console.log('  deleted=%s atMs=%d | result: %j | elapsedMs=%d', deleted, deletedAtMs,
    { processed: res.processed, failed: res.failed, failedNoCopy: res.failedNoCopy }, elapsed);
  check(deleted, 'source was deleted while the file was encoding');
  check(res.failed === 1 && res.failedNoCopy === 1, 'file marked source-missing (no-copy), not a false success');
  check(res.processed === 0, 'no bogus output recorded for the vanished source');
  // The whole point: it must NOT take ~60s (the stall watchdog). The fast
  // source poll should end it within a handful of seconds of the deletion.
  check(elapsed < 30000, `run ended FAST (${elapsed}ms — source poll fired, not the 60s stall)`);
  check((elapsed - deletedAtMs) < 12000, `terminated within ~seconds of the deletion (${elapsed - deletedAtMs}ms after)`);

  await fsp.rm(sandbox, { recursive: true, force: true });
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  if (FAIL.length) { for (const l of FAIL) console.log(' - ' + l); process.exit(1); }
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
