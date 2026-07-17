#!/usr/bin/env bash
# Write SHA256 manifest for release/mac and release/windows artifacts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/release/SHA256SUMS.txt"

{
  echo "# Decks Bridge release checksums — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo ""
  if [[ -d "$ROOT/release/mac" ]]; then
    echo "## macOS"
    find "$ROOT/release/mac" -type f ! -name '.DS_Store' -print0 | sort -z | while IFS= read -r -d '' f; do
      shasum -a 256 "$f" | awk -v p="$f" '{print $1 "  " p}'
    done
    echo ""
  fi
  if [[ -d "$ROOT/release/windows" ]]; then
    echo "## Windows (build on Windows to populate)"
    find "$ROOT/release/windows" -type f -print0 2>/dev/null | sort -z | while IFS= read -r -d '' f; do
      shasum -a 256 "$f" | awk -v p="$f" '{print $1 "  " p}'
    done
  fi
} > "$MANIFEST"

echo "Wrote $MANIFEST"
cat "$MANIFEST"
