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
- **12-bit** sources (ProRes 4444) are compared at 12 bits. 3.3.0 writes them
  as 10-bit 4:2:0 (3.2.2, which produced the per-clip table below, wrote 8-bit
  4:2:0), so the score includes that bit-depth and chroma loss.
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

**VMAF.** `bench.sh` also reports VMAF (Netflix's perceptual metric, default
model `vmaf_v0.6.1`, mean over every frame, plus the worst frame), with the same
frame pairing and comparison format as PSNR and SSIM. It needs an ffmpeg built
with libvmaf. The bundled engine is not, so `bench.sh` uses the first of:
bundled ffmpeg (if a future build has libvmaf), `$SV_VMAF_FFMPEG`, Homebrew's
`/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, `ffmpeg` on PATH. It prints
the binary it used and stores it in the JSON (`vmaf.ffmpeg`). No libvmaf
anywhere → VMAF is reported as n/a / `null`, never estimated. The **encode**
always uses the bundled ffmpeg. The VMAF figures in this file were computed by
Homebrew ffmpeg 8.1.2 (`/opt/homebrew/bin/ffmpeg`). Like PSNR, VMAF is computed
in the source's range. On the two full-range Canon clips, converting both
sides to limited range first moves the score by under 1 point
(`canon77d_MVI_0528.MOV` CRF 18: 89.58 vs 90.29).

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
metric built to track what viewers see. `bench.sh` reports it since 3.3.0. The
per-clip table below predates that (3.2.2, PSNR/SSIM only); VMAF figures are in
the x265 CRF sweep section.

## Running it

```sh
scripts/bench.sh <source> regular            # Make It Fast, defaults
scripts/bench.sh <source> better             # Slow But Better, defaults
scripts/bench.sh --crf 22 <source> better    # override CRF
scripts/bench.sh --quality 70 <source> regular
scripts/bench.sh --keep <source> better      # keep out.mp4 and the logs
SV_VMAF_FFMPEG=/path/to/ffmpeg scripts/bench.sh <source> better   # VMAF from a specific libvmaf build
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
- ProRes 4444 with alpha failed in Slow But Better in 3.2.2 (the table
  above): the bundled libx265 does not encode alpha. 3.3.0 drops the alpha
  plane on purpose in both tiers and encodes the file; see the x265 CRF sweep
  below for 3.3.0 figures.

## x265 CRF sweep (3.3.0 measurement)

Measurement only: the app's defaults are unchanged (Slow But Better CRF 18,
preset medium; Make It Fast `-q:v 62`). Every run is `scripts/bench.sh` on the
3.3.0 encode command (all audio tracks, alpha dropped, 12-bit → 10-bit), on the
ten camera/stock clips above plus the demo master, full length.

- **Machine:** Apple M2 Pro, macOS 27.0 (26A428); encoder: bundled ffmpeg version 8.1.2, x265 4.2+1-e444744.
- **VMAF** computed by `/opt/homebrew/bin/ffmpeg` (ffmpeg version 8.1.2, Homebrew; the bundled build has no libvmaf), model `vmaf_v0.6.1`, every frame, same frame pairing and comparison format as PSNR/SSIM. Mean, with the worst frame in brackets.
- **PSNR** is the all-plane average; **SSIM** is "All"; both as in the method above.
- **Wall-clock:** encode only (probing and quality passes excluded), measured with nothing else running on the machine.

