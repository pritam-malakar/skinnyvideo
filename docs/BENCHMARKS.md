# Benchmarks

How SkinnyVideo's published size, speed and quality figures are measured, and
how to rerun them. Every number here comes from `scripts/bench.sh`, which runs
the exact ffmpeg command the app builds.

## Method

**Encoder command.** `scripts/print-args.js` probes the source the way the app
does (same ffprobe, stream choice and colour handling) and prints the argv
from `buildArgs` in `src/encoder/pipeline.js`. `bench.sh` runs that argv with
the bundled ffmpeg (`resources/bin/ffmpeg`). Neither script contains its own
copy of the command, so a change to the app's encode settings changes the
benchmark with it. The app's fallback chain is not exercised; a source the
primary encode rejects is reported as failed.

**Tiers and settings.** Defaults unless stated:

| Tier | `bench.sh` name | Encoder | Settings |
|---|---|---|---|
| Make It Fast | `regular` | `hevc_videotoolbox` | `-q:v 62` (override with `--quality N`, capped at 85) |
| Slow But Better | `better` | `libx265` | `-crf 18 -preset medium` (override with `--crf N`) |

10-bit sources are encoded as HEVC Main 10. Every audio track is kept: AAC,
ALAC, AC-3 and E-AC-3 are copied, any other audio becomes AAC 320 kb/s per track.

**Size.** Source and output sizes are bytes on disk, shown in decimal units
(1 MB = 1,000,000 bytes) like the app and Finder. Reclaim = 1 − output / source.

**Speed.** Wall-clock time of the encode alone (probing and quality checks
excluded). Realtime factor = source duration / wall-clock time; above 1× means
faster than the footage plays. Source duration is the container duration, the
same value the app uses.

**Quality.** PSNR and SSIM from ffmpeg's `psnr` and `ssim` filters, output
against source, over **every frame of the whole clip** — full-length averages,
not an excerpt. PSNR "average" is ffmpeg's all-plane figure (Y, U and V
weighted by plane size); Y alone is shown in brackets. SSIM is ffmpeg's "All".

- **Pixel format.** Both sides are converted to the **source's** pixel format
  and range before comparison: the output is converted up, the source is
  never reduced. Semi-planar formats map to the planar format of the same depth
  and subsampling (for example `p010le` → `yuv420p10le`).
- **10-bit** sources are compared at 10 bits.
- **12-bit** sources (ProRes 4444) are compared at 12 bits. The app currently
  writes them as 8-bit 4:2:0, so the score includes that bit-depth and chroma
  loss.
- **Alpha** is not compared. The output has no alpha plane, so the comparison
  uses the colour planes only.
- **HDR** (PQ or HLG) is compared on the coded signal, with no tone mapping.
  These dB figures are not directly comparable with SDR figures.
- **Frame alignment.** The app writes constant-frame-rate MP4. iPhone footage
  is variable-rate: its timestamps wobble by a tick, so pairing frames by
  timestamp compares many output frames against the neighbouring source frame.
  The source is therefore put on the output's frame grid with ffmpeg's `fps`
  filter, the same conversion the encode applied, so each output frame is
  compared with the frame it was made from.

**Machine.** Apple M2 Pro, macOS 27.0 (26A428), bundled ffmpeg version 8.1.2, x265
4.2+1-e444744. `bench.sh` prints these for every run; publish them with any figure.

## Comparison method

The app writes constant-frame-rate MP4. Variable-frame-rate sources are
compared on the **output's** frame grid: the source passes through ffmpeg's
`fps` filter at the output's frame rate before PSNR and SSIM, so each output
frame is scored against the source frame it was made from. This measures what
the viewer sees. It does **not** count dropped or duplicated frames: a frame
the encode dropped or repeated is simply absent from, or repeated in, both
sides of the comparison.

Pairing frames by raw timestamp instead compares many output frames with the
neighbouring source frame, because iPhone timestamps wobble by one time-base
tick. On `IMG_0122.mov` that misreports 49.5–51.6 dB as 33.6 dB.
`test/bench_test.js` guards this with a source whose timestamps are one tick
late on every other frame.

Variable-frame-rate clips in this set, all iPhone footage:

