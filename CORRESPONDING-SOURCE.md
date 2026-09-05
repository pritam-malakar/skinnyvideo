# Corresponding source for the bundled ffmpeg and ffprobe

SkinnyVideo ships two GPL-licensed programs inside the app bundle,
`Contents/Resources/bin/ffmpeg` and `Contents/Resources/bin/ffprobe`. Under
section 3 of the GNU General Public License version 2, anyone who receives the
app is entitled to the complete source code those two binaries were built from,
together with the scripts used to build them. This file says exactly what that
source is and how to rebuild the binaries from it.

## What the binaries are

Both binaries are built by this repository's own script,
[`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh), from two unmodified
upstream release tarballs and nothing else. No patches are applied. No other
third-party library is linked in: the build is FFmpeg's own code, the x265 HEVC
encoder, and Apple's system frameworks (VideoToolbox and friends, which are part
of macOS and are not distributed with the app).

| Component | Version | Source tarball | SHA-256 |
|-----------|---------|----------------|---------|
| FFmpeg | 8.1.2 | <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz> | `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c` |
| x265 | 4.2 (release tarball, reports itself as `4.2+1-e444744`) | <https://bitbucket.org/multicoreware/x265_git/downloads/x265_4.2.tar.gz> | `40b1ea0453e0309f0eba934e0ddf533f8f6295966679e8894e8f1c1c8d5e1210` |

The FFmpeg tarball was verified against the signature published on ffmpeg.org
(`ffmpeg-8.1.2.tar.xz.asc`, FFmpeg release signing key
`FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8`). The x265 tarball is the
release upload attached to the `4.2` tag on the project's Bitbucket page; x265's
own `x265Version.txt` inside it records that it is one changeset past the tag,
which is why the encoder logs `4.2+1-e444744`.

The exact FFmpeg configure line, the compiler, the macOS deployment target and
the SHA-256 of the resulting binaries are recorded in
[`resources/bin/FFMPEG_VERSION.md`](resources/bin/FFMPEG_VERSION.md) and in
`THIRD-PARTY-NOTICES.md`.

## Where to get it

Every GitHub release of SkinnyVideo attaches, next to the `.dmg` and `.zip`:

- `ffmpeg-8.1.2.tar.xz` — the FFmpeg source, byte-identical to the upstream release
- `x265_4.2.tar.gz` — the x265 source, byte-identical to the upstream release
- `build-ffmpeg.sh` — the build script, identical to `scripts/build-ffmpeg.sh` at that release's commit
- `SHA256SUMS` — checksums of the three files above

Those attachments are produced by
[`scripts/fetch-corresponding-source.sh`](scripts/fetch-corresponding-source.sh),
which `scripts/release.sh` runs at the end of every release build. It downloads
the two tarballs, refuses to continue if either checksum differs from the pins
in `build-ffmpeg.sh`, and stages everything in `dist/corresponding-source/`.

If a release is ever missing those attachments, the same files are one command
away in a checkout of the tagged commit:

```bash
scripts/fetch-corresponding-source.sh
```

## How to rebuild the binaries yourself

You need an Apple Silicon Mac with the Xcode Command Line Tools and Homebrew's
`cmake` and `pkg-config`. Nothing else from Homebrew is used, even if it is
installed; the script pins `PKG_CONFIG_LIBDIR` to its own sandbox so no other
libraries can leak in.

```bash
xcode-select --install          # if you do not have the Command Line Tools
brew install cmake pkg-config
scripts/build-ffmpeg.sh
```

The script downloads the two tarballs (or reuses cached copies), verifies their
SHA-256 and aborts on any mismatch, builds x265 as a static 8-bit + 10-bit +
12-bit library, builds FFmpeg statically against it with Apple VideoToolbox
enabled, and leaves `ffmpeg`, `ffprobe` and a `BUILD-INFO.txt` provenance file
in `~/Developer/ffmpeg-build/out/` (set `FFMPEG_BUILD_DIR` to build elsewhere).
The binaries link only `/usr/lib` and `/System/Library/Frameworks`.

### Known non-goal: byte-identical rebuilds

The build directory's path is baked into the binaries as part of FFmpeg's
configuration string (`--prefix=/Users/pritammalakar/Developer/ffmpeg-build/prefix`
in the shipped build, visible in `ffmpeg -version`), so a rebuild on another
machine or in another directory will be functionally the same but not
bit-for-bit identical, and its SHA-256 will differ from the one recorded in
`resources/bin/FFMPEG_VERSION.md`. That is deliberate: the GPL obligation is the
complete source and the scripts that control compilation, both of which are
provided above, not a reproducible-builds guarantee.

## What is not covered here

Electron, Chromium and Node.js are not GPL software and are not part of this
obligation; their licenses and third-party notices ship inside the app in
`Contents/Resources/licenses/`. The SkinnyVideo application code itself is GPL
version 2 or later and its source is this repository.
