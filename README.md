# SkinnyVideo

SkinnyVideo compresses video archives to HEVC on Apple Silicon Macs with no
settings to choose. Point it at files or a folder, pick a tier, and it writes
compressed copies into a new `Compressed_` folder alongside the source. Your
originals are never modified, moved or deleted.

## Requirements

- An Apple Silicon Mac (arm64). There is no Intel build.

## Install

Download the `.dmg` from the [Releases](../../releases) page, open it, and drag
SkinnyVideo to Applications. Builds are signed with a Developer ID certificate
and notarized by Apple, so they open without a Gatekeeper warning.

## License

SkinnyVideo is free software licensed under the **GNU General Public License,
version 2 or later** — see [LICENSE](LICENSE).

It is GPL rather than permissive because it bundles FFmpeg built with `libx265`,
which is GPL-licensed. Distributing the app therefore carries the GPL's
corresponding-source obligation, which is met by attaching the FFmpeg and x265
sources to each release.

The bundled `ffmpeg`/`ffprobe` are built by this repository's own pinned recipe,
[`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh) (FFmpeg + x265 + Apple
VideoToolbox, nothing else), so the two documents below describe the binary
that actually ships:

- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — every bundled component,
  its version, license and copyright notice, and the exact build configuration
- [CORRESPONDING-SOURCE.md](CORRESPONDING-SOURCE.md) — the pinned source
  tarballs and checksums attached to each release, and how to rebuild from them

The full license texts for everything shipped are also inside the app itself:
**SkinnyVideo → Third-Party Licenses** in the menu bar opens the folder, and
**About SkinnyVideo** lists the credits.

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

Electron embeds Chromium and Node.js, whose own third-party notices ship in the
app as `LICENSES.chromium.html`.
