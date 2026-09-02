/* Repo regression (v2.10.0): ATOMIC PREFS WRITE — a torn write must never
   destroy the store.

   WHY THIS EXISTS. prefs.json is the ONLY persistence SkinnyVideo has: lastSrc,
   outputRoots, pendingDests, lifetimeDrives — and, as of v2.10.0, `history`
   (up to 50 run entries). loadPrefs (main.js) turns ANY parse failure into
   `prefs = {}` silently: no error, no notice, no backup. So a file that is
   half-written is a file that is gone, without the operator ever being told.

   The v2.9.6 writer opened the REAL prefs.json with 'w' — which truncates —
   and wrote the whole payload into it. Every byte of that write is a window
   in which a crash, a panic or a power loss leaves a truncated JSON document
   sitting where the store used to be. History makes the payload much bigger,
   so it widens exactly the window that costs the most.

   FAIL-ON-OLD / PASS-ON-NEW. Both arms below run against the SAME injected
   failure — a write that lands a prefix of the payload and then dies. The
   only difference is which file receives those partial bytes:
     OLD arm  — a verbatim transcription of cf2b260 main.js:46-51 (kept here,
                not imported; that savePrefs lives inside main.js and cannot
                be required outside Electron). Partial bytes land in
                prefs.json → the store is unparseable → LOST.
     NEW arm  — the REAL writeJsonAtomic from src/main/prefs-store. Partial
                bytes land in a sibling temp, the rename never happens →
                prefs.json is untouched → SURVIVES.

   Run:  node test/atomic_write_test.js */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeJsonAtomic } = require(path.join(__dirname, '..', 'src/main/prefs-store'));

const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const header = (t) => console.log('\n==== ' + t + ' ====');

const WORK = path.join(os.tmpdir(), 'skinnyvideo-atomic-' + process.pid);
fs.mkdirSync(WORK, { recursive: true });

/* ── The v2.9.6 writer, transcribed verbatim from cf2b260 main.js:46-51.
      Only change: the writeFileSync call is reachable through `deps.write`
      so the same power-loss injection can be applied to both arms. ── */
function savePrefsBaseline(target, obj, deps = {}) {
  const write = deps.write || fs.writeFileSync;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    write(target, JSON.stringify(obj, null, 2));
  } catch (e) { /* non-fatal */ }
}

/* A realistic v2.10.0 store: 3 legacy keys + a full 50-entry history. */
function makeStore(tag) {
  return {
    lastSrc: `/Users/op/Movies/${tag}`,
    outputRoots: ['/Volumes/Archive', '/Users/op/Movies/out'],
    pendingDests: [],
    lifetimeDrives: {
      '/': { driveKey: '/', label: 'Macintosh HD', totalReclaimed: 812_003_991,
             filesProcessed: 240, runsCount: 31, firstSeen: 1_700_000_000_000, lastUsed: 1_755_000_000_000 }
    },
    history: Array.from({ length: 50 }, (_, i) => ({
      at: 1_755_000_000_000 - i * 3_600_000,
      name: `${tag} batch ${50 - i}`,
      tier: i % 2 ? 'preserve' : 'regular',
      files: 6, failed: 0, skipped: 1,
      before: 4_000_000_000, after: 1_500_000_000, reclaimed: 2_500_000_000,
      runDir: `/Volumes/Archive/Compressed_2026-08-1${i % 9}_09${i % 6}0`
    }))
  };
}

/* Power loss mid-write: some bytes reach the disk, then the process dies.
   open(2) with 'w' has already truncated whatever it opened. */
const PREFIX_BYTES = 64;
const tornWrite = (p, body) => {
  fs.writeFileSync(p, body.slice(0, PREFIX_BYTES));
  throw new Error('simulated power loss mid-write');
};

const readStore = (p) => {
  // Exactly what loadPrefs does: parse, and on any failure the store is {}.
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};
const strayTemps = (dir, base) =>
  fs.readdirSync(dir).filter((f) => f.startsWith(base + '.') && f.endsWith('.tmp'));

// ───────────────────────────────────────────────────────────────────────────
header('A — torn write over a store that already holds 50 history entries');

