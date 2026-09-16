/* Partial files are identified by the EXACT paths the pipeline recorded, never
   by the ".tmp.mp4" suffix. A source named "holiday.tmp.mov" legitimately
   produces "holiday.tmp.mp4"; suffix-based cleanup deleted that finished output.
   Proves: runBatch records its tmpPath (result.partials + control.onPartial);
   flatten keeps holiday.tmp.mp4 and deletes only a recorded leftover; orphan
   detection and delete-orphans act only on recorded paths under a known root.
   FAIL-ON-OLD: flatten swept holiday.tmp.mp4 by suffix; deletePartials took any
   Compressed_/…tmp.mp4 path it was handed; holiday.mov's temp name was
   holiday.tmp.mov's finished name, so one encode order destroyed an output.
   Run: node test/partial_paths_test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { runBatch } = require(path.join(ROOT, 'src/encoder/pipeline'));
const { flattenRunDir } = require(path.join(ROOT, 'src/encoder/flatten'));
const { findOrphanPartials, deletePartials } = require(path.join(ROOT, 'src/encoder/orphans'));
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

(async () => {
  const sb = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-partials-')));
  const src = path.join(sb, 'Trip');
  const dest = path.join(sb, 'Out');
  fs.mkdirSync(src); fs.mkdirSync(dest);
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
    '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', path.join(src, 'holiday.tmp.mov')]);
  if (r.status !== 0) throw new Error('fixture encode failed: ' + r.stderr);

  try {
    const seen = [];
    const res = await runBatch({ src, dest, tier: 'regular' },
      { shouldStop: () => false, onPartial: (p) => seen.push(p) }, null);
    check(res.processed === 1 && res.failed === 0, `encoded (processed=${res.processed} failed=${res.failed})`);
    const expectTmp = path.join(res.runDir, 'Trip', 'holiday.tmp.tmp.mp4');
    check(Array.isArray(res.partials) && res.partials.length === 1 && res.partials[0] === expectTmp,
      `result.partials records the exact tmpPath (got ${JSON.stringify(res.partials)})`);
    check(seen.length === 1 && seen[0] === expectTmp, 'control.onPartial fired with the same path before encoding');

    // A genuine leftover the pipeline recorded (simulates a crash mid-file).
    const leftover = path.join(res.runDir, 'Trip', 'crashed.tmp.mp4');
    fs.writeFileSync(leftover, 'PARTIAL');
    await flattenRunDir(res.runDir, [...(res.partials || []), leftover]);
    const out = path.join(res.runDir, 'holiday.tmp.mp4');
    check(fs.existsSync(out), 'holiday.tmp.mp4 survives flatten (lifted to the run folder)');
    check(!fs.existsSync(leftover) && !fs.existsSync(path.join(res.runDir, 'crashed.tmp.mp4')),
      'a RECORDED leftover is deleted, not promoted');

    // Orphan detection after a "crash": only recorded paths, only under a root.
    const stray = path.join(res.runDir, 'stray.tmp.mp4');
    fs.writeFileSync(stray, 'PARTIAL');
    const outsideRoot = path.join(sb, 'Compressed_elsewhere', 'x.tmp.mp4');
    fs.mkdirSync(path.dirname(outsideRoot)); fs.writeFileSync(outsideRoot, 'PARTIAL');
    const recorded = [stray, outsideRoot];
    const found = (await findOrphanPartials(recorded, [dest])).map((o) => o.path);
    check(found.length === 1 && found[0] === stray, `orphans = recorded paths under a known root only (got ${JSON.stringify(found)})`);
    check(!found.includes(out), 'finished holiday.tmp.mp4 is never offered as an orphan');

    // delete-orphans: a finished output handed over by the renderer is refused.
    const n = await deletePartials([out, stray, outsideRoot], { recorded, roots: [dest] });
    check(n === 1, `deletePartials deleted only the recorded, in-root partial (deleted ${n})`);
    check(fs.existsSync(out), 'holiday.tmp.mp4 survives delete-orphans');
    check(!fs.existsSync(stray), 'recorded partial removed');
    check(fs.existsSync(outsideRoot), 'recorded path outside every known root refused');
    check(await deletePartials([stray]) === 0, 'no recorded set → deletes nothing');
    const numbered = path.join(res.runDir, 'clip.tmp_2.mp4');
    fs.writeFileSync(numbered, 'PARTIAL');
    check(await deletePartials([numbered], { recorded: [numbered], roots: [dest] }) === 1, 'a recorded numbered temp (clip.tmp_2.mp4) is cleaned up too');

    /* Temp names vs finished names, in BOTH encode orders. holiday.mov's temp
       used to be "holiday.tmp.mp4" — exactly holiday.tmp.mov's finished file —
       so encoding holiday.tmp.mov first had its output unlinked by the next
       file's pre-encode cleanup. Encode order is readdir order; force it. */
    const pair = path.join(sb, 'Pair');
    fs.mkdirSync(pair);
    for (const [name, secs] of [['holiday.mov', 1], ['holiday.tmp.mov', 2]]) {
      const e = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=30:duration=${secs}`,
        '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', path.join(pair, name)]);
      if (e.status !== 0) throw new Error('fixture encode failed: ' + e.stderr);
    }
    const probeDur = (f) => Math.round(Number(spawnSync(path.join(ROOT, 'resources/bin/ffprobe'),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString().trim()));
    const realReaddir = fs.promises.readdir;
    for (const order of [['holiday.mov', 'holiday.tmp.mov'], ['holiday.tmp.mov', 'holiday.mov']]) {
      const label = order.join(' then ');
      fs.promises.readdir = async (dir, opts) => {
        const entries = await realReaddir(dir, opts);
        if (dir !== pair) return entries;
        const key = (e) => order.indexOf(typeof e === 'string' ? e : e.name);
        return [...entries].sort((a, b) => key(a) - key(b));
      };
      const pairOut = path.join(sb, 'PairOut-' + order[0]);
      fs.mkdirSync(pairOut);
      const events = [];
      let pr;
      try {
        pr = await runBatch({ src: pair, dest: pairOut, tier: 'regular' }, { shouldStop: () => false },
          (ev) => { if (ev.type === 'file-start') events.push(path.basename(ev.file)); });
      } finally { fs.promises.readdir = realReaddir; }
      check(JSON.stringify(events) === JSON.stringify(order), `[${label}] encoded in the forced order (${events.join(', ')})`);
      check(pr.processed === 2 && pr.failed === 0, `[${label}] both encoded (processed=${pr.processed} failed=${pr.failed})`);
      const finals = [path.join(pr.runDir, 'Pair', 'holiday.mp4'), path.join(pr.runDir, 'Pair', 'holiday.tmp.mp4')];
      check(!pr.partials.some((t) => finals.includes(t)), `[${label}] no temp path equals a finished path (${pr.partials.map((t) => path.basename(t)).join(', ')})`);
      await flattenRunDir(pr.runDir, pr.partials);
      const top = fs.readdirSync(pr.runDir).filter((f) => f.endsWith('.mp4')).sort();
      check(JSON.stringify(top) === JSON.stringify(['holiday.mp4', 'holiday.tmp.mp4']), `[${label}] both finished files survive with stable names (${top.join(', ')})`);
      check(top.length === 2 && probeDur(path.join(pr.runDir, 'holiday.mp4')) === 1 && probeDur(path.join(pr.runDir, 'holiday.tmp.mp4')) === 2,
        `[${label}] each name holds its own source (holiday.mp4 = 1s, holiday.tmp.mp4 = 2s)`);
    }
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
  if (FAIL.length) { console.error(`\n${FAIL.length} FAILED`); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
