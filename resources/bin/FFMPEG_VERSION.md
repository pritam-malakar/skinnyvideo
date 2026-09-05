# Bundled ffmpeg — PINNED

SkinnyVideo ships its own ffmpeg/ffprobe and runs **only** these (single resolution
path in [pipeline.js](../../src/encoder/pipeline.js) `getBinaries`/`resolveBinDir`
— no PATH lookup, no system ffmpeg, no Homebrew, no `ffmpeg-static`, no env
override, no fallback). These two binaries are **vendored in git** so every
checkout and every build embeds the identical, known-good engine on every
machine.

## Provenance — THIRD-PARTY PREBUILT, ORIGIN UNKNOWN (to be replaced)

**These binaries were not built by this project and their build recipe is not
known.** They were committed in the first commit with no recorded source URL,
no build script and no library versions. What can be established by inspecting
them:

- Version string is plain `ffmpeg version 8.1` — it names **no** builder (no
  `-tessus`, no vendor suffix), and the only URL embedded anywhere in the
  binary is FFmpeg's own `http://www.ffmpeg.org/schema/ffprobe`.
- `--prefix=/Volumes/tempdisk/sw` — a build volume that does not exist on any
  machine here. This prefix is associated with the evermeet.cx macOS FFmpeg
  builds, which is **suggestive but not proof**; the usual builder suffix is
  absent, so the origin is genuinely unconfirmed.
- Built with Apple clang 13.1.6 (Xcode 13.x era), far older than the current
  toolchain — so, a different machine.
- `--enable-gpl`, and **no** `--enable-nonfree` / `libfdk-aac`.
- Only one statically linked library reports its own version at runtime:
  **x265 `4.1+1-1d117be`** (one commit past the 4.1 tag, not a release tag).
  The versions of libx264, libvidstab, libmp3lame and the other ~20 statically
  linked libraries **cannot be determined** from the binaries.

**Consequence:** GPL §3 requires the source corresponding to the binary that is
actually shipped. Because the exact library revisions and the build recipe are
unknown, that correspondence cannot honestly be asserted for these binaries.

**Plan:** replace with a self-built **minimal** FFmpeg (FFmpeg + libx265 +
VideoToolbox only) from a pinned, in-repo build recipe, so correspondence is
exact by construction and the ~20 unused libraries — including the AOM- and
Fraunhofer-patent-clause ones — are dropped entirely. `THIRD-PARTY-NOTICES.md`
and `CORRESPONDING-SOURCE.md` will be written against that build, not this one.

## Pinned build (current, to be superseded)

- **Version:** `ffmpeg version 8.1` (ffprobe 8.1)
- **x265:** `4.1+1-1d117be`
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

`--enable-gpl` plus `libx265` makes the bundled ffmpeg **GPL-2.0-or-later**,
and SkinnyVideo as a whole is licensed GPL-2.0-or-later to match (see
[LICENSE](../../LICENSE)). Publishing free dmgs on GitHub Releases **is**
distribution, so the GPL §3 corresponding-source obligation is live — see the
Provenance section above for why it cannot be satisfied with these binaries.
