/* The Electron 44 OS floor reaches the update feed, and electron-updater obeys it.
   rewrite-update-feed.js stamps minimumSystemVersion "22.0.0" (Darwin 22 = macOS 13)
   into a real-shaped latest-mac.yml; the yml is parsed with the same js-yaml the
   updater uses, then fed to electron-updater's OWN isUpdateAvailable →
   checkIfUpdateSupported with os.release() stubbed. macOS 12 (Darwin 21.6.0)
   must be refused; macOS 13 (Darwin 22.6.0) must be offered.
   Run: node test/update_feed_min_os_test.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
// electron-updater nests its own semver; SemVer objects don't cross instances.
const semver = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] }));
const { AppUpdater } = require('electron-updater/out/AppUpdater');

const FAIL = [];
const check = (c, l) => { if (!c) FAIL.push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-feed-'));
  const dmg = path.join(dir, 'SkinnyVideo-arm64.dmg');
  const zip = path.join(dir, 'SkinnyVideo-9.9.9-arm64-mac.zip');
  fs.writeFileSync(dmg, 'dmg bytes');
  fs.writeFileSync(zip, 'zip bytes');
  const sha = (f) => require('crypto').createHash('sha512').update(fs.readFileSync(f)).digest('base64');
  const yml = path.join(dir, 'latest-mac.yml');
  fs.writeFileSync(yml, [
    'version: 9.9.9',
    'files:',
    `  - url: ${path.basename(zip)}`, `    sha512: ${sha(zip)}`, `    size: ${fs.statSync(zip).size}`,
    `  - url: ${path.basename(dmg)}`, '    sha512: stale', '    size: 1',
    `path: ${path.basename(zip)}`, `sha512: ${sha(zip)}`, "releaseDate: '2026-09-17T00:00:00.000Z'", ''
  ].join('\n'));

  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/rewrite-update-feed.js'), yml, dmg, zip]);
  // Run twice: the stamp must replace, not duplicate.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts/rewrite-update-feed.js'), yml, dmg, zip]);
  const text = fs.readFileSync(yml, 'utf8');
  check((text.match(/^minimumSystemVersion:/gm) || []).length === 1, 'feed carries exactly one minimumSystemVersion');
  const info = yaml.load(text);
  check(info.minimumSystemVersion === '22.0.0', `parsed minimumSystemVersion is "22.0.0" (got ${JSON.stringify(info.minimumSystemVersion)})`);

  // Real AppUpdater methods on a minimal receiver — no Electron app needed.
  const logs = [];
  const updater = Object.create(AppUpdater.prototype);
  Object.assign(updater, {
    currentVersion: semver.parse('3.1.0'),
    allowDowngrade: false,
    _logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    _isUserWithinRollout: () => true,
  });
  updater._isUpdateSupported = (i) => updater.checkIfUpdateSupported(i);

  const realRelease = os.release;
  try {
    os.release = () => '21.6.0';   // macOS 12 Monterey
    check(await updater.isUpdateAvailable(info) === false, 'Darwin 21.6.0 (macOS 12): update skipped');
    check(logs.some((m) => /less than the minimum OS version required 22\.0\.0/.test(m)), 'skip was logged by checkIfUpdateSupported');
    os.release = () => '22.6.0';   // macOS 13 Ventura
    check(await updater.isUpdateAvailable(info) === true, 'Darwin 22.6.0 (macOS 13): update offered');
  } finally {
    os.release = realRelease;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (FAIL.length) { console.error(`\n${FAIL.length} FAILED`); process.exit(1); }
  console.log('\nALL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
