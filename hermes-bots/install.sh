#!/usr/bin/env bash
# Usage: ./install.sh <pack> [--dry-run]
# Copies a pack into $HERMES_HOME (default ~/.hermes). Existing files are backed up as *.bak.<timestamp>.
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
if [ -f "$dest/SOUL.md" ]; then run cp "$dest/SOUL.md" "$dest/SOUL.md.bak.$ts"; fi
run cp "$src/SOUL.md" "$dest/SOUL.md"
(cd "$src/skills" && find . -name SKILL.md -print) | while read -r f; do
  d="$dest/skills/$(dirname "$f")"
  if [ -d "$d" ]; then run cp -r "$d" "$d.bak.$ts"; fi
  run mkdir -p "$d"
  run cp "$src/skills/$f" "$d/SKILL.md"
done
echo
echo "Next: merge $src/config.snippet.yaml into $dest/config.yaml (skills.auto_load), then restart: hermes gateway"
