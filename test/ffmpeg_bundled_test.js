/* Regression: v2.1.18 — self-contained bundled ffmpeg, single resolution, no
   fallback, hard fail when missing.

   Plain node (no electron) against the REAL pipeline code. A child_process.spawn
   spy (installed BEFORE pipeline is required, so pipeline's destructured spawn
   is the spy) records every ffmpeg/ffprobe spawn as ground truth.

   T1 RESOLUTION — resolveBinDir has exactly two branches, both inside the app;
      no input can yield a PATH/system/bare ffmpeg. getBinaries (dev) returns the
      in-repo resources/bin path. ffmpegStatus is ok with the engine present.
   T2 MISSING → BLOCKED, NO SPAWN — with the bundled binary renamed away,
      ffmpegStatus is not-ok with the plain message, and runBatch returns
      engineMissing WITHOUT spawning anything (spy stays empty).
   T3 REAL ENCODE — for BOTH tiers, runBatch spawns the BUNDLED absolute path
      (argv[0] === getBinaries().ffmpeg) with the tier's unchanged options; every
      ffmpeg/ffprobe spawn in the whole run is a bundled absolute path, never a
      system/PATH binary.

   FAIL on old code (v2.1.17): resolveBinDir/ffmpegStatus/ENGINE_MISSING_MESSAGE
   don't exist (import throws) and runBatch has no engine guard (it would spawn
   on a missing binary) → fails. PASS on the fix.

   Run:  node test/ffmpeg_bundled_test.js */
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── spawn spy — MUST be installed before pipeline.js is required ──
const cp = require('child_process');
const realSpawn = cp.spawn;
let spawns = [];
cp.spawn = function (cmd, args, opts) {
  if (/ffmpeg|ffprobe/i.test(String(cmd))) spawns.push({ cmd: String(cmd), args: (args || []).slice() });
  return realSpawn.call(cp, cmd, args, opts);
};

const ROOT = path.join(__dirname, '..');
const PIPE = path.join(ROOT, 'src/encoder/pipeline');
const {
  getBinaries, resolveBinDir, ffmpegStatus, ENGINE_MISSING_MESSAGE, runBatch, scanFolder
} = require(PIPE);

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

const REPO_BIN = path.join(ROOT, 'resources', 'bin');
const FFMPEG = path.join(REPO_BIN, 'ffmpeg');
const execFileSync = cp.execFileSync;   // NOT spawn — won't pollute the spy

