/* Folder walker must not follow symlinked DIRECTORIES (a link back to its own
   folder recursed until the OS refused, counting every video ~32 times), but
   must keep following symlinked FILES — that is how staging stays zero-copy
   on SMB (stage.js).
   FAIL-ON-OLD: walkAll followed the loop, so the counts below come out huge.
   Run: node test/walker_symlink_loop_test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { scanFolder } = require(path.join(ROOT, 'src/encoder/pipeline'));
const FFMPEG = path.join(ROOT, 'resources/bin/ffmpeg');

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

(async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-walker-'));
  const src = path.join(sb, 'Footage');
  const outside = path.join(sb, 'Elsewhere');
  fs.mkdirSync(src); fs.mkdirSync(outside);
  const mk = (f) => {
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
      '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', f]);
    if (r.status !== 0) throw new Error('fixture encode failed: ' + r.stderr);
  };
  mk(path.join(src, 'a.mov'));
  mk(path.join(outside, 'c.mov'));
  fs.symlinkSync('.', path.join(src, 'loop'));                        // dir link back to itself
  fs.symlinkSync(path.join(outside, 'c.mov'), path.join(src, 'b.mov')); // file link — must be followed

  try {
    const t0 = Date.now();
    const scan = await scanFolder(src);
    const names = scan.videos.map((v) => path.relative(src, v.file)).sort();
    check(scan.videos.length === 2, `2 videos found (got ${scan.videos.length}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})`);
    check(names.filter((n) => n === 'a.mov').length === 1 && !names.some((n) => n.startsWith('loop')),
      'the real video is counted once, never via the self-link');
    check(names.includes('b.mov'), 'symlinked FILE is still followed');
    console.log(`  scan took ${Date.now() - t0}ms`);
  } finally {
    fs.rmSync(sb, { recursive: true, force: true });
  }
  if (FAIL.length) { console.error(`\n${FAIL.length} FAILED`); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
