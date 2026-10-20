#!/bin/sh
# Refuse to release a version whose CHANGELOG heading has no date.
#
# CHANGELOG.md headings read "## X.Y.Z — YYYY-MM-DD" once released and
# "## X.Y.Z — unreleased" while in progress. Exits non-zero unless the heading
# for <version> carries a date. Fix: date the heading, then release again.
#
# Usage: sh scripts/check-changelog-date.sh <version> [repo-root]
set -eu

VERSION="${1:?usage: check-changelog-date.sh <version> [repo-root]}"
ROOT="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
LOG="$ROOT/CHANGELOG.md"
V=$(printf '%s' "$VERSION" | sed 's/\./\\./g')

heading=$(grep -E "^## ${V}( |$)" "$LOG" | head -1 || true)
if [ -z "$heading" ]; then
  echo "release: CHANGELOG.md has no \"## $VERSION\" heading. Add the entry, dated, then release again." >&2
  exit 1
fi
if ! printf '%s\n' "$heading" | grep -Eq "^## ${V} — [0-9]{4}-[0-9]{2}-[0-9]{2}$"; then
  echo "release: CHANGELOG.md heading \"$heading\" has no date. Make it \"## $VERSION — YYYY-MM-DD\", then release again." >&2
  exit 1
fi
echo "release: changelog ok — $heading"