(async () => {
  // ══ T1: resolution ══════════════════════════════════════════════════════
  const packagedDir = resolveBinDir(true, '/Apps/Squeeze.app/Contents/Resources', '/some/where');
  const devDir = resolveBinDir(false, '/ignored', path.join(ROOT, 'src', 'encoder'));
  check(packagedDir === '/Apps/Squeeze.app/Contents/Resources/bin',
    `packaged branch → Contents/Resources/bin (got "${packagedDir}")`);
  check(devDir === REPO_BIN, `dev branch → in-repo resources/bin (got "${devDir}")`);

  // No branch can yield a system/PATH/bare binary: both outputs are absolute,
  // 'bin'-suffixed, inside the app/repo, and never /usr|/opt|bare.
  const noSystem = (d) => path.isAbsolute(d) && path.basename(d) === 'bin'
    && !d.startsWith('/usr') && !d.startsWith('/opt') && d !== 'ffmpeg';
  check(noSystem(packagedDir) && noSystem(devDir),
    'no resolution branch returns a system/PATH/bare ffmpeg');

  const bins = getBinaries();
  check(path.isAbsolute(bins.ffmpeg) && bins.ffmpeg === FFMPEG,
    `getBinaries (dev) → in-repo absolute ffmpeg (got "${bins.ffmpeg}")`);
  check(/resources\/bin\/ffprobe$/.test(bins.ffprobe), 'getBinaries resolves ffprobe alongside');

  const st = ffmpegStatus();
  check(st.ok === true && st.ffmpeg === FFMPEG, `ffmpegStatus ok with engine present (got ${JSON.stringify(st)})`);

  // ══ T2: missing bundled binary → run blocked, NO spawn ════════════════════
  const BAK = FFMPEG + '.bak-test';
  fs.renameSync(FFMPEG, BAK);
  try {
    const stMissing = ffmpegStatus();
    check(stMissing.ok === false && stMissing.missing === 'ffmpeg',
      `ffmpegStatus not-ok when bundled ffmpeg absent (got ${JSON.stringify(stMissing)})`);
    check(stMissing.message === ENGINE_MISSING_MESSAGE && /reinstall the app/.test(stMissing.message),
      `plain-language message returned (got "${stMissing.message}")`);

    // Real runBatch with the engine missing must NOT spawn — the guard returns first.
    spawns = [];
    const res = await runBatch(
      { src: os.tmpdir(), dest: path.join(os.tmpdir(), 'sq-blocked-' + process.pid), tier: 'regular' },
      { shouldStop: () => false, isCancelled: () => false, isPaused: () => false, onSpawn: () => {} },
      () => {}
    );
    check(res && res.engineMissing === true && res.error === ENGINE_MISSING_MESSAGE,
      `runBatch returns engineMissing + plain message, no run (got ${JSON.stringify(res && {engineMissing:res.engineMissing, error:res.error})})`);
    check(spawns.length === 0, `NO ffmpeg/ffprobe spawned when engine missing (got ${JSON.stringify(spawns.map(s=>s.cmd))})`);
  } finally {
    fs.renameSync(BAK, FFMPEG);   // always restore the vendored binary
  }
  check(fs.existsSync(FFMPEG), 'bundled ffmpeg restored after the missing-binary test');

  // ══ T3: real encode spawns the BUNDLED path, both tiers, unchanged options ══
  // Build a tiny fixture with the bundled engine (skip T3 cleanly if it can't).
  const work = path.join(os.tmpdir(), 'sq-bundled-' + process.pid);
  const srcDir = path.join(work, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const tiny = path.join(srcDir, 'tiny.mp4');
  let haveFixture = false;
  try {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=8',
      '-c:v', 'hevc_videotoolbox', '-tag:v', 'hvc1', tiny], { stdio: 'pipe' });
    haveFixture = fs.existsSync(tiny) && fs.statSync(tiny).size > 0;
  } catch { haveFixture = false; }

  if (!haveFixture) {
    console.log('SKIP (T3 real encode): could not create a fixture with the bundled engine on this machine');
  } else {
    const ENC = { regular: 'hevc_videotoolbox', preserve: 'libx265' };
    for (const tier of ['regular', 'preserve']) {
      spawns = [];
      const dest = path.join(work, 'out-' + tier);
      fs.mkdirSync(dest, { recursive: true });
      await runBatch(
        { src: srcDir, dest, tier },
        { shouldStop: () => false, isCancelled: () => false, isPaused: () => false, onSpawn: () => {} },
        () => {}
      );
      const enc = spawns.find((s) => (s.args || []).includes(ENC[tier]));
      check(!!enc && enc.cmd === FFMPEG,
        `[${tier}] encode spawns the BUNDLED absolute ffmpeg (got "${enc && enc.cmd}")`);
      check(!!enc && enc.args.includes('-tag:v') && enc.args.includes('hvc1')
        && enc.args.includes('-movflags') && enc.args.includes('use_metadata_tags+faststart'),
        `[${tier}] encoder options unchanged (${ENC[tier]} + hvc1 tag + faststart present)`);
      check(spawns.length > 0 && spawns.every((s) => path.isAbsolute(s.cmd) && s.cmd.startsWith(REPO_BIN)),
        `[${tier}] EVERY spawn in the run is the bundled binary, never a system/PATH one`);
    }
  }

  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})();
