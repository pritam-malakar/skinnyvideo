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

Two further documents will be added with the next release, once the bundled
FFmpeg has been rebuilt from a pinned, in-repo recipe so that they describe the
binary that actually ships:

- `THIRD-PARTY-NOTICES.md` — every bundled component, its version and license
- `CORRESPONDING-SOURCE.md` — how to obtain the exact sources under GPL §3

In the meantime, the full license texts for everything shipped are inside the
app itself: **SkinnyVideo → Third-Party Licenses** in the menu bar opens the
folder, and **About SkinnyVideo** lists the credits.

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
