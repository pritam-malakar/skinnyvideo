# SkinnyVideo — free video compressor for Mac, batch HEVC

[![Latest release](https://img.shields.io/github/v/release/pritam-malakar/skinnyvideo?label=download&color=5EE39B)](https://github.com/pritam-malakar/skinnyvideo/releases/latest)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)
[![Platform: macOS 11+, Apple Silicon](https://img.shields.io/badge/platform-macOS%2011%2B%20%C2%B7%20Apple%20Silicon-lightgrey)](#install)

SkinnyVideo is a free, open-source video compressor for Mac. It batch-compresses camera footage to HEVC (H.265) on Apple Silicon using a bundled FFmpeg. Drop a folder, pick one of two quality tiers, start. Compressed copies land in a new folder next to your originals. The originals are never opened for writing, moved, renamed, or deleted.

No settings to learn. No upload. No account. No paid tier.

**[Download for Mac (.dmg)](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SkinnyVideo-arm64.dmg)** · [Website](https://skinnyvideo.app) · [Releases](https://github.com/pritam-malakar/skinnyvideo/releases) · [Checksums](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SHA256SUMS)

![SkinnyVideo main window on a Mac, ready to batch-compress a folder of camera footage to HEVC](https://raw.githubusercontent.com/pritam-malakar/skinnyvideo/main/site/img/hero-main-window.png)

## Compression results on real footage

Measured on real footage, not a benchmark clip. The app reports the real figure after every batch.

| Footage | Tier | Before → after | Saved |
|---|---|---|---|
| Camera originals, Sony 4K 25p 10-bit H.264 (3 clips) | Make It Fast | 2.3 GB → 147 MB | up to 94% |
| ProRes master, one .mov | Slow But Better | 172 GB → 6.4 GB | up to 96% |
| iPhone video, already HEVC | Slow But Better | 266 MB → 62 MB | up to 77% |

Savings depend on how much the footage moves and how hard the camera already compressed it. Full methodology (machines, dates, defaults used) is on the [website](https://skinnyvideo.app/#results).

## Compress whole folders at once

1. **Drop** a folder or a pile of files. Non-video files are ignored, not errors.
2. **Pick a quality:** Make It Fast or Slow But Better. That is the only decision.
3. **Start** and walk away. Results land in a new `Compressed_YYYY-MM-DD_HHMM` folder next to the source, flat. Each file keeps its name and gets an `.mp4` extension.

## Two ways to compress: hardware HEVC or x265

**Make It Fast** (recommended) — hardware HEVC via Apple VideoToolbox. Encodes on the media engine in your Mac's chip, faster than the footage plays, and the Mac stays usable while it runs.

**Slow But Better** (archival) — software HEVC via libx265. Spends more time on every frame for a smaller file at the same visible quality. Uses more of your Mac while it runs. On fanless or lower-core Macs such as MacBook Neo it is noticeably slower, but it completes normally.

Both tiers write HEVC (H.265) as `.mp4`, tagged `hvc1` with faststart, so the files open directly in QuickTime, Premiere Pro, After Effects, and Final Cut Pro.

## Originals never touched. Nothing leaves your Mac.

- Source files are read-only. Never moved, renamed, changed, or deleted.
- Results go to a new folder. Don't like them? Trash the folder. Your masters are where they were.
- Runs entirely offline. No internet connection needed to compress, no telemetry.
- Keeps the receipts: what went in, what came out, and reclaimed totals per drive, in the History panel.

## Nerd Mode: CRF, x265 presets, VideoToolbox quality

Full encoder control for people who know exactly what they want. Settings apply per batch and reset to defaults with one click, so they are never left behind for the next user.

![SkinnyVideo Nerd Mode showing CRF, x265 preset and VideoToolbox quality controls](https://raw.githubusercontent.com/pritam-malakar/skinnyvideo/main/site/img/nerd-mode-settings.png)

| Control | Tier | Range | Default |
|---|---|---|---|
| CRF (constant quality) | Slow But Better | 0–51, lower is larger and cleaner | 18 |
| x265 preset | Slow But Better | ultrafast → veryslow, nine positions | medium |
| VideoToolbox quality | Make It Fast | 1–85; capped where the bitrate curve goes vertical | 62 |
| 10-bit → 8-bit | Both | Appears only when the batch contains a 10-bit file | off |
| Dry run | Both | Scans the batch and reports totals without writing anything | — |

Built on a self-compiled FFmpeg with x265 and VideoToolbox and nothing else bundled. The build recipe is in this repo: [`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh).

## What SkinnyVideo doesn't do

- Edit, trim, or color anything
- Run on Intel Macs
- Write ProRes, DNx, or AV1 (HEVC out only)
- Watch a folder and compress new files automatically
- Promise "no quality loss". HEVC is lossy; SkinnyVideo aims for visually identical.

## SkinnyVideo vs HandBrake

HandBrake is a full manual transcoder with hundreds of settings and a queue you build by hand. SkinnyVideo is folder-first: drop a folder, pick one of two tiers, and it handles the rest, with originals guaranteed untouched. Nerd Mode gives the settings back when you want them. If you need Intel support, non-HEVC output, filters, or subtitle handling, use HandBrake.

## Install

| | |
|---|---|
| Mac | Apple Silicon Macs, including MacBook Neo |
| macOS | 11 or later |
| Download | [`SkinnyVideo-arm64.dmg`](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SkinnyVideo-arm64.dmg), about 135 MB |
| Security | Signed with a Developer ID certificate and notarized by Apple |
| License | GPL-2.0-or-later |

Open the `.dmg`, drag SkinnyVideo to Applications, launch. No Gatekeeper warnings, no workarounds. There is no Intel build.

SkinnyVideo checks this repo's Releases for updates and offers to restart when a new version is ready.

**Verify the download** (optional):

```sh
curl -LO https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

## Build from source

```sh
git clone https://github.com/pritam-malakar/skinnyvideo.git
cd skinnyvideo
npm install
npm start
```

The bundled `ffmpeg`/`ffprobe` are produced by [`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh). Release builds (`npm run dist`) require a Developer ID certificate and notarization credentials and are documented in [CORRESPONDING-SOURCE.md](CORRESPONDING-SOURCE.md).

## Frequently asked questions

**Does it work on Intel Macs?**
No. SkinnyVideo runs only on Apple Silicon Macs, including MacBook Neo, on macOS 11 and up.

**Does it lose quality?**
HEVC is lossy, so yes, technically. Both tiers are tuned to look visually identical; Slow But Better keeps the most detail at the smallest size.

**Does it upload my videos anywhere?**
No. It runs entirely on your Mac with no internet connection and no telemetry. Your footage never leaves the machine.

**Is it safe to install?**
Yes. It's signed and notarized by Apple, open source under GPL-2.0-or-later, and every release publishes a SHA-256 checksum.

**Where do the compressed files go?**
Into a new `Compressed_YYYY-MM-DD_HHMM` folder next to your originals, as `.mp4`. The originals are never opened for writing, moved, or deleted.

**Can it compress ProRes?**
Yes. A 172 GB ProRes master came out at 6.4 GB with Slow But Better.

**Can it compress iPhone video that's already HEVC?**
Yes, with smaller gains: 266 MB to 62 MB in our test.

**Is HEVC the same as H.265?**
Yes. HEVC (High Efficiency Video Coding) and H.265 are two names for the same codec.

**How is it different from HandBrake?**
HandBrake is a full manual transcoder with hundreds of settings. SkinnyVideo is folder-first with two choices, and Nerd Mode when you want the settings back.

## License

SkinnyVideo is free software licensed under the **GNU General Public License, version 2 or later** — see [LICENSE](LICENSE).

It is GPL rather than permissive because it bundles FFmpeg built with `libx265`, which is GPL-licensed. Distributing the app therefore carries the GPL's corresponding-source obligation, which is met by attaching the FFmpeg and x265 sources to each release.

The bundled `ffmpeg`/`ffprobe` are built by this repository's own pinned recipe, [`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh) (FFmpeg + x265 + Apple VideoToolbox, nothing else), so the two documents below describe the binary that actually ships:

- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — every bundled component, its version, license and copyright notice, and the exact build configuration
- [CORRESPONDING-SOURCE.md](CORRESPONDING-SOURCE.md) — the pinned source tarballs and checksums attached to each release, and how to rebuild from them

The full license texts for everything shipped are also inside the app itself: **SkinnyVideo → Third-Party Licenses** in the menu bar opens the folder, and **About SkinnyVideo** lists the credits.

## Credits

SkinnyVideo is a thin wrapper around other people's work.

| Component | License | Upstream |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) | GPL-2.0-or-later (as built) | <https://ffmpeg.org> |
| [x265](https://www.videolan.org/developers/x265.html) | GPL-2.0-or-later | <https://bitbucket.org/multicoreware/x265_git> |
| Apple VideoToolbox | Apple system framework | <https://developer.apple.com/documentation/videotoolbox> |
| [Electron](https://www.electronjs.org) | MIT | <https://github.com/electron/electron> |
| Geist and Geist Mono | SIL Open Font License 1.1 | <https://github.com/vercel/geist-font> |
| Poppins | SIL Open Font License 1.1 | <https://github.com/itfoundry/Poppins> |

Electron embeds Chromium and Node.js, whose own third-party notices ship in the app as `LICENSES.chromium.html`.

## Author

Built by Pritam Malakar, corporate video production manager, India, for his own team. Every tool tried wanted either a terminal or a dozen decisions before it would touch a single file. So: two buttons, no settings, originals untouched.

Bugs and requests: [Issues](https://github.com/pritam-malakar/skinnyvideo/issues). If it saved you drive space, a star helps other Mac users find it.