| Clip | Nominal / average fps | Source → output frames |
|---|---|---|
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | 29.97 / 29.98 | 140 → 140 |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | 29.97 / 29.98 | 151 → 151 |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | 60 / 60.03 | 214 → 213 |
| `IMG_0122.mov` | 60 / 59.96 | 2249 → 2248 |

Every other clip is constant-frame-rate, and its output has the same frame
count as the source.

## Reading PSNR and SSIM

PSNR and SSIM reward an output that matches the source pixel for pixel. x265,
which Slow But Better uses, runs with its psychovisual rate-distortion tuning
on (`psy-rd`, on by default; the app does not change it). That deliberately
gives up some PSNR to keep grain and texture that a viewer notices, so these
two metrics can understate Slow But Better against Make It Fast. VMAF is the
metric built to track what viewers see; it is not yet in `bench.sh`, so no
published figure here is a VMAF score.

## Running it

```sh
scripts/bench.sh <source> regular            # Make It Fast, defaults
scripts/bench.sh <source> better             # Slow But Better, defaults
scripts/bench.sh --crf 22 <source> better    # override CRF
scripts/bench.sh --quality 70 <source> regular
scripts/bench.sh --keep <source> better      # keep out.mp4 and the logs
```

It prints a table and, as the last line, one JSON object with every figure.
Work files go in a temporary folder that is deleted unless `--keep` is given.

## Published figures and how to rerun them

| Figure | Where | Source | Command |
|---|---|---|---|
| 593 MB → 13.3 MB (97.8%), PSNR 49.5 dB, SSIM 0.990; "up to 97.8% smaller" | README, site | `original.mov` from `https://files.skinnyvideo.app/demo/v1/original.mov`, SHA-256 `a8df15dd…0cbe` | `scripts/bench.sh original.mov better` |
| 92–97% on Sony XAVC 4K, Make It Fast | README, site | `sony_xavc_422_10bit_C0819.MP4` (96.8%), `sony_xavc_420_C0024.MP4` (95.3%), `C0817.MP4` (92.2%) | `scripts/bench.sh <clip> regular` |
| About 2× real time on 4K 25p Sony XAVC, Make It Fast | README, site | `C0817.MP4` (62.4 s → 30.5 s, 2.05×) | `scripts/bench.sh C0817.MP4 regular` |
| 4K60 4:2:2 phone footage just under real time, Make It Fast | README, site | `IMG_0122.mov` (0.87×), `iphone16pro_hevc422_4k60_IMG_0311.mov` (0.90×) | `scripts/bench.sh <clip> regular` |
| Slow But Better several times slower than real time on 4K | README, site | every 4K clip: 0.12–0.40× | `scripts/bench.sh <clip> better` |
| Phone HEVC: about 17–85% depending on the clip, no single number; pairs 68% / 24%, 26% / 44%, 75% / 85%, 17% / 47% | README, site | the four iPhone clips below | `scripts/bench.sh <clip> regular` and `better` |
| Slow But Better vs Make It Fast: PSNR higher on 6 of 11 clips, within 0.1 dB on 3, lower on 2; larger on iPhone 12 SDR (2.0 → 4.6 MB) and Sony 4K 4:2:0 (6.3 → 24.4 MB) | README, site | all clips below | both tiers per clip |
| Demo master, Make It Fast: 593 MB → 11.3 MB, PSNR 49.5 dB | site demo | `original.mov` as above | `scripts/bench.sh original.mov regular` |
| Make It Fast often the smaller file (6 of 11 clips); Slow But Better from about a third to nearly four times its size | README, site | all clips below | both tiers per clip |

Earlier published figures that `bench.sh` cannot reproduce were withdrawn: the
172 GB and 81 GB ProRes masters (96%, 94%) are not available, and the
three-clip Sony 2.3 GB → 147 MB (94%), the iPhone 266 MB → 62 MB (77%) and the
"2 min in about 29 s on an M4 Pro" speed figure name no identifiable clips.

The encode of the demo master is deterministic: on Apple M2 Pro with ffmpeg 8.1.2
it produced a file byte-identical to the published `compressed.mp4`
(SHA-256 `f50237e0…8062`, 13,255,310 bytes).

## Results, Apple M2 Pro

### Clips

