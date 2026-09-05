# Third-party notices

SkinnyVideo is free software under the GNU General Public License, version 2 or
later (see [LICENSE](LICENSE)). The application ships the following third-party
components. The full license texts are shipped inside the app in
`Contents/Resources/licenses/` (menu: **SkinnyVideo → Third-Party Licenses**),
and the GNU GPL version 2 text is in this repository's [LICENSE](LICENSE) file.

## FFmpeg 8.1.2 — GPL-2.0-or-later

Copyright (c) 2000-2026 the FFmpeg developers. <https://ffmpeg.org>

This software uses code of FFmpeg licensed under the GPLv2 and its source can be
downloaded from the project's releases page. FFmpeg is licensed under the LGPL
v2.1 or later by default; SkinnyVideo's bundled build passes `--enable-gpl` and
links the GPL-licensed x265 encoder, so, as FFmpeg's own `LICENSE.md` states,
the license of the bundled FFmpeg is the GNU General Public License version 2 or
later. The build contains no `--enable-nonfree` component.

Notice from FFmpeg's `COPYING.GPLv2` (the GNU GPL version 2):

> This program is free software; you can redistribute it and/or modify it under
> the terms of the GNU General Public License as published by the Free Software
> Foundation; either version 2 of the License, or (at your option) any later
> version.
>
> This program is distributed in the hope that it will be useful, but WITHOUT
> ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
> FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

The bundled `ffmpeg` and `ffprobe` are built from the unmodified upstream
release tarball by [`scripts/build-ffmpeg.sh`](scripts/build-ffmpeg.sh) with
exactly this configure line (as passed to `./configure`; `ffmpeg -version`
prints the same line with the two `--extra-*` values in single quotes):

```
./configure --prefix=/Users/pritammalakar/Developer/ffmpeg-build/prefix --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libx265 --enable-videotoolbox --enable-static --disable-shared --pkg-config-flags=--static --enable-neon --enable-runtime-cpudetect --disable-ffplay --disable-doc --disable-debug --disable-htmlpages --disable-manpages --disable-sdl2 --disable-xlib --disable-libxcb --extra-cflags=-mmacosx-version-min=11.0 --extra-ldflags=-mmacosx-version-min=11.0
```

Apart from x265, the only libraries the binaries use are parts of macOS itself
(VideoToolbox, AudioToolbox, AVFoundation, CoreImage, AppKit, Security, zlib,
bzip2, iconv, libc++), which are not distributed with the app. Source tarball,
checksums and rebuild instructions: [CORRESPONDING-SOURCE.md](CORRESPONDING-SOURCE.md).

## x265 4.2 — GPL-2.0-or-later

Copyright (C) 2013-2020 MulticoreWare, Inc. <https://x265.org>

x265 is the HEVC software encoder behind the "Slow But Better" tier. It is
distributed under the GNU General Public License version 2 or later (x265's
`COPYING` file is the GPL version 2 text, reproduced in [LICENSE](LICENSE));
a commercial license is also available from MulticoreWare. Bundled as a static
8-bit + 10-bit + 12-bit library, built from the unmodified upstream release
tarball `x265_4.2.tar.gz` (the encoder reports itself as `4.2+1-e444744`).

Notice from x265's `COPYING` (the GNU GPL version 2):

> This program is free software; you can redistribute it and/or modify it under
> the terms of the GNU General Public License as published by the Free Software
> Foundation; either version 2 of the License, or (at your option) any later
> version.
>
> This program is distributed in the hope that it will be useful, but WITHOUT
> ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
> FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

## Apple VideoToolbox

The "Make It Fast" tier uses the HEVC hardware encoder exposed by Apple's
VideoToolbox framework, part of macOS. No Apple code is redistributed.

## Electron 33 (MIT), with Chromium and Node.js

Copyright (c) Electron contributors; Copyright (c) 2013-2020 GitHub Inc.
<https://www.electronjs.org> — MIT License. Electron's license ships in the
app as `licenses/LICENSE.electron.txt`. Electron embeds Chromium and Node.js;
the complete set of their third-party notices ships in the app as
`licenses/LICENSES.chromium.html`.

## Fonts — SIL Open Font License 1.1

Copyright lines below are read from the bundled font files' name tables.

- **Geist** (Regular, version 1.800) — Copyright 2024 The Geist Project Authors
  (<https://github.com/vercel/geist-font>)
- **Geist Mono** (Regular, version 1.700) — Copyright 2024 The Geist Project
  Authors (<https://github.com/vercel/geist-font.git>)
- **Poppins** (Medium, version 4.004) — Copyright 2020 The Poppins Project
  Authors (<https://github.com/itfoundry/Poppins>); the accompanying license
  file also credits Copyright 2014-2019 Indian Type Foundry

All three are licensed under the SIL Open Font License, Version 1.1
(<https://openfontlicense.org>). The license texts ship next to the font files
(`src/renderer/fonts/LICENSE-Geist.txt`, `src/renderer/fonts/LICENSE-Poppins.txt`)
and, readable from Finder, in the app's `licenses/` folder. The fonts are
subsetted to the Latin range and repackaged as WOFF2; they are not sold on their
own and no Reserved Font Name is used.
