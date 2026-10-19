#!/usr/bin/env bash
# Benchmark one source through SkinnyVideo's own encode command.
#
#   scripts/bench.sh [--keep] [--quality N | --crf N] <source> <regular|better>
#
#   regular  Make It Fast    (hevc_videotoolbox; --quality is -q:v, capped at 85)
#   better   Slow But Better (libx265; --crf overrides the CRF)
#
# The ffmpeg binary and argv come from scripts/print-args.js, which calls the
# pipeline's buildArgs, so this measures exactly what the app runs (the
# primary encode; the app's fallback chain is not exercised). Prints the
# machine, a table, and one JSON line (last line of stdout). Work files go in a
# temp folder that is deleted on exit unless --keep is given.
#
# Quality: PSNR and SSIM over EVERY frame, output vs source, at the SOURCE's
# pixel format and range (alpha dropped, semi-planar mapped to planar of the
# same depth), with the source put on the output's constant frame grid. The
# output is converted up to that format; the source is never reduced to 8-bit. HDR is compared on the coded PQ/HLG signal, no tone mapping.
set -euo pipefail

KEEP=0; QFLAG=(); POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    --quality|--crf) [ $# -ge 2 ] || { echo "bench: $1 needs a value" >&2; exit 2; }; QFLAG=("$1" "$2"); shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) POS+=("$1"); shift ;;
  esac
done
[ ${#POS[@]} -eq 2 ] || { echo "usage: bench.sh [--keep] [--quality N | --crf N] <source> <regular|better>" >&2; exit 2; }
SRC="${POS[0]}"; TIER="${POS[1]}"
[ -f "$SRC" ] || { echo "bench: no such file: $SRC" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sv-bench.XXXXXX")"
cleanup() { if [ "$KEEP" = 1 ]; then echo "bench: kept work files in $WORK" >&2; else rm -rf "$WORK"; fi; }
trap cleanup EXIT
OUT="$WORK/out.mp4"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
jget() { node -e 'const v = process.argv[2].split(".").reduce((o, k) => o[k], require(process.argv[1])); process.stdout.write(String(v))' "$WORK/plan.json" "$1"; }

node "$ROOT/scripts/print-args.js" "$SRC" "$TIER" "$OUT" ${QFLAG[@]+"${QFLAG[@]}"} > "$WORK/plan.json"
FFMPEG="$(jget ffmpeg)"; FFPROBE="$(jget ffprobe)"
ARGS=()
while IFS= read -r -d '' a; do ARGS+=("$a"); done < <(node -e 'for (const a of require(process.argv[1]).argv) process.stdout.write(a + "\0")' "$WORK/plan.json")

# Machine
CHIP="$(sysctl -n machdep.cpu.brand_string)"
MACOS="$(sw_vers -productVersion) ($(sw_vers -buildVersion))"
FFVER="$("$FFMPEG" -hide_banner -version | head -1)"
X265VER="$("$FFMPEG" -hide_banner -loglevel info -f lavfi -i color=s=64x64:d=0.04 -c:v libx265 -f null - 2>&1 | grep -o 'HEVC encoder version [^ ]*' | head -1 | awk '{print $4}')"

# Encode, timed wall-clock.
T0="$(now)"; set +e
"$FFMPEG" "${ARGS[@]}" 2> "$WORK/encode.log"; RC=$?
set -e; T1="$(now)"

# Quality, full length, at the source's pixel format and range.
QRC=0
if [ "$RC" = 0 ]; then
  CMP="$(node -e '
    const plan = require(process.argv[1]);
    const out = JSON.parse(require("child_process").execFileSync(plan.ffprobe, ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", process.argv[2]])).streams[0];
    const SEMI = { nv12: "yuv420p", nv16: "yuv422p", nv24: "yuv444p", p010le: "yuv420p10le", p012le: "yuv420p12le", p016le: "yuv420p16le",
                   p210le: "yuv422p10le", p212le: "yuv422p12le", p216le: "yuv422p16le", p410le: "yuv444p10le", p412le: "yuv444p12le", p416le: "yuv444p16le" };
    let f = plan.source.pix_fmt;
    f = SEMI[f] || f;
    f = f.replace(/^yuvj/, "yuv").replace(/^yuva/, "yuv").replace(/^gbrap/, "gbrp");
    if (/^(rgb|bgr|argb|abgr|rgba|bgra)/.test(f)) f = /48|64/.test(f) ? "gbrp16le" : "gbrp";
    const rng = (r) => (r === "pc" ? "full" : "limited");
    const srcRange = rng(plan.source.color_range || (/^yuvj/.test(plan.source.pix_fmt) ? "pc" : "tv"));
    const outRange = rng(out.color_range);
    console.log([f, srcRange, outRange, out.pix_fmt, out.codec_name, out.r_frame_rate, out.duration || ""].join(" "));
  ' "$WORK/plan.json" "$OUT")"
  read -r CMP_FMT SRC_RANGE OUT_RANGE OUT_PIX OUT_CODEC OUT_RATE OUT_DUR <<< "$CMP"
  # The app writes a constant-rate MP4. A variable-rate source (iPhone timestamps
  # jitter by a tick) is put on the output's frame grid with the same fps
  # conversion ffmpeg applied, so each output frame meets the source frame it
  # was made from. Pairing by raw timestamp would compare against a neighbour.
  GRAPH="[0:v]setpts=PTS-STARTPTS,scale=in_range=${OUT_RANGE}:out_range=${SRC_RANGE}:flags=accurate_rnd+full_chroma_int,format=${CMP_FMT},split[d1][d2];"
  GRAPH+="[1:v]setpts=PTS-STARTPTS,fps=${OUT_RATE},scale=in_range=${SRC_RANGE}:out_range=${SRC_RANGE}:flags=accurate_rnd+full_chroma_int,format=${CMP_FMT},split[r1][r2];"
  GRAPH+="[d1][r1]psnr=stats_file=${WORK}/psnr.log;[d2][r2]ssim"
  set +e
  "$FFMPEG" -hide_banner -nostats -loglevel info -i "$OUT" -i "$SRC" -lavfi "$GRAPH" -f null - 2> "$WORK/quality.log"; QRC=$?
  set -e
fi

ENC_RC="$RC" QUAL_RC="$QRC" T0="$T0" T1="$T1" CHIP="$CHIP" MACOS="$MACOS" FFVER="$FFVER" X265VER="$X265VER" \
CMP_FMT="${CMP_FMT:-}" SRC_RANGE="${SRC_RANGE:-}" OUT_PIX="${OUT_PIX:-}" OUT_CODEC="${OUT_CODEC:-}" OUT_DUR="${OUT_DUR:-}" \
node -e '
  const fs = require("fs"), path = require("path");
  const [planFile, outFile, workDir, srcPath, root] = process.argv.slice(1);
  const { humanBytes } = require(path.join(root, "src/encoder/pipeline"));
  const plan = require(planFile), E = process.env;
  const read = (f) => { try { return fs.readFileSync(path.join(workDir, f), "utf8"); } catch { return ""; } };
  const wall = Number(E.T1) - Number(E.T0);
  const outBytes = Number(E.ENC_RC) === 0 && fs.existsSync(outFile) ? fs.statSync(outFile).size : null;
  const q = read("quality.log");
  const num = (re) => { const m = q.match(re); return m ? Number(m[1]) : null; };
  const psnrLine = (q.match(/PSNR (y:.*)$/m) || [])[1] || "";
  const psnrVal = (k) => { const m = psnrLine.match(new RegExp(k + ":(inf|[0-9.]+)")); return m ? (m[1] === "inf" ? Infinity : Number(m[1])) : null; };
  const frames = read("psnr.log").split("\n").filter(Boolean).length || null;
  const r = {
    clip: path.basename(srcPath), path: srcPath, tier: plan.tier, settings: plan.settings,
    machine: { chip: E.CHIP, macos: E.MACOS, ffmpeg: E.FFVER, x265: E.X265VER || null },
    source: plan.source,
    encode_exit: Number(E.ENC_RC),
    encode_error: Number(E.ENC_RC) === 0 ? null : read("encode.log").split("\n").filter((l) => l && !/^frame=/.test(l)).slice(-3).join(" | "),
    wall_s: Number(wall.toFixed(2)),
    realtime_x: plan.source.duration > 0 ? Number((plan.source.duration / wall).toFixed(2)) : null,
    output: outBytes == null ? null : { bytes: outBytes, codec: E.OUT_CODEC, pix_fmt: E.OUT_PIX, duration: Number(E.OUT_DUR) || null },
    reclaim_pct: outBytes == null ? null : Number(((1 - outBytes / plan.source.bytes) * 100).toFixed(1)),
    compare: outBytes == null ? null : { pix_fmt: E.CMP_FMT, range: E.SRC_RANGE, frames, exit: Number(E.QUAL_RC) },
    psnr_db: outBytes == null ? null : { y: psnrVal("y"), u: psnrVal("u"), v: psnrVal("v"), average: psnrVal("average"), min: psnrVal("min") },
    ssim: outBytes == null ? null : { y: num(/SSIM Y:([0-9.]+)/), u: num(/ U:([0-9.]+)/), v: num(/ V:([0-9.]+)/), all: num(/All:([0-9.]+)/) }
  };
  const f2 = (x) => (x == null ? "n/a" : x.toFixed(2)), f4 = (x) => (x == null ? "n/a" : x.toFixed(4));
  const s = r.source, rows = [
    ["Clip", r.clip],
    ["Source", `${s.codec}${s.profile ? " " + s.profile : ""} · ${s.width}×${s.height} · ${s.fps} fps · ${s.pix_fmt} · ${s.color_transfer || "unspecified"} · ${s.duration.toFixed(2)} s`],
    ["Tier", `${r.tier} · ${JSON.stringify(r.settings)}`],
    ["Machine", `${r.machine.chip} · macOS ${r.machine.macos}`],
    ["Engine", `${r.machine.ffmpeg} · x265 ${r.machine.x265}`],
    ["Encode", r.encode_exit === 0 ? `${r.wall_s} s wall · ${r.realtime_x}× realtime` : `FAILED (exit ${r.encode_exit}): ${r.encode_error}`]
  ];
  if (r.output) rows.push(
    ["Size", `${humanBytes(s.bytes)} → ${humanBytes(r.output.bytes)} · reclaim ${r.reclaim_pct}%`],
    ["Output", `${r.output.codec} · ${r.output.pix_fmt}`],
    ["Compared", `${r.compare.frames} frames at ${r.compare.pix_fmt} (${r.compare.range} range)${r.compare.exit ? " — comparison FAILED, exit " + r.compare.exit : ""}`],
    ["PSNR", `average ${f2(r.psnr_db.average)} dB (Y ${f2(r.psnr_db.y)} · U ${f2(r.psnr_db.u)} · V ${f2(r.psnr_db.v)} · worst frame ${f2(r.psnr_db.min)})`],
    ["SSIM", `All ${f4(r.ssim.all)} (Y ${f4(r.ssim.y)} · U ${f4(r.ssim.u)} · V ${f4(r.ssim.v)})`]
  );
  const w = Math.max(...rows.map((x) => x[0].length));
  console.log(rows.map(([k, v]) => k.padEnd(w) + "  " + v).join("\n"));
  console.log(JSON.stringify(r));
  process.exitCode = r.encode_exit === 0 && (!r.compare || r.compare.exit === 0) ? 0 : 1;
' "$WORK/plan.json" "$OUT" "$WORK" "$SRC" "$ROOT"
