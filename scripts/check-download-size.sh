#!/bin/sh
# Keep the published download size honest.
#
# README.md and site/*.html state the download as "about NNN MB" (decimal MB,
# rounded UP so it survives a few releases without edits). Exits non-zero if
# the figure is missing, disagrees between files, or the dmg has outgrown it by
# more than 10 MB. Fix: raise the figure (round up) in README.md and site/ together.
#
# Usage: sh scripts/check-download-size.sh <dmg> [repo-root]
set -eu

DMG="${1:?usage: check-download-size.sh <dmg> [repo-root]}"
ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
SLACK_MB=10

if [ ! -f "$DMG" ]; then
  echo "release: download-size check — $DMG not found." >&2
  exit 1
fi
dmg_bytes=$(stat -f %z "$DMG")

published=$(grep -ohE 'about [0-9]+ MB' "$ROOT/README.md" "$ROOT"/site/*.html | grep -oE '[0-9]+' | sort -u)
if [ -z "$published" ]; then
  echo "release: no \"about NNN MB\" download size found in README.md or site/*.html — cannot check it. Refusing to continue." >&2
  exit 1
fi
if [ "$(printf '%s\n' "$published" | wc -l | tr -d ' ')" -ne 1 ]; then
  echo "release: README.md and site/*.html disagree on the download size ($(printf '%s MB ' $published)). Make them match. Refusing to continue." >&2
  exit 1
fi

dmg_mb=$(( (dmg_bytes + 999999) / 1000000 ))
if [ "$dmg_bytes" -gt $(( (published + SLACK_MB) * 1000000 )) ]; then
  echo "release: $DMG is $dmg_bytes bytes (about $dmg_mb MB) — more than $SLACK_MB MB over the published \"about $published MB\" in README.md and site/*.html. Raise that figure (round up) in both, then release again." >&2
  exit 1
fi
echo "release: download size ok — $dmg_bytes bytes (about $dmg_mb MB) vs published \"about $published MB\""
