# Changelog

## 3.2.1 — 2026-09-18

- The update offer is now a native dialog on the window rather than a bar
  inside the page. Same three choices — Download, Skip This Version, Later —
  and the same rules behind them: nothing downloads until you pick Download, a
  skipped version is never offered again, and Later asks again next launch. An
  update found while a queue is running still waits until the queue finishes.
  The "Check for updates automatically" checkbox is unchanged, and so is the
  Restart / Later dialog shown after a download.
- Dropping several folders at once, or a folder together with loose files, now
  stages every video found inside them. Before, two folders dropped together
  showed the right count but could not be added to the queue at all, and a
  folder dropped with loose files lost the folder's clips — only the loose
  files were compressed.
- A finished file whose final rename fails (for example because the output
  folder became read-only) now stays tracked as an unfinished partial, so the
  next launch still offers to clean it up. It used to drop out of tracking and
  be left behind.

## 3.2.0 — 2026-09-17

- **Requires macOS 13 or later.** SkinnyVideo now runs on the current Electron,
  which needs macOS 13. If you're on macOS 11 or 12, 3.1.0 keeps working and
  won't be offered this update.
- Your Mac stays awake while a batch runs. No more overnight queues that stall
  because the Mac dozed off.
- Safer cleanup. SkinnyVideo now tracks exactly which temporary files it
  created and only ever removes those. A source file with `.tmp` in its name is
  no longer mistaken for an unfinished encode.
- Folder shortcuts that loop are skipped, so the same video can't be counted or
  compressed many times.
- Small wording fix. The Make It Fast tier is now tagged "Regular" instead of
  "Recommended".
- Under the hood: Electron 44, renderer sandbox on, stricter checks on
  everything the window asks the app to do.

## 3.1.0 — 2026-09-17

- Nothing gets skipped anymore. If a folder has `C0001.MP4` and `C0001.MOV`,
  older versions quietly skipped the second one. Now both are compressed.
- Clearer names when files clash. Same name in different folders → the folder
  name goes in front (`B_C0001.mp4`). Same name, different extension → the
  extension is added (`C0001_mov.mp4`). One rule everywhere.
- Updates now ask first. SkinnyVideo tells you when a new version is available
  and only downloads when you click. You can turn the check off entirely
  (bottom-right of the window). "Later" no longer installs on quit.
- Honest wording. Compression runs entirely on your Mac and your videos never
  leave it. The app's only internet use is this optional update check.

## 3.0.2 — 2026-09-07

- The release script now clears the previous run's artifacts from `dist/`
  before building. The disk image name carries no version, so it overwrote
  cleanly, but the zip does — a version bump left the old zip behind, the
  update-feed step then matched two zips at once, and the build died after
  notarization and stapling had already been spent. Named globs only; the
  unpacked app directory and the sha256-pinned source tarballs are left alone.
- The disk image is now signed with the Developer ID certificate, not only
  notarized and stapled. A stapled ticket was enough for Gatekeeper on first
  open, but the container itself carried no signature, so it failed
  `spctl --assess --context context:primary-signature` and had nothing
  attesting to it once the quarantine bit was gone. Signing happens before
  notarization; stapling, the blockmap and the update feed still follow.
- History rows no longer disagree with themselves about how many files a run
  held — "C0038.mov + 12 more · 12 videos". The name and the count came from
  different populations at different moments: the suffix was frozen when the
  files were dropped and counted everything dropped, including files that
  were not video and files that later failed or were skipped, while the count
  came from the files that actually finished. The row now stores a bare name
  and derives the suffix from the one count in the record. Existing history
  is migrated on read, with nothing to do by hand.

## 3.0.1 — 2026-09-06

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
