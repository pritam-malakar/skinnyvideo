/* Finalization detector regression (v2.2.8).
   Finalization = "encode reached ~100% but the process is STILL ALIVE flushing
   the container" (the multi-second SMB moov write) — NOT silence. runCmd must
   fire onFinalizing from a progress+debounce detector, within ~2s of reaching
   100%, with NO dependence on the 60s stall window. The stall watchdog's
   kill-on-real-hang path is unchanged and must NOT fire onFinalizing.

   Drives the REAL runCmd code path with stub children + an injected getProgress
   (the same hook runBatch feeds from its -stats parse).

   FAIL-ON-OLD: pre-fix runCmd has no getProgress detector and fired onFinalizing
   only from the 60s stall-growth branch — Case A (no stall window at all) sees
   ZERO calls → FAIL. Pass-on-new.
   Run:  node test/finalizing_test.js */
const path = require('path');
const { runCmd } = require(path.join(__dirname, '..', 'src/encoder/pipeline'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const NODE = process.execPath;

(async () => {
  /* Case A — REAL finalize: progress reaches 100% (~600ms), child stays alive
     ~4s. onFinalizing must fire ONCE, while the child is still alive, ~debounce
     after 100% — and crucially WITHOUT any 60s stall window (none configured). */
  {
    const t0 = Date.now();
    let reach100Ts = 0;
    const getProgress = () => {
      const p = (Date.now() - t0) < 600 ? 0.5 : 1.0;
      if (p >= 0.99 && reach100Ts === 0) reach100Ts = Date.now();
      return p;
    };
    let calls = 0, fireTs = 0;
    const r = await runCmd(NODE, ['-e', 'setTimeout(() => {}, 4000)'], {
      getProgress,
      onFinalizing: () => { calls++; if (fireTs === 0) fireTs = Date.now(); }
    });
    const closeTs = Date.now();
    check(calls === 1, `real finalize → onFinalizing fired exactly once (${calls})`);
    check(fireTs > 0 && fireTs < closeTs, `fired DURING the flush, before the child exited`);
    const sinceReach = fireTs - reach100Ts;
    check(fireTs > 0 && sinceReach >= 1000 && sinceReach <= 3000,
      `fired ~debounce after reaching 100% (${sinceReach}ms later; no 60s wait)`);
    check((fireTs - t0) < 3500, `fired within a couple seconds, not after a 60s window (${fireTs - t0}ms)`);
    check(r.code === 0, `child exited cleanly after the flush window (code=${r.code})`);
  }

  /* Case B — fast LOCAL finalize: at 100% immediately but the child exits in
     500ms (< debounce). No false "writing to disk". */
  {
    let calls = 0;
    const r = await runCmd(NODE, ['-e', 'setTimeout(() => {}, 500)'], {
      getProgress: () => 1.0,
      onFinalizing: () => { calls++; }
    });
    check(calls === 0, `fast local finalize (exits before debounce) → no false onFinalizing (${calls})`);
    check(r.code === 0, `fast child exited cleanly (code=${r.code})`);
  }

  /* Case C — stall watchdog UNCHANGED: a silent child with a flat (non-growing)
     output is still killed as 'no-growth', and that path no longer fires
     onFinalizing (progress is nowhere near complete). */
  {
    const probeOutSize = () => Promise.resolve(2048);   // never grows
    let calls = 0;
    const r = await runCmd(NODE, ['-e', 'setTimeout(() => {}, 5000)'], {
      stallTimeoutMs: 150,
      outPath: '/tmp/skinnyvideo-finalizing-flat',
      probeOutSize,
      getProgress: () => 0.4,            // not near complete → detector inert
      onFinalizing: () => { calls++; }
    });
    check(r.stalled === true && r.stallReason === 'no-growth',
      `stall watchdog still kills a real hang as no-growth (stalled=${!!r.stalled}, reason=${r.stallReason})`);
    check(calls === 0, `stall growth/no-growth path no longer fires onFinalizing (${calls})`);
  }

  console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(2); });
