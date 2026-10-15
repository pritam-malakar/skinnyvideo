/* scripts/check-download-size.sh — the release guard that keeps the published
   "about NNN MB" honest. Sparse files stand in for the dmg (no disk used).
     · the real README.md + site/ agree on one figure, and the v3.2.1 dmg size
       (165,926,231 bytes) passes against it
     · up to published + 10 MB passes; one byte more aborts with a clear message
     · README and site disagreeing, or no figure at all, aborts
   Run: node test/download_size_test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/check-download-size.sh');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-dlsize-'));

const dmgOf = (bytes) => { const p = path.join(SB, `fake-${bytes}.dmg`); fs.closeSync(fs.openSync(p, 'w')); fs.truncateSync(p, bytes); return p; };
const run = (dmg, root = ROOT) => spawnSync('sh', [SCRIPT, dmg, root], { encoding: 'utf8' });
const fakeRoot = (readme, site) => {
  const r = fs.mkdtempSync(path.join(SB, 'root-'));
  fs.mkdirSync(path.join(r, 'site'));
  fs.writeFileSync(path.join(r, 'README.md'), readme);
  fs.writeFileSync(path.join(r, 'site', 'index.html'), site);
  return r;
};

try {
  const figures = [path.join(ROOT, 'README.md'), path.join(ROOT, 'site/index.html')]
    .map((f) => (fs.readFileSync(f, 'utf8').match(/about (\d+) MB/) || [])[1]);
  check(figures[0] === '170' && figures[1] === '170', `README and site both publish "about 170 MB" (${figures})`);

  const v321 = run(dmgOf(165926231));
  check(v321.status === 0 && /download size ok/.test(v321.stdout), `the v3.2.1 dmg (165,926,231 bytes) passes (${v321.stdout.trim()})`);
  check(run(dmgOf(180000000)).status === 0, 'exactly published + 10 MB passes');
  const over = run(dmgOf(180000001));
  check(over.status !== 0 && /more than 10 MB over the published "about 170 MB"/.test(over.stderr),
    `one byte over published + 10 MB aborts with a clear message (${over.stderr.trim()})`);

  const split = run(dmgOf(100), fakeRoot('a download, about 170 MB', '<span>.dmg, about 135 MB</span>'));
  check(split.status !== 0 && /disagree/.test(split.stderr), `README and site disagreeing aborts (${split.stderr.trim()})`);
  const none = run(dmgOf(100), fakeRoot('no size here', '<p>nothing</p>'));
  check(none.status !== 0 && /no "about NNN MB"/.test(none.stderr), 'no published figure aborts');

  const real = path.join(ROOT, 'dist', 'SkinnyVideo-arm64.dmg');
  if (fs.existsSync(real)) check(run(real).status === 0, `the dmg in dist/ (${fs.statSync(real).size} bytes) passes`);
} catch (e) {
  FAIL.push('unexpected throw: ' + e.message); console.error(e);
}
fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n[download-size] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
process.exit(FAIL.length ? 1 : 0);
