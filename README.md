# SkinnyVideo — free video compressor for Mac, batch HEVC

[![Latest release](https://img.shields.io/github/v/release/pritam-malakar/skinnyvideo?label=download&color=5EE39B)](https://github.com/pritam-malakar/skinnyvideo/releases/latest)
[![License: GPL-2.0-or-later](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)](LICENSE)
[![Platform: macOS 13+, Apple Silicon](https://img.shields.io/badge/platform-macOS%2013%2B%20%C2%B7%20Apple%20Silicon-lightgrey)](#install)

SkinnyVideo is a free, open-source video compressor for Mac. It batch-compresses camera footage to HEVC (H.265) on Apple Silicon using a bundled FFmpeg. Drop a folder, pick one of two quality tiers, start. You choose an Output folder, and each run creates a new `Compressed_YYYY-MM-DD_HHMM` folder inside it. The originals are never opened for writing, moved, renamed, or deleted.

No settings to learn. Your videos never leave your Mac. No account. No paid tier.

**[Download for Mac (.dmg)](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SkinnyVideo-arm64.dmg)** · [Website](https://skinnyvideo.app) · [Releases](https://github.com/pritam-malakar/skinnyvideo/releases) · [Checksums](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SHA256SUMS)

![SkinnyVideo main window on a Mac, ready to batch-compress a folder of camera footage to HEVC](https://raw.githubusercontent.com/pritam-malakar/skinnyvideo/main/site/img/hero-main-window.png)

## Compression results on real footage

Measured on real footage, not a benchmark clip. The app reports the real figure after every batch.

| Footage | Tier | Before → after | Saved |
|---|---|---|---|
| Sony XAVC 4K: 10-bit 4:2:2, 4:2:0, and a 62 s 10-bit 4:2:2 clip | Make It Fast | 67 MB → 2.1 MB (96.8%) · 134 MB → 6.3 MB (95.3%) · 1.21 GB → 94.7 MB (92.2%) | 92–97% on Sony XAVC 4K |
| ProRes 422 HQ master (the website demo clip) | Slow But Better | 593 MB → 13.3 MB | 97.8% |
| iPhone video, already HEVC | Make It Fast / Slow But Better | iPhone 12 SDR 68% / 24% · iPhone 12 HLG 26% / 44% · iPhone 4K60 4:2:2 clip 75% / 85% · second iPhone 4K60 4:2:2 clip 17% / 47% | about 17–85%, depending on the clip |

The big savings come from camera codecs — XAVC, Canon H.264, ProRes — not from phone HEVC: phone footage is already HEVC, so there is less left to remove, and there is no single number for phone video. Savings depend on how much the footage moves and how hard the camera already compressed it.

Measured on an Apple M2 Pro with the bundled FFmpeg; method and script in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Compress whole folders at once

1. **Drop** a folder or a pile of files, anywhere on the window. Non-video files are ignored, not errors.
2. **Pick a quality:** Make It Fast or Slow But Better. That is the only decision.
3. **Start** and walk away. Results land in a new `Compressed_YYYY-MM-DD_HHMM` folder inside the Output folder you chose, flat. Each file keeps its name. If two would clash, the folder name is added in front. Every output is an `.mp4`.

## Two ways to compress: hardware HEVC or x265

**Make It Fast** (Regular) — hardware HEVC via Apple VideoToolbox. Encodes on the media engine in your Mac's chip, and the Mac stays usable while it runs. On an M2 Pro, 4K 25p Sony XAVC encodes at about 2× real time; 4K60 4:2:2 phone footage runs just under real time. It often gives the smaller file: on 6 of the 11 clips we measured.

**Slow But Better** (archival) — software HEVC via libx265. Spends several times longer per frame to keep fine detail — grain, texture, gradients — that fast hardware encoding smooths away. File size lands either side of Make It Fast's, and is sometimes larger: from about a third to nearly four times its size on the clips we measured. Uses more of your Mac while it runs. On 4K it is several times slower than real time. On fanless or lower-core Macs such as MacBook Neo it is noticeably slower, but it completes normally.

Both tiers write HEVC (H.265) as `.mp4`, tagged `hvc1` with faststart, so the files open directly in QuickTime, Premiere Pro, After Effects, and Final Cut Pro.

## Originals never touched. Your videos never leave your Mac.

- Source files are read-only. Never moved, renamed, changed, or deleted.
- Results go to a new folder. Don't like them? Trash the folder. Your masters are where they were.
- Compression runs entirely on your Mac, with no telemetry. The app's only internet use is an optional check for new versions on GitHub, which you can turn off.
- Keeps the receipts: what went in, what came out, and reclaimed totals per drive, in the History panel.

## Nerd Mode: CRF, x265 presets, VideoToolbox quality

Full encoder control for people who know exactly what they want. Settings apply per batch and reset to defaults with one click, so they are never left behind for the next user.

![SkinnyVideo Nerd Mode showing CRF, x265 preset and VideoToolbox quality controls](https://raw.githubusercontent.com/pritam-malakar/skinnyvideo/main/site/img/nerd-mode-settings.png)

| Control | Tier | Range | Default |
|---|---|---|---|
| CRF (constant quality) | Slow But Better | 0–51, lower is larger and cleaner | 18 |
| x265 preset | Slow But Better | ultrafast → veryslow, nine positions | medium |
| VideoToolbox quality | Make It Fast | 1–85; capped where the bitrate curve goes vertical | 62 |
| 10-bit → 8-bit | Both | Appears only when the batch contains a file deeper than 8 bits (10- or 12-bit) | off |
| Dry run | Both | Scans the batch and reports totals without writing anything | — |

Built on a self-compiled FFmpeg with x265 and VideoToolbox and nothing else bundled. The build recipe is in this repo: [`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh).

## How it behaves

- **Inputs.** Files ending in `.mp4`, `.mov`, `.m4v`, `.mkv`, `.avi`, `.mts`, `.m2ts`, `.mpg`, `.mpeg`, `.wmv`, `.flv`, `.webm`, `.mxf`, `.prores`, `.dnxhd`, `.avchd`, `.3gp`, `.3g2`, `.ts`, `.vob` or `.ogv` (upper or lower case) are checked, and compressed if they contain a video stream. In a folder you add (dropped or picked), SkinnyVideo's own output is left out: anything inside a `Compressed_YYYY-MM-DD_HHMM` run folder, and unfinished files it has recorded; the staging line says how many. Any other file is checked like the rest, even one named like `holiday.tmp.mp4`. Files you add one by one are always honoured.
- **Audio and timecode.** Every audio track is kept, in its original order and with its own channel count; tracks are never mixed together. AAC, ALAC, AC-3 and E-AC-3 tracks are copied unchanged. Any other audio (PCM, FLAC, Opus, MP3, DTS, TrueHD, MP2, Vorbis) is converted to AAC at 320 kb/s per track. A track SkinnyVideo can't read is left out and the file's row shows a NOTE; the file itself still compresses. Subtitle and data tracks are not kept. The source's start timecode is carried to the output.
- **Failed files.** If a file can't be compressed, a copy of its original goes into `_FAILED/` inside the run folder. The original in place is never touched.
- **Retries before failing.** If the encoder rejects a color tag, the file is encoded again on the same encoder without color tags. If it still fails, SkinnyVideo tries libx265 at CRF 22 (preset medium). Only then is the file marked failed. A file that stops making progress is not retried.
- **Duplicate.** If you run the same file into the same Output folder again within the same minute, without quitting in between, the finished copy is kept and the row says Duplicate ("Already in a batch going to this same run folder"). Any other rerun makes a new copy in a new run folder.
- **HDR.** PQ and HLG transfer tags and BT.2020 color tags are carried to the output, and so are HDR10 mastering display and content light level values. Dolby Vision is not kept: its configuration record is dropped in both tiers, so the output is not marked as Dolby Vision. Make It Fast leaves the per-frame Dolby Vision data in the video stream; Slow But Better removes it. Dolby Vision files get a "Dolby Vision" chip on their row that says exactly what was dropped; HDR10 files get no chip, because nothing is dropped.
- **Bit depth and alpha.** 10-bit sources stay 10-bit (HEVC Main 10) unless you turn on 10-bit → 8-bit in Nerd Mode. Sources deeper than 10 bits, such as 12-bit ProRes 4444, come out 10-bit. Alpha channels are not kept: both tiers drop the transparency on purpose and still compress the file, and the file's row shows a NOTE.
- **Queue order.** Drag a queued batch to change the order, before Start or during a run. The next batch to start is always the one shown next; a batch that has started stays where it is.
- **Nerd Mode settings freeze when you click Add batch.** Changing them afterwards affects only batches you add later.
- **The Output folder is remembered.** The next launch starts with the Output folder you last chose, as long as it still exists and you can write to it. Otherwise Output starts empty and you pick one, as on first launch.
- **Warnings.** On launch, if an earlier run was interrupted, SkinnyVideo checks the `.tmp.mp4` files it left. A leftover can be kept if it is as long as its original and was recorded by this version with its run folder still present: it gets its normal name and moves to the top of its run folder, which stays flat. You can also delete it. The rest it offers to delete, and the prompt says why: the file is incomplete, it was recorded by an older version of SkinnyVideo, or its run folder is missing. Nothing else is touched. Before a run, it warns if the output drive has less free space than the videos add up to. If you quit while a finished file is still being written to disk, it asks you to wait.
- **Sizes are decimal** (1 MB = 1,000,000 bytes), matching Finder.
- **Slow But Better is not always the smaller or the higher-scoring file.** Against Make It Fast it scored higher PSNR on 6 of the 11 clips we measured, within 0.1 dB on 3 (including both ProRes HQ masters), and lower on the two iPhone 4K60 4:2:2 clips. On already-compressed phone footage it can come out larger than Make It Fast: iPhone 12 SDR, 2.0 MB vs 4.6 MB (+3.0 dB). Sony 4K 4:2:0 is another case: 6.3 MB vs 24.4 MB (+2.3 dB). Details in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

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
| macOS | 13 or later |
| Download | [`SkinnyVideo-arm64.dmg`](https://github.com/pritam-malakar/skinnyvideo/releases/latest/download/SkinnyVideo-arm64.dmg), about 170 MB |
| Security | Signed with a Developer ID certificate and notarized by Apple |
| License | GPL-2.0-or-later |

Open the `.dmg`, drag SkinnyVideo to Applications, launch. No Gatekeeper warnings, no workarounds. There is no Intel build.

SkinnyVideo checks this repo's Releases for new versions, and you can turn that off in the app ("Check for updates automatically"). It asks before downloading an update and installs it only when you choose Restart.

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
No. SkinnyVideo runs only on Apple Silicon Macs, including MacBook Neo, on macOS 13 and up.

**Does it lose quality?**
HEVC is lossy, so yes, technically. Both tiers aim to look visually identical to the source. Slow But Better spends several times longer per frame to keep fine detail — grain, texture, gradients — that fast hardware encoding smooths away; its file is not necessarily smaller than Make It Fast's.

**Does it upload my videos anywhere?**
No. Compression runs entirely on your Mac and your videos never leave it. The app's only internet use is an optional check for new versions on GitHub, which you can turn off.

**Is it safe to install?**
Yes. It's signed and notarized by Apple, open source under GPL-2.0-or-later, and every release publishes a SHA-256 checksum.

**Where do the compressed files go?**
You pick an Output folder; it stays set, and the next launch starts with it if it still exists and is writable. Each run creates a new `Compressed_YYYY-MM-DD_HHMM` folder inside it and puts every result there as an `.mp4`, flat. The originals are never opened for writing, moved, or deleted.

**Can it compress ProRes?**
Yes. A 593 MB ProRes 422 HQ master came out at 13.3 MB (97.8% smaller) with Slow But Better.

**Can it compress iPhone video that's already HEVC?**
Yes, but the gain varies a lot: anywhere from about 17% to 85% depending on the clip, so there is no single number for phone video. The big savings come from camera codecs — XAVC, Canon H.264, ProRes — not from phone HEVC.

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
