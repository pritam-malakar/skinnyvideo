# Bundled ffmpeg — PINNED

SkinnyVideo ships its own ffmpeg/ffprobe and runs **only** these (single resolution
path in [pipeline.js](../../src/encoder/pipeline.js) `getBinaries`/`resolveBinDir`
— no PATH lookup, no system ffmpeg, no Homebrew, no `ffmpeg-static`, no env
override, no fallback). These two binaries are **vendored in git** so every
checkout and every build embeds the identical, known-good engine on every
machine.

## Pinned build

- **Version:** `ffmpeg version 8.1` (ffprobe 8.1)
- **Arch:** Mach-O 64-bit `arm64` (Apple Silicon)
- **Linkage:** static against system frameworks + `/usr/lib` ONLY (VideoToolbox,
  AVFoundation, libSystem, libc++, libz, libbz2, libexpat). **No third-party /
  Homebrew dylibs** — verify with `otool -L resources/bin/ffmpeg`; nothing under
  `/opt/homebrew` or `/usr/local` may appear.
- **Required encoders (both must be present):**
  - `hevc_videotoolbox` — hardware HEVC ("Make It Fast" / `regular` tier)
  - `libx265` — software HEVC ("Slow But Better" / `preserve` tier)
  - verify: `resources/bin/ffmpeg -hide_banner -encoders | grep -E 'hevc_videotoolbox|libx265'`

## Integrity (sha256)

```
ffmpeg   22a02449174a956e2b72f54a652913794af6eb8c5400b98760263fd2caf24f77
ffprobe  33303773efb8a6279fbdcffdbebe55258c4e5dbd6f53fb2774118a215aefebfb
```

## Signing

Signed at **build time** with the project's Developer ID identity, hardened
runtime and a secure timestamp. `@electron/osx-sign` walks the whole app bundle
and picks these up automatically from `Contents/Resources/bin` — no extra build
config is needed. A clean install on Apple Silicon therefore never sees an
unsigned binary (which the kernel would SIGKILL).

The committed copies here are ad-hoc signed, but the release build re-signs
unconditionally, so re-vendoring an unsigned binary is safe. Verify a build
with `codesign -dvv` on the copies inside the packaged `.app`: each must show
Authority `Developer ID Application`, TeamIdentifier `5Q58R4CVQY`, and
`flags=0x10000(runtime)`.

## Replacing this binary (do NOT do casually)

Encoder behavior is locked (§3.8 — no arg/option changes). If this engine is
ever re-vendored: keep the same arch, keep it static (no Homebrew dylibs), keep
BOTH encoders, update the version + both sha256 sums above, and re-run
`test/ffmpeg_bundled_test.js`. The run-log header records the resolved path +
`ffmpeg -version` first line on every run — use it to confirm which engine
actually ran on a given machine.

## License note

`libx265` makes the bundled ffmpeg **GPL**. Fine for internal use; a real
obligation if the binary is ever distributed externally (B2B, §8).
