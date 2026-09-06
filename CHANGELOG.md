# Changelog

## 3.0.1 — unreleased

- Fixed the About panel showing the app name as "Skinnyvideo". It now reads
  SkinnyVideo, matching the bundle name everywhere else.
- The disk image is now named `SkinnyVideo-arm64.dmg` rather than carrying the
  version, so `releases/latest/download/SkinnyVideo-arm64.dmg` is a permanent
  link the website can point at and never has to be edited again. The zip keeps
  its versioned name, which is what the update feed expects.
- `SHA256SUMS` now covers the release artifacts as well as the GPL source
  tarballs, so the hashes published alongside a release describe the files
  people actually download. It is written after stapling, so the dmg hash is
  the stapled one.
- The marketing site now lives in the repo at `site/`, which is the build
  output directory Cloudflare Pages serves. It is a single `index.html` with a
  self-hosted Geist font, three screenshots as PNG plus WebP, `og.png` for link
  previews, a favicon set, `robots.txt`, `sitemap.xml`, a `404.html`, and
  SoftwareApplication / FAQPage structured data. The page carries no version
  number, and all of its download links point at
  `releases/latest/download/SkinnyVideo-arm64.dmg`, so a new release needs no
  edit to the site.
- The minimum macOS version is now stated explicitly as 11.0 in the build
  config instead of being inherited from Electron's default. Same floor as
  before — 3.0.0 already shipped with `LSMinimumSystemVersion` 11.0 — but it is
  now a deliberate choice that will not move silently when Electron is
  upgraded. (Electron 38 drops Big Sur; that upgrade will need this raised
  to 12.0.)

## 3.0.0 — 2026-09-05

First public release.

- Automatic updates. SkinnyVideo checks for a new version shortly after
  launch and every six hours, downloads it in the background, and offers to
  restart once it is ready — never while a queue is running. Declining costs
  nothing: the update is applied the next time you quit.
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