| Clip | Codec | Resolution | fps | Pixel format | Transfer | Duration | Size | Origin |
|---|---|---|---|---|---|---|---|---|
| `canon77d_MVI_0528.MOV` | h264 High | 1920×1080 | 29.97 | yuvj420p | bt709 | 2.17 s | 24.6 MB | Canon EOS 77D; camera original |
| `canon_MVI_6661.MP4` | h264 High | 1920×1080 | 29.97 | yuvj420p | bt709 | 5.97 s | 9.3 MB | Canon (DCIM/100CANON); camera original |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | hevc Main 10 | 1920×1080 | 29.98 | yuv420p10le | arib-std-b67 | 4.67 s | 4.3 MB | iPhone 12, HDR (HLG + Dolby Vision); camera original |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | hevc Main | 1920×1080 | 29.98 | yuv420p | bt709 | 5.04 s | 6.1 MB | iPhone 12, SDR; camera original |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | hevc Rext | 3840×2160 | 60.03 | yuv422p10le | untagged | 4.03 s | 6.1 MB | iPhone, iOS 26.4.2; camera original |
| `iphone_prores_hq_IMG_3069.MOV` | prores HQ | 3840×2160 | 30 | yuv422p10le | untagged | 5.17 s | 460.1 MB | iPhone 16 Pro, ProRes HQ; camera original |
| `prores4444_alpha_yellow_car.mov` | prores 4444 | 1920×1080 | 25 | yuva444p12le | bt709 | 10.00 s | 81.4 MB | stock animation with alpha; third-party stock |
| `prores_proxy_s24.mov` | prores Proxy | 1920×1080 | 25 | yuv422p10le | bt709 | 10.00 s | 7.5 MB | DaVinci Resolve template asset; third-party stock |
| `sony_xavc_420_C0024.MP4` | h264 High | 3840×2160 | 25 | yuv420p | bt709 | 9.12 s | 134.4 MB | Sony XAVC; camera original |
| `sony_xavc_422_10bit_C0819.MP4` | h264 High 4:2:2 | 3840×2160 | 25 | yuv422p10le | untagged | 3.36 s | 67.4 MB | Sony XAVC S-I 4:2:2; camera original |
| `original.mov` | prores HQ | 3840×2160 | 25 | yuv422p10le | bt709 | 7.36 s | 593.0 MB | Website demo master, DaVinci Resolve export; files.skinnyvideo.app/demo/v1/original.mov |
| `IMG_0122.mov` | hevc Rext | 3840×2160 | 60 | yuv422p10le | untagged | 37.48 s | 267.5 MB | iPhone, iOS 18.2; camera original |
| `C0817.MP4` | h264 High 4:2:2 | 3840×2160 | 25 | yuv422p10le | untagged | 62.40 s | 1.21 GB | Sony XAVC S-I 4:2:2; camera original |

Camera originals are the author's own footage and are not redistributed.
"untagged" means the source carries no transfer tag.

### Per clip and tier

