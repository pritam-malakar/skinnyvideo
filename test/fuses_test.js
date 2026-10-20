/* 3.3.0 Item 8 — Electron fuses are closed on every packaged build.

   HOOK   scripts/after-pack.js (electron-builder afterPack, configured in
          package.json) run on an APFS clone of node_modules' Electron.app:
          fuses read back RunAsNode, EnableNodeOptionsEnvironmentVariable,
          EnableNodeCliInspectArguments = off; EnableCookieEncryption,
          OnlyLoadAppFromAsar, EnableEmbeddedAsarIntegrityValidation = on; the
          clone still passes `codesign --verify` (ad-hoc re-sign) — and
          SV_FUSES_OPEN=1 leaves them untouched.
   CONFIG package.json build.afterPack points at the hook; `dist:test` sets
          SV_FUSES_OPEN=1, builds unsigned into a scratch folder, never notarizes.
   BUILT  if SV_APP names a built .app (e.g. the unsigned dist from
          docs/VERIFY.md), its fuses are read and asserted too.

   FAIL-ON-OLD (3.2.2): no hook, no afterPack config — the 3.2.2 release had
   RunAsNode, NODE_OPTIONS and --inspect open and asar checks off.
   Run: node test/fuses_test.js   (SV_APP=/path/SkinnyVideo.app to check a build) */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASS = [], FAIL = [];
const check = (c, l) => { (c ? PASS : FAIL).push(l); console.log((c ? 'PASS' : 'FAIL') + ': ' + l); };
const SB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-fuses-')));

const WANT = { RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableCookieEncryption: true, OnlyLoadAppFromAsar: true, EnableEmbeddedAsarIntegrityValidation: true };

async function readFuses(app) {
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
  const wire = await getCurrentFuseWire(app);
  const out = {};
  for (const k of Object.keys(WANT)) out[k] = wire[FuseV1Options[k]] === '1'.charCodeAt(0);   // FuseState.ENABLE
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    check(pkg.build && pkg.build.afterPack === 'scripts/after-pack.js', `package.json build.afterPack → scripts/after-pack.js (${pkg.build && pkg.build.afterPack})`);
    const dt = (pkg.scripts && pkg.scripts['dist:test']) || '';
    check(/SV_FUSES_OPEN=1/.test(dt) && /mac\.identity=null/.test(dt) && /notarize=false/.test(dt) && /directories\.output=/.test(dt) && !/release\.sh/.test(dt),
      `dist:test is an unsigned, un-notarized, fuses-open build to a scratch folder (${dt})`);
    check(pkg.scripts.dist === 'sh scripts/release.sh', 'npm run dist is still release.sh (fuses-closed via the hook)');

    const electronApp = path.join(ROOT, 'node_modules/electron/dist/Electron.app');
    if (!fs.existsSync(electronApp)) { console.log('SKIP HOOK: node_modules/electron/dist/Electron.app missing'); }
    else {
      const hook = require(path.join(ROOT, 'scripts/after-pack.js'));
      const before = await readFuses(electronApp);
      check(before.RunAsNode === true, `stock Electron ships RunAsNode open (${JSON.stringify(before)})`);
      // closed
      const out = path.join(SB, 'closed'); fs.mkdirSync(out);
      execFileSync('cp', ['-cR', electronApp, path.join(out, 'SkinnyVideo.app')]);
      await hook({ appOutDir: out, packager: { appInfo: { productFilename: 'SkinnyVideo' } } });
      const after = await readFuses(path.join(out, 'SkinnyVideo.app'));
      check(same(after, WANT), `hook closes the fuses (${JSON.stringify(after)})`);
      const v = spawnSync('codesign', ['--verify', '--deep', '--strict', path.join(out, 'SkinnyVideo.app')], { encoding: 'utf8' });
      check(v.status === 0, `flipped app still has a valid (ad-hoc) signature (${(v.stderr || '').trim().slice(0, 200)})`);
      // open
      const outO = path.join(SB, 'open'); fs.mkdirSync(outO);
      execFileSync('cp', ['-cR', electronApp, path.join(outO, 'SkinnyVideo.app')]);
      process.env.SV_FUSES_OPEN = '1';
      await hook({ appOutDir: outO, packager: { appInfo: { productFilename: 'SkinnyVideo' } } });
      delete process.env.SV_FUSES_OPEN;
      check(same(await readFuses(path.join(outO, 'SkinnyVideo.app')), before), 'SV_FUSES_OPEN=1 leaves the fuses as Electron ships them');
    }

    if (process.env.SV_APP) {
      const got = await readFuses(process.env.SV_APP);
      check(same(got, WANT), `built app ${process.env.SV_APP}: fuses closed (${JSON.stringify(got)})`);
    }
  } catch (e) {
    console.error(e);
    FAIL.push('unexpected throw: ' + (e && e.message));
  }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  console.log(`\n[fuses] PASS: ${PASS.length} FAIL: ${FAIL.length}`);
  process.exit(FAIL.length ? 1 : 0);
})();
