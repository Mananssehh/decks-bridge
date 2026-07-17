#!/usr/bin/env bash
# Remove legacy LSRequiresCarbon from bundled macOS Info.plist (deprecated since 10.4).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Honor CARGO_TARGET_DIR (builds use a local non-iCloud target dir); fall back
# to the in-project target for legacy invocations.
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
BUNDLE_PLIST="$TARGET_DIR/release/bundle/macos/Decks Bridge.app/Contents/Info.plist"

strip_key() {
  local plist="$1"
  if [[ -f "$plist" ]]; then
    /usr/libexec/PlistBuddy -c "Delete :LSRequiresCarbon" "$plist" 2>/dev/null || true
    echo "Stripped LSRequiresCarbon from: $plist"
  fi
}

strip_key "$BUNDLE_PLIST"

# Universal / cross-target output paths
for plist in "$TARGET_DIR"/*/release/bundle/macos/Decks\ Bridge.app/Contents/Info.plist; do
  strip_key "$plist"
done
