#!/bin/bash
# scripts/build-ffmpeg.sh — build SkinnyVideo's bundled ffmpeg + ffprobe.
#
# Produces a MINIMAL, statically linked, arm64 FFmpeg pair: native FFmpeg
# codecs/filters/formats + libx265 (8/10/12-bit multilib) + Apple VideoToolbox.
# Nothing else. The result links only /usr/lib and /System/Library/Frameworks.
#
# Reproducible from a clean Mac with only:
#   - Xcode Command Line Tools (/usr/bin/clang, /usr/bin/libtool, make)
#   - Homebrew cmake + pkg-config   (brew install cmake pkg-config)
# NO Homebrew ffmpeg/x265/any other library is used, even if installed:
# PKG_CONFIG_LIBDIR is pinned to the sandbox prefix and Homebrew's bin dir is
# kept off PATH (only cmake and pkg-config are symlinked into a tools dir).
#
# Sources are pinned by URL + sha256; a mismatch aborts before anything builds.
#
# Usage:  scripts/build-ffmpeg.sh
#   FFMPEG_BUILD_DIR   work dir (default ~/Developer/ffmpeg-build)
#   JOBS               parallel make jobs (default: hw.ncpu)
# Output: $FFMPEG_BUILD_DIR/out/{ffmpeg,ffprobe,BUILD-INFO.txt}
# This script never touches resources/bin — copying the result in is a
# separate, gated step.
set -euo pipefail

# ─── Pins ────────────────────────────────────────────────────────────────
FFMPEG_VERSION="8.1.2"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"
# ffmpeg.org publishes no sha256 file; the pin above was taken after verifying
# the tarball's .asc with the FFmpeg release signing key
# FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8 (https://ffmpeg.org/ffmpeg-devel.asc).

X265_VERSION="4.2"
X265_URL="https://bitbucket.org/multicoreware/x265_git/downloads/x265_${X265_VERSION}.tar.gz"
X265_SHA256="40b1ea0453e0309f0eba934e0ddf533f8f6295966679e8894e8f1c1c8d5e1210"

# Minimum macOS of the app (Electron 33 → 11.0). Passed to cmake AND ffmpeg.
DEPLOYMENT_TARGET="11.0"

# ─── Layout ──────────────────────────────────────────────────────────────
WORK="${FFMPEG_BUILD_DIR:-$HOME/Developer/ffmpeg-build}"
SRC="$WORK/src"
PREFIX="$WORK/prefix"
OUT="$WORK/out"
TOOLS="$WORK/tools/bin"
LOGS="$WORK/logs"
JOBS="${JOBS:-$(sysctl -n hw.ncpu)}"

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ─── Toolchain check ─────────────────────────────────────────────────────
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || die "this recipe targets Apple Silicon macOS only"
for t in /usr/bin/clang /usr/bin/clang++ /usr/bin/libtool /usr/bin/make; do
  [[ -x "$t" ]] || die "missing $t — install Xcode Command Line Tools (xcode-select --install)"
done
CMAKE_BIN="$(command -v cmake || true)";       [[ -n "$CMAKE_BIN" ]]   || die "cmake not found (brew install cmake)"
PKGCONF_BIN="$(command -v pkg-config || true)"; [[ -n "$PKGCONF_BIN" ]] || die "pkg-config not found (brew install pkg-config)"
for t in curl shasum tar xz; do command -v "$t" >/dev/null || die "missing $t"; done

# ─── Isolated environment ────────────────────────────────────────────────
# Only the sandbox prefix, the system toolchain, and a tools dir holding just
# cmake + pkg-config are on PATH. No Homebrew bin dir, no Homebrew .pc files.
rm -rf "$WORK/tools"; mkdir -p "$TOOLS" "$SRC" "$OUT" "$LOGS"
ln -sf "$CMAKE_BIN" "$TOOLS/cmake"
ln -sf "$PKGCONF_BIN" "$TOOLS/pkg-config"
export PATH="$PREFIX/bin:$TOOLS:/usr/bin:/bin:/usr/sbin:/sbin"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"   # LIBDIR replaces the default search list entirely
unset PKG_CONFIG_PATH PKG_CONFIG_SYSROOT_DIR CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH \
      CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CC CXX SDKROOT
export MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"

# ─── Fetch + verify ──────────────────────────────────────────────────────
fetch() { # fetch <url> <dest> <sha256>
  local url="$1" dest="$2" want="$3" have
  if [[ -f "$dest" ]]; then
    have="$(shasum -a 256 "$dest" | awk '{print $1}')"
    if [[ "$have" == "$want" ]]; then log "reusing $(basename "$dest") (sha256 ok)"; return; fi
    log "$(basename "$dest") present but sha256 mismatch — re-downloading"; rm -f "$dest"
  fi
  log "downloading $url"
  curl -fsSL --retry 3 -o "$dest.part" "$url" && mv "$dest.part" "$dest"
  have="$(shasum -a 256 "$dest" | awk '{print $1}')"
  [[ "$have" == "$want" ]] || die "sha256 MISMATCH for $(basename "$dest")
  expected $want
  got      $have"
  log "$(basename "$dest") sha256 ok"
}
FFMPEG_TARBALL="$SRC/ffmpeg-${FFMPEG_VERSION}.tar.xz"
X265_TARBALL="$SRC/x265_${X265_VERSION}.tar.gz"
fetch "$FFMPEG_URL" "$FFMPEG_TARBALL" "$FFMPEG_SHA256"
fetch "$X265_URL"   "$X265_TARBALL"   "$X265_SHA256"

# ─── Clean sandbox: fresh prefix + fresh source trees every run ──────────
log "resetting $PREFIX and source trees"
rm -rf "$PREFIX" "$SRC/ffmpeg-${FFMPEG_VERSION}" "$SRC/x265_${X265_VERSION}"
mkdir -p "$PREFIX"
tar -xJf "$FFMPEG_TARBALL" -C "$SRC"
tar -xzf "$X265_TARBALL"   -C "$SRC"
[[ -d "$SRC/ffmpeg-${FFMPEG_VERSION}" && -d "$SRC/x265_${X265_VERSION}/source" ]] || die "unexpected tarball layout"

# ─── x265: multilib static (8bit + 10bit + 12bit in ONE libx265.a) ───────
# Follows x265's own build/linux/multilib.sh procedure, static-only, with the
# deployment target and Apple toolchain pinned. libtool -static merges the
# three archives (the documented Mac/BSD path in that script).
X265_SRC="$SRC/x265_${X265_VERSION}/source"
X265_BUILD="$SRC/x265_${X265_VERSION}/build/skinnyvideo"
mkdir -p "$X265_BUILD"/{8bit,10bit,12bit}
X265_COMMON=(
  -G "Unix Makefiles"
  -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_COMPILER=/usr/bin/clang
  -DCMAKE_CXX_COMPILER=/usr/bin/clang++
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"
  -DCMAKE_OSX_ARCHITECTURES=arm64
  -DENABLE_SHARED=OFF
  -DENABLE_CLI=OFF
  -DENABLE_ASSEMBLY=ON
)

log "x265 ${X265_VERSION}: 12-bit"
( cd "$X265_BUILD/12bit"
  cmake "${X265_COMMON[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF -DMAIN12=ON "$X265_SRC" 2>&1 | tee "$LOGS/x265-12bit-cmake.log"
  make -j"$JOBS" 2>&1 | tee "$LOGS/x265-12bit-make.log" | grep -E 'Linking|error' || true
  [[ -f libx265.a ]] || die "x265 12-bit build produced no libx265.a" )