// OLD arm
{
  const target = path.join(WORK, 'old-prefs.json');
  const before = makeStore('committed');
  savePrefsBaseline(target, before);                     // clean first write
  const settled = readStore(target);
  check(settled && settled.history.length === 50, 'OLD: committed store on disk, 50 history entries');

  savePrefsBaseline(target, makeStore('doomed'), { write: tornWrite });   // power loss
  const after = readStore(target);
  check(after === null,
    'OLD: torn write leaves prefs.json UNPARSEABLE — loadPrefs would reset to {} and the whole ledger is lost'
    + ` (file is now ${fs.statSync(target).size} bytes)`);
}

// NEW arm — identical injection, real code
{
  const target = path.join(WORK, 'new-prefs.json');
  const before = makeStore('committed');
  writeJsonAtomic(target, before);                       // clean first write
  const settled = readStore(target);
  check(settled && settled.history.length === 50, 'NEW: committed store on disk, 50 history entries');

  const published = writeJsonAtomic(target, makeStore('doomed'), { write: tornWrite });
  const after = readStore(target);
  check(published === false, 'NEW: torn write reports failure (nothing published)');
  check(after !== null, 'NEW: prefs.json still PARSEABLE after the torn write');
  check(after && JSON.stringify(after) === JSON.stringify(before),
    'NEW: prefs.json is byte-for-byte the previous committed store — nothing lost, nothing half-applied');
  check(after && after.history.length === 50 && after.history[0].name === 'committed batch 50',
    'NEW: all 50 history entries survive, newest still first');
  check(strayTemps(WORK, 'new-prefs.json').length === 0,
    'NEW: the partial temp is cleaned up, not left to accumulate');
}

// ───────────────────────────────────────────────────────────────────────────
header('B — crash in the gap between a complete write and the rename');
{
  const target = path.join(WORK, 'gap-prefs.json');
  const before = makeStore('committed');
  writeJsonAtomic(target, before);
  const published = writeJsonAtomic(target, makeStore('doomed'), {
    rename: () => { throw new Error('simulated crash before rename'); }
  });
  const after = readStore(target);
  check(published === false, 'rename failure reports failure');
  check(after && JSON.stringify(after) === JSON.stringify(before),
    'a fully-written temp that never got renamed leaves the committed store intact');
}

// ───────────────────────────────────────────────────────────────────────────
header('C — a stale temp from a REAL power loss (no cleanup ran) is harmless');
{
  const target = path.join(WORK, 'stale-prefs.json');
  writeJsonAtomic(target, makeStore('committed'));
  // Hand-plant the debris a killed process would leave: no catch ever ran.
  fs.writeFileSync(`${target}.${process.pid}.tmp`, '{"history":[garbage');
  const next = makeStore('later');
  const published = writeJsonAtomic(target, next);
  const after = readStore(target);
  check(published === true, 'the next write publishes normally despite the stale temp');
  check(after && after.lastSrc === next.lastSrc, 'the new store is the one on disk');
  check(strayTemps(WORK, 'stale-prefs.json').length === 0, 'the stale temp was overwritten and consumed');
}

// ───────────────────────────────────────────────────────────────────────────
header('D — happy path round-trips exactly');
{
  const target = path.join(WORK, 'ok-prefs.json');
  const store = makeStore('ok');
  const published = writeJsonAtomic(target, store);
  const after = readStore(target);
  check(published === true, 'clean write reports success');
  check(after && JSON.stringify(after) === JSON.stringify(store), 'content round-trips exactly');
  check(strayTemps(WORK, 'ok-prefs.json').length === 0, 'no temp left behind on the happy path');
  // The store is written into a directory that may not exist yet (first launch).
  const deep = path.join(WORK, 'nested', 'deeper', 'prefs.json');
  check(writeJsonAtomic(deep, { a: 1 }) === true && readStore(deep).a === 1,
    'creates the containing directory on first write, like the old writer did');
}

console.log('\nPASS:', PASS.length, 'FAIL:', FAIL.length);
if (FAIL.length) { FAIL.forEach((f) => console.log('  FAILED: ' + f)); }
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
process.exit(FAIL.length ? 1 : 0);
