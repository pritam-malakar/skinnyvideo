#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# SkinnyVideo release build — the ONLY path that produces a mac artifact.
#
# Signed with Developer ID, hardened runtime, notarized and stapled. The whole
# point of this script is that it is LOUD: there is no code path that yields an
# unnotarized artifact. Missing credentials abort before electron-builder is
# ever invoked, so dist/ is left untouched rather than filled with a build that
# merely looks finished.
#
# WHY the notarization is here and not in electron-builder's config: with
# `mac.notarize: true` but no APPLE_API_* in the environment, electron-builder
# 25.x logs a warning, skips notarization and still exits 0 (see
# app-builder-lib macPackager.js getNotarizeOptions -> "skip silently"). That
# failure mode is invisible in CI and ships an unnotarized app. The guard below
# removes it.
#
# electron-builder also notarizes the .app ONLY — never the disk image. The dmg
# is a separate container needing its own ticket, hence the explicit submit +
# staple below. The zip needs nothing: stapler cannot staple a zip archive, and
# it does not need to, because it contains the already-stapled .app.
#
# ── WHEN A `publish` BLOCK IS ADDED LATER ────────────────────────────────────
# latest-mac.yml must be produced AFTER the staple step. Stapling REWRITES the
# dmg, so its size and sha512 change. If electron-builder's own publish step
# runs as part of the build (before the staple below), the hashes it records in
# latest-mac.yml describe the pre-staple file and every auto-update check will
# fail its integrity check. Build with `--publish never`, staple, and only then
# generate/upload latest-mac.yml — the same ordering reason the blockmap is
# regenerated at the end of this script.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE="$HOME/.appstoreconnect/skinnyvideo.env"
DIST_DIR="dist"

# ── 1. Credentials gate — before ANY build work ──────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "release: notarization credentials missing — expected $ENV_FILE (must export APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER). Refusing to build, because an unnotarized release artifact must never be produced." >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$ENV_FILE"

for var in APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    echo "release: $ENV_FILE did not set $var. Refusing to build." >&2
    exit 1
  fi
done

if [ ! -f "$APPLE_API_KEY" ]; then
  echo "release: App Store Connect key file not found at $APPLE_API_KEY. Refusing to build." >&2
  exit 1
fi

# ── 2. Build ─────────────────────────────────────────────────────────────────
echo "release: building (Developer ID + hardened runtime + notarize)…"
./node_modules/.bin/electron-builder --mac --arm64

# ── 3. Locate exactly one dmg ────────────────────────────────────────────────
dmg_count=$(find "$DIST_DIR" -maxdepth 1 -name '*.dmg' | wc -l | tr -d ' ')
if [ "$dmg_count" -eq 0 ]; then
  echo "release: no .dmg found in $DIST_DIR/ after the build." >&2
  exit 1
fi
if [ "$dmg_count" -gt 1 ]; then
  echo "release: expected exactly one .dmg in $DIST_DIR/, found $dmg_count:" >&2
  find "$DIST_DIR" -maxdepth 1 -name '*.dmg' >&2
  exit 1
fi
DMG=$(find "$DIST_DIR" -maxdepth 1 -name '*.dmg')
echo "release: notarizing $DMG"

# ── 4. Notarize the dmg (electron-builder did the .app, not this) ────────────
# Capture the submission id even when notarytool exits non-zero, so the log can
# be fetched for a rejection.
set +e
submit_out=$(xcrun notarytool submit "$DMG" \
  --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" \
  --wait --output-format json 2>&1)
submit_rc=$?
set -e

echo "$submit_out"

# node is guaranteed present (this runs as an npm script); python3 is not.
json_field() {
  printf '%s' "$submit_out" | node -e '
    let s = "";
    process.stdin.on("data", d => (s += d));
    process.stdin.on("end", () => {
      try { process.stdout.write(String(JSON.parse(s)[process.argv[1]] ?? "")); }
      catch { process.stdout.write(""); }
    });' "$1" 2>/dev/null || true
}
sub_id=$(json_field id)
status=$(json_field status)

if [ "$submit_rc" -ne 0 ] || [ "$status" != "Accepted" ]; then
  echo "release: notarization did not succeed (status='${status:-unknown}', exit=$submit_rc)." >&2
  if [ -n "$sub_id" ]; then
    echo "release: notarytool log for submission $sub_id:" >&2
    xcrun notarytool log "$sub_id" \
      --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" >&2 || true
  else
    echo "release: could not determine a submission id; see the output above." >&2
  fi
  exit 1
fi

# ── 5. Staple + validate ─────────────────────────────────────────────────────
echo "release: stapling $DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

# ── 6. Regenerate the blockmap — the staple rewrote the dmg ──────────────────
# electron-builder computed the .dmg.blockmap BEFORE the staple above, so the
# one on disk describes a file that no longer exists byte-for-byte. Same
# invocation electron-builder uses (app-builder-lib createBlockmap):
#   app-builder blockmap --input <file> --output <file>.blockmap
BLOCKMAP="$DMG.blockmap"
APP_BUILDER=$(node -e 'process.stdout.write(require("app-builder-bin").appBuilderPath)' 2>/dev/null || true)
if [ -n "$APP_BUILDER" ] && [ -x "$APP_BUILDER" ]; then
  echo "release: regenerating $BLOCKMAP post-staple"
  "$APP_BUILDER" blockmap --input "$DMG" --output "$BLOCKMAP" >/dev/null
else
  if [ -f "$BLOCKMAP" ]; then
    rm -f "$BLOCKMAP"
    echo "release: WARNING — could not locate the app-builder binary to regenerate the blockmap; deleted the stale $BLOCKMAP rather than leave an incorrect one on disk." >&2
  fi
fi

# ── 7. Report ────────────────────────────────────────────────────────────────
echo
echo "release: artifacts in $DIST_DIR/"
find "$DIST_DIR" -maxdepth 1 -type f \
  \( -name '*.dmg' -o -name '*.zip' -o -name '*.blockmap' \) \
  -exec ls -lh {} \; | awk '{printf "  %-46s %s\n", $NF, $5}'
echo
echo "release: done — signed, notarized and stapled."
