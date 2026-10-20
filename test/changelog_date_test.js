/* scripts/check-changelog-date.sh — release guard: the CHANGELOG heading for the
   version being built must carry a date (3.3.1 G3).
     · the real CHANGELOG.md has a dated heading for package.json's version
     · "## X — unreleased", no heading at all, or only an older dated heading → abort
       with a clear message; "## X — YYYY-MM-DD" passes
     · scripts/release.sh runs it next to the download-size guard, before the dmg
       is signed or notarized
   FAIL-ON-OLD (3.3.1 first build, 1e466ff): no such check — both 3.3.0 and 3.3.1
   were headed "— unreleased" and release.sh built anyway.
   Run: node test/changelog_date_test.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/check-changelog-date.sh');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-cldate-'));
const run = (version, root = ROOT) => spawnSync('sh', [SCRIPT, version, root], { encoding: 'utf8' });
const fakeRoot = (changelog) => { const r = fs.mkdtempSync(path.join(SB, 'root-')); fs.writeFileSync(path.join(r, 'CHANGELOG.md'), changelog); return r; };

try {
  check(fs.existsSync(SCRIPT), 'scripts/check-changelog-date.sh exists');
  const version = require(path.join(ROOT, 'package.json')).version;
  const real = run(version);
  check(real.status === 0 && new RegExp(`${version.replace(/\./g, '\\.')} .*\\d{4}-\\d{2}-\\d{2}`).test(real.stdout),
    `the real CHANGELOG dates ${version} (${(real.stdout + real.stderr).trim()})`);

  const head = '# Changelog\n\n';
  const ok = run('9.9.9', fakeRoot(`${head}## 9.9.9 — 2026-10-21\n\n- x\n\n## 9.9.8 — unreleased\n`));
  check(ok.status === 0, `a dated heading passes (${ok.stdout.trim()})`);
  const und = run('9.9.9', fakeRoot(`${head}## 9.9.9 — unreleased\n\n- x\n\n## 9.9.8 — 2026-10-01\n`));
  check(und.status !== 0 && /9\.9\.9/.test(und.stderr) && /no date/.test(und.stderr), `"— unreleased" aborts with a clear message (${und.stderr.trim()})`);
  const none = run('9.9.9', fakeRoot(`${head}## 9.9.8 — 2026-10-01\n`));
  check(none.status !== 0 && /no "## 9\.9\.9/.test(none.stderr), `a missing heading aborts (${none.stderr.trim()})`);
  const prefix = run('9.9.9', fakeRoot(`${head}## 9.9.90 — 2026-10-21\n`));
  check(prefix.status !== 0, 'a heading for a different version (9.9.90) does not count for 9.9.9');
  const bare = run('9.9.9', fakeRoot(`${head}## 9.9.9\n`));
  check(bare.status !== 0, 'a heading with no date part at all aborts');

  const rel = fs.readFileSync(path.join(ROOT, 'scripts/release.sh'), 'utf8');
  const iCheck = rel.search(/^sh scripts\/check-changelog-date\.sh /m);
  const iSize = rel.search(/^sh scripts\/check-download-size\.sh /m);
  const iSign = rel.search(/^codesign /m);
  check(iCheck > 0 && iSize > 0 && iSign > iCheck && Math.abs(iCheck - iSize) < 600,
    `release.sh runs the check next to the download-size guard, before signing (offsets check ${iCheck}, size ${iSize}, codesign ${iSign})`);
} catch (e) {
  console.error(e);
  FAIL.push('unexpected throw: ' + (e && e.message));
}
try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
console.log(`\n[changelog-date] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
process.exit(FAIL.length ? 1 : 0);
