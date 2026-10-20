# Verifying a build

Every electron-builder run closes Electron's fuses through the `afterPack` hook
(`scripts/after-pack.js`, configured in `package.json` → `build.afterPack`).
That covers `npm run dist` (`scripts/release.sh`, signed and notarized) and
the unsigned build below. Only `npm run dist:test` leaves them open.

| Fuse | Release builds |
|---|---|
| RunAsNode | Disabled |
| EnableNodeOptionsEnvironmentVariable | Disabled |
| EnableNodeCliInspectArguments | Disabled |
| EnableCookieEncryption | Enabled |
| OnlyLoadAppFromAsar | Enabled |
| EnableEmbeddedAsarIntegrityValidation | Enabled (electron-builder writes `ElectronAsarIntegrity` into Info.plist) |
| LoadBrowserProcessSpecificV8Snapshot, GrantFileProtocolExtraPrivileges | unchanged from Electron's defaults |

## Builds

**Verification build, fuses open.** For debugging only (`--inspect`,
`ELECTRON_RUN_AS_NODE` work). Unsigned, not notarized, written to a scratch
folder, never shipped:

```sh
npm run dist:test          # → ${TMPDIR:-/tmp}/skinnyvideo-dist-test/
```

**Unsigned build, fuses closed.** The same build `release.sh` makes, minus
signing and notarization. Use it to check the fuses before spending a
notarization:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac --arm64 --publish never \
  -c.mac.identity=null -c.mac.notarize=false -c.directories.output="${TMPDIR:-/tmp}/skinnyvideo-dist-closed"
```

**Release build.** `npm run dist` (signs, notarizes, staples). See
`scripts/release.sh`.

## Checks on a fuses-closed build

Run these on the unsigned fuses-closed build, and again on the signed
release build before publishing it.

1. **Fuses.**

   ```sh
   npx @electron/fuses read --app <dist>/mac-arm64/SkinnyVideo.app
   SV_APP=<dist>/mac-arm64/SkinnyVideo.app node test/fuses_test.js
   ```

   Expect the table above. `test/fuses_test.js` fails on any other state.

2. **Launches from the dmg**, with a throwaway profile and update checks off,
   so your real prefs and history are never touched:

   ```sh
   hdiutil attach -nobrowse -readonly <dist>/SkinnyVideo-arm64.dmg      # note the /Volumes/… path
   mkdir -p /tmp/sv-verify/userData && echo '{"autoUpdateCheck":false}' > /tmp/sv-verify/userData/prefs.json
   "/Volumes/<volume>/SkinnyVideo.app/Contents/MacOS/SkinnyVideo" --user-data-dir=/tmp/sv-verify/userData
   ```

   The window must open and show the drop area. A build whose asar fails the
   integrity check quits at once instead.

3. **Smoke encode.** In that window, choose an Output folder under
   `/tmp/sv-verify`, drop one short clip (a copy, never an original you care
   about), click Add batch, then Start. Watch the run log until the `OK` line
   appears:

   ```sh
   tail -f /tmp/sv-verify/<Output>/Compressed_*/compress.log     # wait for: OK <clip> -> … saved=…
   ```

4. **Update feed.** `<dist>/latest-mac.yml` must exist and keep its usual
   shape: `version`, a `files` list with the zip and the dmg (each with
   `sha512` and `size`), `path`, `sha512`, `releaseDate`. Compare its keys with
   the previous release's feed; fuses do not change it. (`release.sh` repoints
   the dmg entry after stapling, and refuses to continue if the feed is missing.)

5. Quit the app, `hdiutil detach /Volumes/<volume>`, delete `/tmp/sv-verify`.
