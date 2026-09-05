#!/bin/bash
# scripts/fetch-corresponding-source.sh — assemble the GPL §3 corresponding
# source for the bundled ffmpeg/ffprobe into dist/corresponding-source/.
#
# Downloads the two pinned source tarballs (the SAME pins scripts/build-ffmpeg.sh
# builds from — read from that file so they cannot drift), verifies their
# sha256, and copies the build script alongside. Any hash mismatch is fatal.
# Run by scripts/release.sh at the end of every release build; safe to run
# standalone.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_SCRIPT="$ROOT/scripts/build-ffmpeg.sh"
DEST="${1:-$ROOT/dist/corresponding-source}"

[[ -f "$BUILD_SCRIPT" ]] || { echo "fetch-corresponding-source: $BUILD_SCRIPT not found" >&2; exit 1; }

# Single source of truth for the pins: the build script's own variables.
eval "$(grep -E '^(FFMPEG|X265)_(VERSION|URL|SHA256)=' "$BUILD_SCRIPT")"
for v in FFMPEG_VERSION FFMPEG_URL FFMPEG_SHA256 X265_VERSION X265_URL X265_SHA256; do
  [[ -n "${!v:-}" ]] || { echo "fetch-corresponding-source: could not read $v from build-ffmpeg.sh" >&2; exit 1; }
done

mkdir -p "$DEST"

fetch() { # fetch <url> <dest> <sha256>
  local url="$1" dest="$2" want="$3" have
  if [[ -f "$dest" ]]; then
    have="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [[ "$have" == "$want" ]]; then echo "  ok (cached)  $(basename "$dest")  $have"; return; fi
    rm -f "$dest"
  fi
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  have="$(shasum -a 256 "$dest" | awk '{print $1}')"
  if [[ "$have" != "$want" ]]; then
    rm -f "$dest"
    echo "fetch-corresponding-source: sha256 MISMATCH for $(basename "$dest")" >&2
    echo "  expected $want" >&2
    echo "  got      $have" >&2
    exit 1
  fi
  echo "  ok           $(basename "$dest")  $have"
}

echo "corresponding source -> $DEST"
fetch "$FFMPEG_URL" "$DEST/ffmpeg-${FFMPEG_VERSION}.tar.xz" "$FFMPEG_SHA256"
fetch "$X265_URL"   "$DEST/x265_${X265_VERSION}.tar.gz"    "$X265_SHA256"
cp "$BUILD_SCRIPT" "$DEST/build-ffmpeg.sh"
cp "$ROOT/CORRESPONDING-SOURCE.md" "$DEST/CORRESPONDING-SOURCE.md"
shasum -a 256 "$DEST/ffmpeg-${FFMPEG_VERSION}.tar.xz" "$DEST/x265_${X265_VERSION}.tar.gz" "$DEST/build-ffmpeg.sh" \
  | sed "s|$DEST/||" > "$DEST/SHA256SUMS"
echo "  ok           build-ffmpeg.sh, CORRESPONDING-SOURCE.md, SHA256SUMS"
