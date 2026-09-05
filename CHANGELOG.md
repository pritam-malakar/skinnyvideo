# Changelog

## 3.0.0 — 2026-09-05

First public release.

- Builds are now Developer ID signed, hardened-runtime, notarized and stapled.
- Licensed under the GNU GPL v2 or later; bundled component credits are now in
  the About panel and a Third-Party Licenses folder inside the app.
- The bundled ffmpeg/ffprobe are now built by the project itself from pinned
  upstream sources (FFmpeg 8.1.2 + x265 4.2 + Apple VideoToolbox, nothing
  else) via `scripts/build-ffmpeg.sh`, replacing a third-party prebuilt of
  unknown provenance. Same tiers, same commands, same output; the binaries are
  38% smaller and the ~20 unused libraries are gone. Every release now ships
  the exact corresponding source (`CORRESPONDING-SOURCE.md`,
  `THIRD-PARTY-NOTICES.md`).

## 2.11.0

- Renamed Squeeze to SkinnyVideo. Existing preferences and history migrate
  automatically on first launch.