| Clip | Run | Size | Reclaim | PSNR avg dB | SSIM | VMAF mean (worst) | Wall-clock |
|---|---|---|---|---|---|---|---|
| `canon77d_MVI_0528.MOV` | Slow But Better CRF 18 (default) | 510 KB | 97.9% | 50.86 | 0.9929 | 89.58 (86.91) | 1.6 s |
| `canon77d_MVI_0528.MOV` | Slow But Better CRF 20 | 389 KB | 98.4% | 50.45 | 0.9925 | 88.10 (85.60) | 1.5 s |
| `canon77d_MVI_0528.MOV` | Slow But Better CRF 22 | 300 KB | 98.8% | 49.97 | 0.9921 | 86.24 (83.52) | 1.4 s |
| `canon77d_MVI_0528.MOV` | Slow But Better CRF 24 | 233 KB | 99.1% | 49.46 | 0.9917 | 84.24 (81.23) | 1.3 s |
| `canon77d_MVI_0528.MOV` | Slow But Better CRF 26 | 184 KB | 99.3% | 48.90 | 0.9913 | 81.84 (76.77) | 1.2 s |
| `canon77d_MVI_0528.MOV` | Make It Fast (default) | 311 KB | 98.7% | 50.22 | 0.9930 | 85.25 (82.42) | 0.6 s |
| `canon_MVI_6661.MP4` | Slow But Better CRF 18 (default) | 4.3 MB | 53.4% | 48.39 | 0.9911 | 98.99 (92.17) | 4.6 s |
| `canon_MVI_6661.MP4` | Slow But Better CRF 20 | 3.2 MB | 66.2% | 47.62 | 0.9899 | 98.29 (90.59) | 4.4 s |
| `canon_MVI_6661.MP4` | Slow But Better CRF 22 | 2.3 MB | 75.2% | 46.86 | 0.9886 | 97.11 (88.45) | 4.1 s |
| `canon_MVI_6661.MP4` | Slow But Better CRF 24 | 1.8 MB | 81.1% | 46.09 | 0.9871 | 95.38 (85.74) | 3.9 s |
| `canon_MVI_6661.MP4` | Slow But Better CRF 26 | 1.4 MB | 85.3% | 45.29 | 0.9855 | 92.92 (81.93) | 3.6 s |
| `canon_MVI_6661.MP4` | Make It Fast (default) | 2.2 MB | 76.3% | 45.68 | 0.9860 | 93.78 (85.15) | 1.2 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better CRF 18 (default) | 2.4 MB | 43.8% | 51.35 | 0.9962 | 95.61 (93.65) | 2.8 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better CRF 20 | 1.7 MB | 59.7% | 50.04 | 0.9952 | 94.77 (92.66) | 2.4 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better CRF 22 | 1.2 MB | 71.3% | 48.79 | 0.9939 | 93.75 (91.72) | 2.1 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better CRF 24 | 878 KB | 79.6% | 47.63 | 0.9924 | 92.57 (90.22) | 1.9 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Slow But Better CRF 26 | 640 KB | 85.1% | 46.53 | 0.9906 | 91.13 (89.02) | 1.8 s |
| `iphone12_hevc_vfr_hlg_IMG_2461.MOV` | Make It Fast (default) | 3.2 MB | 25.6% | 50.01 | 0.9946 | 95.43 (94.78) | 1.0 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better CRF 18 (default) | 4.6 MB | 23.6% | 47.03 | 0.9874 | 95.46 (94.09) | 4.1 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better CRF 20 | 3.2 MB | 47.8% | 46.06 | 0.9848 | 94.44 (92.91) | 3.5 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better CRF 22 | 2.1 MB | 65.6% | 45.13 | 0.9820 | 93.16 (91.19) | 2.9 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better CRF 24 | 1.3 MB | 78% | 44.28 | 0.9791 | 91.63 (89.37) | 2.4 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Slow But Better CRF 26 | 852 KB | 85.9% | 43.49 | 0.9764 | 89.78 (87.00) | 2.1 s |
| `iphone12_hevc_vfr_sdr_IMG_0963.MOV` | Make It Fast (default) | 2.0 MB | 67.5% | 44.07 | 0.9779 | 91.28 (89.91) | 1.0 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better CRF 18 (default) | 957 KB | 84.4% | 61.68 | 0.9997 | 95.82 (93.31) | 10.1 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better CRF 20 | 799 KB | 87% | 60.71 | 0.9997 | 95.29 (91.80) | 10.1 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better CRF 22 | 676 KB | 89% | 59.68 | 0.9996 | 94.65 (90.00) | 9.7 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better CRF 24 | 583 KB | 90.5% | 58.64 | 0.9996 | 93.85 (86.03) | 9.5 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Slow But Better CRF 26 | 517 KB | 91.6% | 57.48 | 0.9995 | 92.89 (81.66) | 9.2 s |
| `iphone16pro_hevc422_4k60_IMG_0311.mov` | Make It Fast (default) | 1.6 MB | 74.3% | 62.29 | 0.9998 | 96.19 (94.73) | 4.4 s |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better CRF 18 (default) | 22.0 MB | 95.2% | 48.69 | 0.9938 | 96.45 (93.79) | 17.1 s |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better CRF 20 | 16.5 MB | 96.4% | 47.62 | 0.9924 | 94.70 (91.78) | 16.0 s |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better CRF 22 | 12.5 MB | 97.3% | 46.54 | 0.9907 | 92.52 (89.32) | 14.4 s |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better CRF 24 | 9.6 MB | 97.9% | 45.45 | 0.9885 | 89.79 (85.73) | 13.4 s |
| `iphone_prores_hq_IMG_3069.MOV` | Slow But Better CRF 26 | 7.3 MB | 98.4% | 44.34 | 0.9859 | 86.40 (81.59) | 13.2 s |
| `iphone_prores_hq_IMG_3069.MOV` | Make It Fast (default) | 25.7 MB | 94.4% | 48.69 | 0.9935 | 97.60 (91.88) | 3.4 s |
| `prores4444_alpha_yellow_car.mov` | Slow But Better CRF 18 (default) | 1.6 MB | 98.1% | 52.58 | 0.9989 | 98.14 (96.95) | 2.6 s |
| `prores4444_alpha_yellow_car.mov` | Slow But Better CRF 20 | 1.3 MB | 98.4% | 52.10 | 0.9988 | 97.86 (96.65) | 2.5 s |
| `prores4444_alpha_yellow_car.mov` | Slow But Better CRF 22 | 1.0 MB | 98.7% | 51.54 | 0.9987 | 97.49 (95.98) | 2.5 s |
| `prores4444_alpha_yellow_car.mov` | Slow But Better CRF 24 | 846 KB | 99% | 50.82 | 0.9985 | 97.04 (94.52) | 2.5 s |
| `prores4444_alpha_yellow_car.mov` | Slow But Better CRF 26 | 689 KB | 99.2% | 50.10 | 0.9982 | 96.43 (93.16) | 2.4 s |
| `prores4444_alpha_yellow_car.mov` | Make It Fast (default) | 1.9 MB | 97.6% | 51.88 | 0.9986 | 98.20 (96.64) | 1.5 s |
| `prores_proxy_s24.mov` | Slow But Better CRF 18 (default) | 49 KB | 99.3% | 73.36 | 1.0000 | 97.22 (97.07) | 1.8 s |
| `prores_proxy_s24.mov` | Slow But Better CRF 20 | 47 KB | 99.4% | 71.20 | 1.0000 | 97.12 (96.81) | 1.8 s |
| `prores_proxy_s24.mov` | Slow But Better CRF 22 | 46 KB | 99.4% | 69.31 | 1.0000 | 97.05 (96.76) | 1.8 s |
| `prores_proxy_s24.mov` | Slow But Better CRF 24 | 44 KB | 99.4% | 67.80 | 1.0000 | 96.98 (96.55) | 1.8 s |
| `prores_proxy_s24.mov` | Slow But Better CRF 26 | 44 KB | 99.4% | 65.63 | 1.0000 | 96.71 (96.08) | 1.8 s |
| `prores_proxy_s24.mov` | Make It Fast (default) | 135 KB | 98.2% | 67.48 | 1.0000 | 97.00 (96.69) | 1.4 s |
| `sony_xavc_420_C0024.MP4` | Slow But Better CRF 18 (default) | 24.5 MB | 81.8% | 46.78 | 0.9832 | 97.37 (93.14) | 22.3 s |
| `sony_xavc_420_C0024.MP4` | Slow But Better CRF 20 | 14.5 MB | 89.2% | 46.20 | 0.9815 | 96.56 (92.44) | 18.4 s |
| `sony_xavc_420_C0024.MP4` | Slow But Better CRF 22 | 9.0 MB | 93.3% | 45.69 | 0.9801 | 95.57 (91.75) | 16.0 s |
| `sony_xavc_420_C0024.MP4` | Slow But Better CRF 24 | 5.9 MB | 95.6% | 45.18 | 0.9787 | 94.30 (90.62) | 14.1 s |
| `sony_xavc_420_C0024.MP4` | Slow But Better CRF 26 | 4.1 MB | 96.9% | 44.63 | 0.9770 | 92.69 (89.04) | 13.0 s |
| `sony_xavc_420_C0024.MP4` | Make It Fast (default) | 6.4 MB | 95.2% | 44.45 | 0.9759 | 91.92 (87.80) | 4.9 s |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better CRF 18 (default) | 2.6 MB | 96.2% | 54.44 | 0.9969 | 95.66 (92.44) | 8.3 s |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better CRF 20 | 1.8 MB | 97.4% | 53.96 | 0.9967 | 94.80 (90.16) | 7.9 s |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better CRF 22 | 1.3 MB | 98% | 53.47 | 0.9965 | 93.86 (88.09) | 7.3 s |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better CRF 24 | 1.0 MB | 98.4% | 52.95 | 0.9963 | 92.80 (84.93) | 7.0 s |
| `sony_xavc_422_10bit_C0819.MP4` | Slow But Better CRF 26 | 876 KB | 98.7% | 52.26 | 0.9961 | 91.45 (81.16) | 6.7 s |
| `sony_xavc_422_10bit_C0819.MP4` | Make It Fast (default) | 2.2 MB | 96.8% | 54.50 | 0.9970 | 95.30 (91.27) | 2.2 s |
| `original.mov` | Slow But Better CRF 18 (default) | 13.3 MB | 97.8% | 49.47 | 0.9901 | 96.97 (96.25) | 28.4 s |
| `original.mov` | Slow But Better CRF 20 | 6.6 MB | 98.9% | 48.86 | 0.9890 | 96.61 (95.64) | 22.9 s |
| `original.mov` | Slow But Better CRF 22 | 2.7 MB | 99.5% | 48.43 | 0.9883 | 96.27 (95.31) | 17.1 s |
| `original.mov` | Slow But Better CRF 24 | 906 KB | 99.8% | 48.23 | 0.9882 | 95.85 (94.80) | 12.7 s |
| `original.mov` | Slow But Better CRF 26 | 385 KB | 99.9% | 47.98 | 0.9881 | 95.32 (94.08) | 12.0 s |
| `original.mov` | Make It Fast (default) | 11.3 MB | 98.1% | 49.52 | 0.9903 | 97.08 (95.57) | 3.9 s |

