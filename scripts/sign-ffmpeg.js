'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   electron-builder afterPack hook — ad-hoc sign the BUNDLED ffmpeg/ffprobe.

   WHY: the app ships its own ffmpeg/ffprobe in Contents/Resources/bin. On
   Apple Silicon an UNSIGNED Mach-O is SIGKILLed by the kernel the moment it's
   exec'd ("code signature invalid" / killed: 9). The whole app is built with
   identity:null (no Developer ID), so electron-builder does NOT sign these
   inner binaries — without this hook a re-vendored (unsigned) ffmpeg would
   launch fine on the build machine's cached copy yet die on a clean install.
   Making the ad-hoc signature part of the BUILD (not a manual step baked into
   the committed binary) guarantees every produced .app has a signed engine.

   `codesign --force --sign -` applies an ad-hoc signature (no identity needed),
   which is sufficient for arm64 to exec the binary. Throws (fails the build)
   if signing or verification fails — a silently-unsigned engine must never ship.
   ───────────────────────────────────────────────────────────────────────── */
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function signFfmpeg(context) {
  // macOS only — the engine binaries are mac arm64.
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const binDir = path.join(appPath, 'Contents', 'Resources', 'bin');

  for (const name of ['ffmpeg', 'ffprobe']) {
    const bin = path.join(binDir, name);
    // Ad-hoc sign (force = replace any existing signature).
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', bin], { stdio: 'inherit' });
    // Verify it took — fail the build otherwise.
    execFileSync('codesign', ['--verify', '--strict', bin], { stdio: 'inherit' });
    console.log(`  • ad-hoc signed bundled ${name}`);
  }
};
