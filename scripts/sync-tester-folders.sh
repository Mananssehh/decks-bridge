#!/usr/bin/env bash
# Copy latest release artifacts into tester-facing folders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC_SRC="$ROOT/release/mac"
MAC_DST="$ROOT/decks bridge Mac"
WIN_SRC="$ROOT/release/windows"
WIN_DST="$ROOT/windows"

sync_mac() {
  mkdir -p "$MAC_DST"
  rm -rf "$MAC_DST/Decks Bridge.app"
  if [[ ! -d "$MAC_SRC" ]]; then
    echo "Skip Mac: no $MAC_SRC (run npm run build:internal first)"
    return 0
  fi

  for f in "Decks Bridge.dmg" "Decks Bridge.zip"; do
    [[ -f "$MAC_SRC/$f" ]] && cp -f "$MAC_SRC/$f" "$MAC_DST/"
  done

  cp -f "$ROOT/TEST_INSTALL.md" "$MAC_DST/TEST_INSTALL.md"
  [[ -f "$MAC_DST/README.md" ]] || cp -f "$ROOT/decks bridge Mac/README.md" "$MAC_DST/README.md"

  echo "Mac tester folder: $MAC_DST"
  ls -lh "$MAC_DST" 2>/dev/null || true
}

sync_windows_docs() {
  mkdir -p "$WIN_DST"
  cp -f "$ROOT/TEST_INSTALL_WINDOWS.md" "$WIN_DST/TEST_INSTALL.md"
  cp -f "$ROOT/windows/README.md" "$WIN_DST/README.md" 2>/dev/null || true

  if [[ -d "$WIN_SRC" ]]; then
    for f in "Decks Bridge Setup.exe" "Decks Bridge Portable.exe" "Decks Bridge.zip"; do
      [[ -f "$WIN_SRC/$f" ]] && cp -f "$WIN_SRC/$f" "$WIN_DST/"
    done
  fi

  echo "Windows tester folder: $WIN_DST"
  ls -lh "$WIN_DST" 2>/dev/null || true
}

sync_mac
sync_windows_docs

echo ""
echo "Send to testers:"
echo "  Mac:     $MAC_DST"
echo "  Windows: $WIN_DST"
