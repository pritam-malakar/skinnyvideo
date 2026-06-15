/* Write-aware stall watchdog regression (v2.2.8) — real processes, real
   files, real clocks. The diagnosed field failure: an encoder writing a
   high-bitrate output to an SMB destination goes SILENT for >60s while the
   output file keeps growing (write-back flush); the old watchdog killed it as
   stalled. Silence alone must no longer kill when the output is growing.

   MODE=all (default) runs every case:
     growing   — DECISIVE, FAILS PRE-FIX: /bin/sh child bursts stderr, then is
                 fully silent for ~15s (3x the 5s window) while a background
                 loop appends real bytes to the output file every 2s; ends
                 with a final stderr line, exit 0. Old watchdog: killed at 5s
                 (stalled:true). Write-aware: survives, code 0.
     fullscale — same shape at PRODUCTION numbers: 60s window (the real
                 STALL_TIMEOUT_MS), 90s of silence, growth every 5s. ~100s.
     dead      — burst, ONE write, then silent with NO growth → killed about
                 one window after the last confirmed growth (prompt death
                 preserved), stallReason 'no-growth'.
     nofile    — burst, never creates the output → killed at ~window,
                 stallReason 'no-output-file'.
     ceiling   — silent child + probes that return UNKNOWN every time (the
                 one condition a healthy filesystem cannot fabricate — a
                 genuinely hung SMB stat; injected via the probeOutSize seam,
                 child/silence/clock all real) → survives the base window,
                 killed at the hard ceiling, stallReason 'probe-blind'.

   Run:  node test/watchdog_test.js   (or MODE=<case>) */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { runCmd, STALL_TIMEOUT_MS } = require(path.join(__dirname, '..', 'src/encoder/pipeline'));

const MODE = process.env.MODE || 'all';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'squeeze-wd-'));
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

const sh = (script) => ['/bin/sh', ['-c', script]];

async function caseGrowing() {
  const out = path.join(TMP, 'growing.out');
  // stderr burst → 15s TOTAL silence; meanwhile real bytes land in `out`
  // every 2s. Final line, clean exit.
  const [cmd, args] = sh(`
    echo "frame= 1 starting" 1>&2
    ( i=0; while [ $i -lt 8 ]; do sleep 2; dd if=/dev/zero bs=1024 count=64 >> "${out}" 2>/dev/null; i=$((i+1)); done ) &
    sleep 17
    wait
    echo "frame= 999 done" 1>&2
    exit 0
  `);
  const t0 = Date.now();
  const r = await runCmd(cmd, args, { stallTimeoutMs: 5000, outPath: out });
  const wall = (Date.now() - t0) / 1000;
  console.log(`  growing: code=${r.code} stalled=${!!r.stalled} wall=${wall.toFixed(1)}s outBytes=${fs.existsSync(out) ? fs.statSync(out).size : -1}`);
  check(!r.stalled && r.code === 0,
    'DECISIVE: silent-but-growing encode SURVIVES the watchdog and completes');
  check(wall > 15, 'it genuinely sat through >3 silence windows (real clock)');
}

async function caseFullscale() {
  const out = path.join(TMP, 'fullscale.out');
  // PRODUCTION window (60s), 90s of true silence, growth every 5s.
  const [cmd, args] = sh(`
    echo "frame= 1 starting" 1>&2
    ( i=0; while [ $i -lt 19 ]; do sleep 5; dd if=/dev/zero bs=8192 count=16 >> "${out}" 2>/dev/null; i=$((i+1)); done ) &
    sleep 97
    wait
    echo "frame= 999 done" 1>&2
    exit 0
  `);
  const t0 = Date.now();
  const r = await runCmd(cmd, args, { stallTimeoutMs: STALL_TIMEOUT_MS, outPath: out });
  const wall = (Date.now() - t0) / 1000;
  console.log(`  fullscale: code=${r.code} stalled=${!!r.stalled} wall=${wall.toFixed(1)}s`);
  check(!r.stalled && r.code === 0,
    `FULL SCALE: 90s-silent growing encode survives the real ${Math.round(STALL_TIMEOUT_MS / 1000)}s window`);
}

async function caseDead() {
  const out = path.join(TMP, 'dead.out');
  const [cmd, args] = sh(`
    echo "frame= 1 starting" 1>&2
    echo "data" >> "${out}"
    sleep 300
  `);
  const t0 = Date.now();
  const r = await runCmd(cmd, args, { stallTimeoutMs: 5000, outPath: out });
  const wall = (Date.now() - t0) / 1000;
  console.log(`  dead: stalled=${!!r.stalled} reason=${r.stallReason} wall=${wall.toFixed(1)}s`);
  check(r.stalled === true && r.stallReason === 'no-growth',
    'silent + output NOT growing IS killed (reason: no-growth)');
  check(wall < 20, `prompt death — well under the ceiling (${wall.toFixed(1)}s, window 5s)`);
}

async function caseNofile() {
  const out = path.join(TMP, 'never-created.out');
  const [cmd, args] = sh(`
    echo "frame= 1 starting" 1>&2
    sleep 300
  `);
  const t0 = Date.now();
  const r = await runCmd(cmd, args, { stallTimeoutMs: 5000, outPath: out });
  const wall = (Date.now() - t0) / 1000;
  console.log(`  nofile: stalled=${!!r.stalled} reason=${r.stallReason} wall=${wall.toFixed(1)}s`);
  check(r.stalled === true && r.stallReason === 'no-output-file',
    'silent + output never created IS killed (reason: no-output-file)');
  check(wall < 12, `killed at about one window (${wall.toFixed(1)}s)`);
}

async function caseCeiling() {
  const out = path.join(TMP, 'ceiling.out');
  const [cmd, args] = sh(`
    echo "frame= 1 starting" 1>&2
    sleep 300
  `);
  const t0 = Date.now();
  // probeOutSize seam: every probe is UNKNOWN (null) — simulates a stat()
  // that blocks on a flushing SMB mount, which a healthy local FS can't
  // fabricate. Child, silence, and the clock are real.
  const r = await runCmd(cmd, args, {
    stallTimeoutMs: 3000, stallCeilingMs: 12000, outPath: out,
    probeOutSize: async () => null
  });
  const wall = (Date.now() - t0) / 1000;
  console.log(`  ceiling: stalled=${!!r.stalled} reason=${r.stallReason} wall=${wall.toFixed(1)}s`);
  check(r.stalled === true && r.stallReason === 'probe-blind',
    'unknown-growth probes never kill at the window — killed at the HARD CEILING (reason: probe-blind)');
  check(wall >= 11 && wall < 25,
    `died at ~the 12s ceiling, not the 3s window (${wall.toFixed(1)}s)`);
}

(async () => {
  const cases = { growing: caseGrowing, fullscale: caseFullscale, dead: caseDead, nofile: caseNofile, ceiling: caseCeiling };
  const torun = MODE === 'all' ? Object.keys(cases) : [MODE];
  for (const k of torun) {
    console.log(`\n— ${k} —`);
    await cases[k]();
  }
  await fsp.rm(TMP, { recursive: true, force: true });
  console.log(`\n[watchdog:${MODE}] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  if (FAIL.length) for (const l of FAIL) console.log(' - ' + l);
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => { console.log('FATAL', e); process.exit(1); });
