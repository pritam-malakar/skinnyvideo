# Bundled ffmpeg — PINNED, SELF-BUILT

SkinnyVideo ships its own ffmpeg/ffprobe and runs **only** these (single resolution
path in [pipeline.js](../../src/encoder/pipeline.js) `getBinaries`/`resolveBinDir`
— no PATH lookup, no system ffmpeg, no Homebrew, no `ffmpeg-static`, no env
override, no fallback). The two binaries are **vendored in git** so every
checkout and every build embeds the identical, known-good engine on every
machine.

## Provenance

Built by [`scripts/build-ffmpeg.sh`](../../scripts/build-ffmpeg.sh) on 2026-09-05
from two unmodified upstream release tarballs, pinned by URL and sha256 in that
script (a mismatch aborts the build). Nothing else is linked in.

| Component | Version | Source | sha256 |
|---|---|---|---|
| FFmpeg | 8.1.2 | `https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz` (GPG-verified, FFmpeg release signing key `FCF986EA15E6E293A5644F10B4322F04D67658D8`) | `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` |
| x265 | 4.2 release tarball; reports `4.2+1-e444744`; static 8bit+10bit+12bit multilib | `https://bitbucket.org/multicoreware/x265_git/downloads/x265_4.2.tar.gz` | `40b1ea0453e0309f0eba934e0ddf533f8f6295966679e8894e8f1c1c8d5e1210` |

- **Toolchain:** Apple clang 17.0.0 (clang-1700.3.19.1), Xcode Command Line
  Tools, cmake 4.4.3, pkg-config 3.0.7. No Homebrew library is used: the build
  pins `PKG_CONFIG_LIBDIR` to its own sandbox prefix.
- **Deployment target:** macOS 11.0 (the app's own minimum — Electron 33). Both
  binaries carry `LC_BUILD_VERSION minos 11.0`.
- **Arch:** Mach-O 64-bit `arm64` (Apple Silicon), NEON + runtime CPU detection.
- **Linkage:** static; links ONLY `/usr/lib/*` and `/System/Library/Frameworks/*`
  (VideoToolbox, AudioToolbox, AVFoundation, CoreImage, AppKit, Security,
  libSystem, libc++, libz, libbz2, libiconv). Verify with
  `otool -L resources/bin/ffmpeg`; nothing under `/opt/homebrew` or `/usr/local`
  may appear.
- **External libraries enabled** (from `ffmpeg -buildconf`): libx265 only, plus
  the Apple SDK components FFmpeg autodetects (appkit, avfoundation, coreimage,
  audiotoolbox, videotoolbox, securetransport, iconv, zlib, bzlib). Everything
  else the previous third-party build carried (libx264, libaom, svtav1, vvenc,
  kvazaar, vpx, webp, opus, vorbis, theora, mp3lame, ass, freetype/drawtext,
  vidstab, vmaf, zimg, snappy, openjpeg, harfbuzz) is gone.

Exact configure line (as `ffmpeg -version` prints it):

```
--prefix=/Users/pritammalakar/Developer/ffmpeg-build/prefix --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libx265 --enable-videotoolbox --enable-static --disable-shared --pkg-config-flags=--static --enable-neon --enable-runtime-cpudetect --disable-ffplay --disable-doc --disable-debug --disable-htmlpages --disable-manpages --disable-sdl2 --disable-xlib --disable-libxcb --extra-cflags='-mmacosx-version-min=11.0' --extra-ldflags='-mmacosx-version-min=11.0'
```

The `--prefix` path is baked into the binary, so a rebuild elsewhere is
functionally identical but not byte-identical (see
[CORRESPONDING-SOURCE.md](../../CORRESPONDING-SOURCE.md), "Known non-goal").

## Required encoders (both must be present)

- `hevc_videotoolbox` — hardware HEVC ("Make It Fast" / `regular` tier)
- `libx265` — software HEVC ("Slow But Better" / `preserve` tier); must report
  `8bit+10bit+12bit` in its build info
- verify: `resources/bin/ffmpeg -hide_banner -encoders | grep -E 'hevc_videotoolbox|libx265'`

## Integrity (sha256)

```
ffmpeg   03250a4de3bf930d450e713bc5e6f1e5eced315652e7e7842a81b2b1d07e92a3
ffprobe  6cd5b3b73eaade58873a0b98034a8fc241987e465a9ff2dc8bd5fb440979d401
```

`ffmpeg -version` first line: `ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers`.
The previous third-party pair (ffmpeg 8.1, sha256 `22a02449…` / `33303773…`) was
replaced on 2026-09-05; it is kept outside the repo for reference only.

## Signing

The committed copies carry the linker's ad-hoc signature (`flags=0x20002
(adhoc,linker-signed)`), which is what lets them run in `npm start` on Apple
Silicon. The release build re-signs them unconditionally with the project's
Developer ID identity, hardened runtime and a secure timestamp:
`@electron/osx-sign` walks the whole app bundle and picks them up from
`Contents/Resources/bin` — no extra build config is needed. Verify a build with
`codesign -dvv` on the copies inside the packaged `.app`: each must show
Authority `Developer ID Application`, TeamIdentifier `5Q58R4CVQY`, and
`flags=0x10000(runtime)`.

## Replacing this binary (do NOT do casually)

Encoder behavior is locked (§3.8 — no arg/option changes). To re-vendor: change
the pins in `scripts/build-ffmpeg.sh`, run it, and pass the binary gates before
copying the result here (arm64; static; `otool -L` clean; `minos 11.0`; both
encoders present; x265 multilib string; A/B against the previous pair on real
footage: same probe, size within ±3%, PSNR within 0.2 dB, SSIM within 0.002,
wall time ≤ 1.15×). Then update the version, configure line and both sha256
sums above, re-run `test/ffmpeg_bundled_test.js` and the full suite, and update
`THIRD-PARTY-NOTICES.md` / `CORRESPONDING-SOURCE.md`. The run-log header records
the resolved path + `ffmpeg -version` first line on every run — use it to
confirm which engine actually ran on a given machine.

## License note

`--enable-gpl` plus `libx265` makes the bundled ffmpeg **GPL-2.0-or-later**,
and SkinnyVideo as a whole is licensed GPL-2.0-or-later to match (see
[LICENSE](../../LICENSE)). Publishing dmgs on GitHub Releases **is**
distribution, so the GPL §3 corresponding-source obligation is live and is met
by `scripts/fetch-corresponding-source.sh`, which `scripts/release.sh` runs on
every release — see [CORRESPONDING-SOURCE.md](../../CORRESPONDING-SOURCE.md).