log "x265 ${X265_VERSION}: 10-bit"
( cd "$X265_BUILD/10bit"
  cmake "${X265_COMMON[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF "$X265_SRC" 2>&1 | tee "$LOGS/x265-10bit-cmake.log"
  make -j"$JOBS" 2>&1 | tee "$LOGS/x265-10bit-make.log" | grep -E 'Linking|error' || true
  [[ -f libx265.a ]] || die "x265 10-bit build produced no libx265.a" )

log "x265 ${X265_VERSION}: 8-bit (linking 10/12-bit) + merge + install"
( cd "$X265_BUILD/8bit"
  ln -sf ../10bit/libx265.a libx265_main10.a
  ln -sf ../12bit/libx265.a libx265_main12.a
  cmake "${X265_COMMON[@]}" -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DEXTRA_LIB="x265_main10.a;x265_main12.a" -DEXTRA_LINK_FLAGS=-L. \
        -DLINKED_10BIT=ON -DLINKED_12BIT=ON "$X265_SRC" 2>&1 | tee "$LOGS/x265-8bit-cmake.log"
  grep -q "Detected ARM64 target processor" "$LOGS/x265-8bit-cmake.log" || die "x265: ARM64 (NEON) not detected by cmake"
  make -j"$JOBS" 2>&1 | tee "$LOGS/x265-8bit-make.log" | grep -E 'Linking|error' || true
  [[ -f libx265.a ]] || die "x265 8-bit build produced no libx265.a"
  mv libx265.a libx265_main.a
  /usr/bin/libtool -static -o libx265.a libx265_main.a libx265_main10.a libx265_main12.a 2>/dev/null
  make install 2>&1 | tee "$LOGS/x265-install.log" | grep -E 'Installing|error' || true )
[[ -f "$PREFIX/lib/libx265.a" && -f "$PREFIX/lib/pkgconfig/x265.pc" ]] || die "x265 install incomplete"
[[ ! -e "$PREFIX/lib/libx265.dylib" ]] || die "x265 produced a dylib — static-only build violated"
log "x265 pkg-config (static): $(pkg-config --static --libs x265)"

# ─── FFmpeg ──────────────────────────────────────────────────────────────
FFMPEG_SRC="$SRC/ffmpeg-${FFMPEG_VERSION}"
FFMPEG_CONFIGURE=(
  --prefix="$PREFIX" --arch=arm64 --cc=/usr/bin/clang
  --enable-gpl --enable-libx265 --enable-videotoolbox
  --enable-static --disable-shared --pkg-config-flags=--static
  --enable-neon --enable-runtime-cpudetect
  --disable-ffplay --disable-doc --disable-debug --disable-htmlpages --disable-manpages
  --disable-sdl2 --disable-xlib --disable-libxcb
  --extra-cflags="-mmacosx-version-min=${DEPLOYMENT_TARGET}"
  --extra-ldflags="-mmacosx-version-min=${DEPLOYMENT_TARGET}"
)
log "FFmpeg ${FFMPEG_VERSION}: configure"
( cd "$FFMPEG_SRC"
  ./configure "${FFMPEG_CONFIGURE[@]}" 2>&1 | tee "$LOGS/ffmpeg-configure.log" | tail -n 5 \
    || { tail -n 40 ffbuild/config.log; die "ffmpeg configure failed"; }
  grep -q '^CONFIG_LIBX265=yes'          ffbuild/config.mak || die "configure did not enable libx265"
  grep -q '^CONFIG_VIDEOTOOLBOX=yes'     ffbuild/config.mak || die "configure did not enable videotoolbox"
  grep -q '^CONFIG_HEVC_VIDEOTOOLBOX_ENCODER=yes' ffbuild/config.mak || die "hevc_videotoolbox encoder not enabled"
  # Belt and braces: the ONLY external libraries allowed are libx265 plus the
  # macOS SDK/system components FFmpeg autodetects (frameworks + /usr/lib).
  # Anything else (a Homebrew lib leaking in, an extra --enable-lib*) aborts.
  ALLOWED_EXT="appkit avfoundation bzlib coreimage iconv libx265 lzma securetransport zlib audiotoolbox videotoolbox"
  ENABLED_EXT="$(sed -n '/^External libraries:/,/^Libraries:/p' "$LOGS/ffmpeg-configure.log" | grep -v -E '^(External libraries|Libraries)' | tr -s ' \t' '\n' | grep -v '^$' | sort -u)"
  for lib in $ENABLED_EXT; do
    case " $ALLOWED_EXT " in *" $lib "*) ;; *) die "unexpected external library enabled: $lib" ;; esac
  done
  log "external libraries: $(echo $ENABLED_EXT | tr '\n' ' ')"
  log "FFmpeg ${FFMPEG_VERSION}: make -j$JOBS"
  make -j"$JOBS" 2>&1 | tee "$LOGS/ffmpeg-make.log" | grep -E '^(LD|error)' || true
  make install 2>&1 | tee "$LOGS/ffmpeg-install.log" | grep -E '^INSTALL.*bin/(ffmpeg|ffprobe)$' || true )
