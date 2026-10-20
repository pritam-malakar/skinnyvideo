# Changelog

## 3.3.0 — unreleased

- **Every audio track is kept.** A file with more than one audio track (two
  microphones, a camera's second channel pair, an iPhone ProRes clip's extra
  track) used to come out with only one of them, without any warning. Now
  every track is kept, in its original order and with its own channel count:
  a 5.1 track stays 5.1, and two mono tracks stay two mono tracks. AAC, ALAC,
  AC-3 and E-AC-3 tracks are copied unchanged; any other audio (PCM, FLAC,
  Opus, MP3, DTS, TrueHD, MP2, Vorbis) is converted to AAC at 320 kb/s per
  track. A track SkinnyVideo can't read is left out with a `DROPPED-AUDIO`
  line in the run log and a NOTE on the file's row; the file still
  compresses.
- After each encode the output's audio tracks are counted against the
  source's. If one is missing, the file is marked failed (`TRACKS` in the run
  log) instead of being accepted.
- **Start timecode is carried to the output.** Sony XAVC clips keep their
  timecode outside the picture track and used to lose it; it now survives,
  along with timecode from iPhone, ProRes and other sources. The run log notes
  it as `TIMECODE`.
- **12-bit sources come out 10-bit.** ProRes 4444 and other 12-bit footage
  used to come out 8-bit in Make It Fast. Every source deeper than 8 bits is
  now encoded as 10-bit HEVC (Main 10) in both tiers, unless 10-bit → 8-bit is
  on in Nerd Mode (which now also appears for 12-bit batches).
- **Video with transparency compresses in both tiers.** The alpha channel is
  dropped on purpose, with a `NOTE … alpha channel discarded` line in the run
  log and a NOTE on the file's row. Slow But Better used to fail these files.
- **The HDR chip tells the truth.** It used to say HDR10 mastering display
  and content light values were dropped; both tiers keep them, so HDR10 files
  no longer get a chip. Dolby Vision files get a "Dolby Vision" chip that says
  exactly what was dropped: the configuration record in both tiers, and the
  per-frame data as well in Slow But Better.
- **A finished file is no longer thrown away after a crash.** If the app quit
  between finishing a file and giving it its final name, the leftover
  `.tmp.mp4` is complete. On the next launch SkinnyVideo now checks each
  leftover against its original's length and offers **Keep** (rename it to its
  normal name, `RECOVERED` in the run log) or Delete. Incomplete leftovers are
  offered for deletion only, as before.
- **"Drop anywhere" now means anywhere.** Files dropped anywhere on the
  window are staged exactly as if they were dropped on the drop area,
  including while a run is going. Before, only the drop area accepted them.
- Motion-JPEG video (older cameras and webcams) is now compressed. It used to
  be skipped as "not a video". Cover art is still ignored.

## 3.2.2 — 2026-10-15

- **Stop after current file now works while a batch is paused.** Before, Stop
  on a paused batch waited forever for a file that couldn't move. Now the
  paused file resumes, finishes, and the run stops. Pause isn't offered again
  once a stop is on its way. Quitting while paused also resumes the encoder
  before ending it.
- A stopped batch now says **Stopped** (in the Stop button's orange) instead of
  Done. Its files that never began read **Not started** and get their own
  count in the run summary. They used to be reported as failed.
- **A shorter-than-source output is no longer accepted as finished.** If a
  source ends early (still copying, damaged, or unreadable partway), the
  encoder can still report success. SkinnyVideo now compares the length of the
  picture in the output with the source. If the output is more than 1 second
  (or 2%) short, the file is marked failed ("output shorter than source"), the
  short file is removed, and the original goes to `_FAILED/` as usual.
- Decoder errors on a file that otherwise finished are now written to the run
  log as a `WARN` line, so a damaged source leaves a trace.
- **Files still being copied are left alone.** If a source changed size since
  the scan and is still changing two seconds later, it's skipped with "file was
  still being written". Compressing a half-copied file used to produce a short
  output.
- A scan no longer picks up SkinnyVideo's own output. When the output folder
  sits inside the folder being compressed, earlier `Compressed_…` run folders
  and unfinished `.tmp.mp4` files are skipped, and the staging line and run
  log say how many. Files you pick yourself are always honoured.
- The run summary now covers only the run that just finished. Batches left in
  the queue from an earlier run no longer add to its done, failed, or batch
  counts.
- Browse now accepts folders as well as files, in the same picker. Picking one
  folder works exactly like dropping it, and the picker reopens where you left
  off.
- The cleanup prompt for leftover unfinished files now calls them
  "incomplete". It used to say they "can't be played", which isn't always true.
- A long pause no longer counts toward the stuck-encoder timeout, so a slow
  network drive can't make the watchdog end a file right after you resume.

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