Against the two conditions (VMAF within 1 point of CRF 18 on every clip; never
a file larger than Make It Fast's when Make It Fast scores the same or higher VMAF):

| CRF | Clips more than 1 VMAF point below CRF 18 | Worst VMAF change vs CRF 18 | Clips where Make It Fast is smaller at equal or higher VMAF |
|---|---|---|---|
| 18 | 0 | +0.00 | 1: `original.mov` |
| 20 | 3: `canon77d_MVI_0528.MOV` (-1.48), `iphone12_hevc_vfr_sdr_IMG_0963.MOV` (-1.02), `iphone_prores_hq_IMG_3069.MOV` (-1.75) | -1.75 | 0 |
| 22 | 8: `canon77d_MVI_0528.MOV` (-3.34), `canon_MVI_6661.MP4` (-1.88), `iphone12_hevc_vfr_hlg_IMG_2461.MOV` (-1.86), `iphone12_hevc_vfr_sdr_IMG_0963.MOV` (-2.30), `iphone16pro_hevc422_4k60_IMG_0311.mov` (-1.18), `iphone_prores_hq_IMG_3069.MOV` (-3.93), `sony_xavc_420_C0024.MP4` (-1.80), `sony_xavc_422_10bit_C0819.MP4` (-1.80) | -3.93 | 0 |
| 24 | 10: `canon77d_MVI_0528.MOV` (-5.34), `canon_MVI_6661.MP4` (-3.60), `iphone12_hevc_vfr_hlg_IMG_2461.MOV` (-3.04), `iphone12_hevc_vfr_sdr_IMG_0963.MOV` (-3.83), `iphone16pro_hevc422_4k60_IMG_0311.mov` (-1.97), `iphone_prores_hq_IMG_3069.MOV` (-6.65), `prores4444_alpha_yellow_car.mov` (-1.10), `sony_xavc_420_C0024.MP4` (-3.06), `sony_xavc_422_10bit_C0819.MP4` (-2.86), `original.mov` (-1.13) | -6.65 | 0 |
| 26 | 10: `canon77d_MVI_0528.MOV` (-7.74), `canon_MVI_6661.MP4` (-6.07), `iphone12_hevc_vfr_hlg_IMG_2461.MOV` (-4.48), `iphone12_hevc_vfr_sdr_IMG_0963.MOV` (-5.69), `iphone16pro_hevc422_4k60_IMG_0311.mov` (-2.93), `iphone_prores_hq_IMG_3069.MOV` (-10.04), `prores4444_alpha_yellow_car.mov` (-1.71), `sony_xavc_420_C0024.MP4` (-4.68), `sony_xavc_422_10bit_C0819.MP4` (-4.20), `original.mov` (-1.65) | -10.04 | 0 |

**Recommendation.** No CRF meets both conditions. Today's CRF 18 passes the
first by definition but fails the second on the demo master: Make It Fast
makes 11.3 MB at VMAF 97.08 where CRF 18 makes 13.3 MB at 96.97. **CRF 20** is
the closest. Make It Fast never beats it on both size and VMAF, and it is a
median 27% smaller than CRF 18 (5–50% across the 11 clips). But it falls more
than 1 VMAF point below CRF 18 on three clips: `canon77d_MVI_0528.MOV`
(−1.48), `iphone12_hevc_vfr_sdr_IMG_0963.MOV` (−1.02) and
`iphone_prores_hq_IMG_3069.MOV` (−1.75). CRF 22 and above lose more than a
point on 8 to 10 of the 11 clips (up to −10.04 at CRF 26). So by the stated
rule the answer is "none". If a worst case of about 1.75 VMAF points is
acceptable for a 27% median size cut, CRF 20 is the one to consider. The app's
default CRF and preset are unchanged by this measurement.
