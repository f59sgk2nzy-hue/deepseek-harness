#!/usr/bin/env bash
# Usage: ./install.sh <pack> [--dry-run]
# Copies a pack into $HERMES_HOME (default ~/.hermes). Replaced files are backed up under $HERMES_HOME/backups/<timestamp>/.
set -euo pipefail
pack="${1:?usage: install.sh <pack> [--dry-run]}"
dry="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/packs/$pack"
dest="${HERMES_HOME:-$HOME/.hermes}"
[ -d "$src" ] || { echo "unknown pack: $pack (have: $(ls "$here/packs" | tr '\n' ' '))" >&2; exit 1; }
ts="$(date +%Y%m%d%H%M%S)"
run() { if [ "$dry" = "--dry-run" ]; then echo "$*"; else "$@"; fi; }
run mkdir -p "$dest/skills"
bak="$dest/backups/$ts"
if [ -f "$dest/SOUL.md" ]; then run mkdir -p "$bak"; run cp "$dest/SOUL.md" "$bak/SOUL.md"; fi
run cp "$src/SOUL.md" "$dest/SOUL.md"
(cd "$src/skills" && find . -name SKILL.md -print) | while read -r f; do
  d="$dest/skills/$(dirname "$f")"
  if [ -d "$d" ]; then run mkdir -p "$bak/skills/$(dirname "$f")"; run cp -r "$d/." "$bak/skills/$(dirname "$f")/"; fi
  run mkdir -p "$d"
  run cp -r "$src/skills/$(dirname "$f")/." "$d/"
  # Keep a company profile the user already filled in.
  prof="$bak/skills/$(dirname "$f")/references/company-profile.md"
  if [ -f "$prof" ]; then run cp "$prof" "$d/references/company-profile.md"; fi
done
echo
echo "Next: merge $src/config.snippet.yaml into $dest/config.yaml (skills.auto_load), then restart: hermes gateway"
