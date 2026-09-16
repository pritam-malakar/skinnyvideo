/* Picked-file batches that clash ACROSS batches in one run folder (same minute).
   The prefix must come from each source's ORIGINAL parent folder — CardB_C0001 —
   never from the internal "Selected files (N)" staging folder, and fall back to
   _2 only when that name is taken too. Drives the REAL queue-runner → stage →
   pipeline → flatten path with tiny clips from the bundled ffmpeg. Plain node. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { FFMPEG, skip } = require('./fixture_helper');
const { runQueue } = require('../src/main/queue-runner');

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe');

function clip(p, seconds) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=15`,
    '-c:v', 'h264_videotoolbox', '-b:v', '400k', '-t', String(seconds), p], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`clip failed: ${r.stderr}`);
}

(async () => {
  if (!fs.existsSync(FFMPEG)) { skip('bundled ffmpeg missing'); return; }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyvideo-stagedbatches-'));
  const a = path.join(sandbox, 'Shoot', 'CardA', 'C0001.MP4');   // 1 s
  const b = path.join(sandbox, 'Shoot', 'CardB', 'C0001.MP4');   // 2 s
  const c = path.join(sandbox, 'Backup', 'CardB', 'C0001.MP4');  // 3 s — same parent NAME as b
  clip(a, 1); clip(b, 2); clip(c, 3);

  let dest, runDirs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    dest = path.join(sandbox, `out${attempt}`);
    fs.mkdirSync(dest);
    const states = new Map();
    const rt = (id) => { if (!states.has(id)) states.set(id, {}); return states.get(id); };
    const batches = [a, b, c].map((f, i) => ({
      id: i + 1, kind: 'files', src: f, srcName: path.basename(f),
      fileSources: [f], skipped: [], dest, tier: 'regular', dryRun: false
    }));
    await runQueue(batches, { send: () => {}, isStopRequested: () => false, rt });
    runDirs = fs.readdirSync(dest).filter((n) => n.startsWith('Compressed_'));
    if (runDirs.length === 1) break;
    console.log('(the minute rolled over between batches — retrying once)');
  }
  check(runDirs.length === 1, 'all three picked batches landed in ONE run folder');

  const runDir = path.join(dest, runDirs[0]);
  const outs = fs.readdirSync(runDir).filter((n) => n.endsWith('.mp4')).sort();
  const dur = (n) => Math.round(Number(spawnSync(FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(runDir, n)],
    { encoding: 'utf8' }).stdout.trim()));
  console.log('outputs:', outs.map((n) => `${n} (${dur(n)}s)`).join(', '));

  check(!outs.some((n) => /selected files/i.test(n)), 'no output name leaks the "Selected files" staging folder');
  check(JSON.stringify(outs) === JSON.stringify(['C0001.mp4', 'CardB_C0001.mp4', 'CardB_C0001_2.mp4']),
    `names: C0001 / CardB_C0001 / CardB_C0001_2 (got ${outs.join(', ')})`);
  check(outs.length === 3 && dur('C0001.mp4') === 1 && dur('CardB_C0001.mp4') === 2 && dur('CardB_C0001_2.mp4') === 3,
    'each name holds the right source (by clip length)');

  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(FAIL.length ? `\n${FAIL.length} FAILED` : '\nALL PASS');
  process.exit(FAIL.length ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(2); });