[[ -x "$PREFIX/bin/ffmpeg" && -x "$PREFIX/bin/ffprobe" ]] || die "ffmpeg/ffprobe not installed into $PREFIX/bin"

# ─── Stage output + provenance ───────────────────────────────────────────
log "staging into $OUT"
rm -f "$OUT/ffmpeg" "$OUT/ffprobe" "$OUT/BUILD-INFO.txt"
cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$OUT/"
chmod 755 "$OUT/ffmpeg" "$OUT/ffprobe"

# Sanity: static — only system libs/frameworks may be linked.
for b in ffmpeg ffprobe; do
  if otool -L "$OUT/$b" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/Library/Frameworks/)'; then
    die "$b links a non-system library (see above)"
  fi
done

FFMPEG_OUT_SHA="$(shasum -a 256 "$OUT/ffmpeg"  | awk '{print $1}')"
FFPROBE_OUT_SHA="$(shasum -a 256 "$OUT/ffprobe" | awk '{print $1}')"
# x265's release tarballs carry x265Version.txt (tag + changeset) — the same
# values the encoder reports at runtime ("HEVC encoder version 4.2+1-e444744").
X265_TAG_LINE="$(grep -E '^(releasetag|repositorychangeset|releasetagdistance):' "$SRC/x265_${X265_VERSION}/x265Version.txt" | tr -d '\r' | sed 's/: */=/' | tr '\n' ' ')"
{
  echo "SkinnyVideo bundled FFmpeg — build provenance"
  echo "build date:          $(date -u '+%Y-%m-%d %H:%M:%SZ')"
  echo "built by:            scripts/build-ffmpeg.sh on $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
  echo "compiler:            $(/usr/bin/clang --version | head -n 1)"
  echo "deployment target:   macOS ${DEPLOYMENT_TARGET}"
  echo
  echo "FFmpeg version:      ${FFMPEG_VERSION}"
  echo "FFmpeg tarball:      ${FFMPEG_URL}"
  echo "FFmpeg sha256:       ${FFMPEG_SHA256}"
  echo "x265 release:        ${X265_VERSION}  (${X265_TAG_LINE})"
  echo "x265 tarball:        ${X265_URL}"
  echo "x265 sha256:         ${X265_SHA256}"
  echo
  echo "configure line:"
  printf '  ./configure'; printf ' %q' "${FFMPEG_CONFIGURE[@]}"; echo
  echo
  echo "ffmpeg -version:"
  "$OUT/ffmpeg" -hide_banner -version | grep -v '^Exiting with exit code' | sed 's/^/  /'
  echo
  echo "output sha256:"
  echo "  ffmpeg   ${FFMPEG_OUT_SHA}"
  echo "  ffprobe  ${FFPROBE_OUT_SHA}"
} > "$OUT/BUILD-INFO.txt"

log "done"
cat "$OUT/BUILD-INFO.txt"