| Clip | Tier | Before → after | Reclaim | Encode | Realtime | PSNR avg (Y) dB | SSIM | Compared |
|---|---|---|---|---|---|---|---|---|
| `canon77d_MVI_0528.MOV` | Make It Fast | 24.6 MB → 311 KB | 98.7% | 0.6 s | 3.72× | 50.22 (49.41) | 0.9930 | 65 frames at yuv420p |
| `canon77d_MVI_0528.MOV` | Slow But Better | 24.6 MB → 510 KB | 97.9% | 1.7 s | 1.26× | 50.86 (50.26) | 0.9929 | 65 frames at yuv420p |
| `canon_MVI_6661.MP4` | Make It Fast | 9.3 MB → 2.2 MB | 76.3% | 1.2 s | 5.13× | 45.68 (44.68) | 0.9860 | 179 frames at yuv420p |
| `canon_MVI_6661.MP4` | Slow But Better | 9.3 MB → 4.3 MB | 53.4% | 5.3 s | 1.13× | 48.39 (47.48) | 0.9911 | 179 frames at yuv420p |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Make It Fast | 4.3 MB → 3.2 MB | 25.6% | 1.0 s | 4.67× | 50.01 (48.42) | 0.9946 | 140 frames at yuv420p10le |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better | 4.3 MB → 2.4 MB | 43.8% | 2.8 s | 1.65× | 51.35 (49.82) | 0.9962 | 140 frames at yuv420p10le |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Make It Fast | 6.1 MB → 2.0 MB | 67.5% | 1.0 s | 4.93× | 44.07 (42.94) | 0.9779 | 151 frames at yuv420p |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better | 6.1 MB → 4.6 MB | 23.6% | 4.0 s | 1.26× | 47.03 (46.01) | 0.9874 | 151 frames at yuv420p |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Make It Fast | 6.1 MB → 1.5 MB | 74.8% | 4.5 s | 0.90× | 62.29 (60.86) | 0.9998 | 213 frames at yuv422p10le |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better | 6.1 MB → 927 KB | 84.9% | 11.3 s | 0.36× | 61.68 (60.02) | 0.9997 | 213 frames at yuv422p10le |
| `iphone_prores_hq_IMG_3069.MOV` | Make It Fast | 460.1 MB → 25.5 MB | 94.5% | 3.3 s | 1.55× | 48.69 (46.29) | 0.9935 | 155 frames at yuv422p10le |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better | 460.1 MB → 21.7 MB | 95.3% | 19.3 s | 0.27× | 48.69 (46.26) | 0.9938 | 155 frames at yuv422p10le |
| `prores4444_alpha_yellow_car.mov` | Make It Fast | 81.4 MB → 1.1 MB | 98.6% | 1.5 s | 6.55× | 47.21 (51.80) | 0.9973 | 250 frames at yuv444p12le |
| `prores4444_alpha_yellow_car.mov` | Slow But Better | 81.4 MB → — | — | — | — | — | — | failed: libx265 exit 211 (alpha) |
| `prores_proxy_s24.mov` | Make It Fast | 7.5 MB → 135 KB | 98.2% | 1.5 s | 6.78× | 67.48 (64.47) | 1.0000 | 250 frames at yuv422p10le |
| `prores_proxy_s24.mov` | Slow But Better | 7.5 MB → 49 KB | 99.3% | 1.9 s | 5.36× | 73.36 (70.35) | 1.0000 | 250 frames at yuv422p10le |
| `sony_xavc_420_C0024.MP4` | Make It Fast | 134.4 MB → 6.3 MB | 95.3% | 4.9 s | 1.85× | 44.45 (43.37) | 0.9759 | 228 frames at yuv420p |
| `sony_xavc_420_C0024.MP4` | Slow But Better | 134.4 MB → 24.4 MB | 81.8% | 22.9 s | 0.40× | 46.78 (45.80) | 0.9832 | 228 frames at yuv420p |
| `sony_xavc_422_10bit_C0819.MP4` | Make It Fast | 67.4 MB → 2.1 MB | 96.8% | 2.3 s | 1.46× | 54.50 (52.33) | 0.9970 | 84 frames at yuv422p10le |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better | 67.4 MB → 2.5 MB | 96.2% | 9.0 s | 0.38× | 54.44 (52.34) | 0.9969 | 84 frames at yuv422p10le |
| `original.mov` | Slow But Better | 593.0 MB → 13.3 MB | 97.8% | 28.5 s | 0.26× | 49.47 (47.79) | 0.9901 | 184 frames at yuv422p10le |
| `original.mov` | Make It Fast | 593.0 MB → 11.3 MB | 98.1% | 3.9 s | 1.88× | 49.52 (47.81) | 0.9903 | 184 frames at yuv422p10le |
| `IMG_0122.mov` | Slow But Better | 267.5 MB → 142.7 MB | 46.7% | 323.9 s | 0.12× | 51.59 (49.47) | 0.9962 | 2248 frames at yuv422p10le |
| `IMG_0122.mov` | Make It Fast | 267.5 MB → 221.2 MB | 17.3% | 43.3 s | 0.87× | 53.51 (51.58) | 0.9974 | 2248 frames at yuv422p10le |
| `C0817.MP4` | Make It Fast | 1.21 GB → 94.7 MB | 92.2% | 30.5 s | 2.05× | 51.00 (48.99) | 0.9948 | 1560 frames at yuv422p10le |

Notes:
- Short clips understate realtime speed: process start-up and encoder warm-up
  are a larger share of a 2–4 s encode.
- 4K60 10-bit 4:2:2 HEVC from iPhone (`IMG_0122.mov`, `IMG_0311`) encodes
  slower than real time in Make It Fast on this chip (0.87× and 0.90×).
- ProRes 4444 with alpha fails in Slow But Better: the bundled libx265 does
  not encode alpha.
