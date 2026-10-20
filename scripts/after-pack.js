/* electron-builder afterPack hook — closes Electron fuses on every packaged
   app, so `npm run dist` (scripts/release.sh) and any other electron-builder
   run ship fuses-closed builds. It runs before signing; electron-builder (or,
   for an unsigned build, the ad-hoc reset below) signs the flipped binary.

   SV_FUSES_OPEN=1 leaves the fuses exactly as Electron ships them. Only
   `npm run dist:test` sets it: an unsigned verification build in a scratch
   folder, never a release. Verification recipe: docs/VERIFY.md.

   EnableEmbeddedAsarIntegrityValidation is on: electron-builder 26 writes the
   ElectronAsarIntegrity hash into Info.plist, which this fuse checks at launch. */
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
};

async function closeFuses(appPath) {
  // Apple Silicon refuses a binary whose ad-hoc signature no longer matches;
  // re-sign ad-hoc after flipping (a Developer ID signing pass replaces it).
  await flipFuses(appPath, { ...FUSES, resetAdHocDarwinSignature: process.platform === 'darwin' });
}

async function afterPack(context) {
  if (process.env.SV_FUSES_OPEN === '1') {
    console.log('  • fuses left open (SV_FUSES_OPEN=1, verification build only)');
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await closeFuses(appPath);
  console.log(`  • fuses closed: ${appPath}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.FUSES = FUSES;
module.exports.closeFuses = closeFuses;
