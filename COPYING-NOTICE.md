# Copyright and licence notice

SkinnyVideo — a zero-configuration HEVC video archiver for macOS.
Copyright (C) 2026 Pritam Malakar

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program; if not, write to the Free Software Foundation, Inc.,
51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.

## Where the "or later" election lives

The SPDX identifier for this project is **`GPL-2.0-or-later`**, declared in
[`package.json`](package.json) and stated in the [README](README.md) and in
the notice above.

It is deliberately NOT stated in [`LICENSE`](LICENSE). That file is the
verbatim text of version 2 of the GNU General Public License, byte for byte
as published by the Free Software Foundation, with nothing added before or
after it. Prepending a project notice to it — which is what this file used to
be — stops automated licence detection from recognising the text: GitHub
reported the repository as "Other" (`NOASSERTION`) for exactly that reason.
The GPL itself asks for the per-program notice to be attached to the program's
source, not spliced into the licence text, so the two live apart here.

## Why GPL and not something permissive

SkinnyVideo bundles an `ffmpeg`/`ffprobe` built with `libx265`, which is
GPL-licensed, so distributing the app carries the GPL's corresponding-source
obligation. That obligation is met by attaching the pinned FFmpeg and x265
sources to every release.

- [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — every bundled
  component, its version, licence and copyright notice, and the exact build
  configuration.
- [`CORRESPONDING-SOURCE.md`](CORRESPONDING-SOURCE.md) — the pinned source
  tarballs and checksums attached to each release, and how to rebuild from
  them.
