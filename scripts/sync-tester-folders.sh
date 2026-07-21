#!/usr/bin/env bash
# Copy latest release artifacts into tester-facing folders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAC_SRC="$ROOT/release/mac"
MAC_DST="$ROOT/decks bridge Mac"
WIN_SRC="$ROOT/release/windows"
WIN_DST="$ROOT/windows"

# Refuse to publish an artifact whose app is not notarized (Gatekeeper-accepted).
# "decks bridge Mac" is a shareable folder; an ad-hoc/self-signed build copied
# there reaches a tester's Mac as "damaged". The only way in is a notarized build.
assert_notarized_dmg() {
  local dmg="$1"
  local mount out rc=0
  mount="$(hdiutil attach "$dmg" -nobrowse -readonly 2>/dev/null | grep -o '/Volumes/.*' | head -1)"
  [[ -n "$mount" ]] || { echo "  ✗ refuse: cannot mount $dmg"; return 1; }
  out="$(spctl -a -t exec -vv "$mount/Decks Bridge.app" 2>&1)"
  echo "$out" | grep -qi 'accepted' && echo "$out" | grep -qi 'notarized' || rc=1
  hdiutil detach "$mount" -quiet 2>/dev/null || true
  return $rc
}

sync_mac() {
  mkdir -p "$MAC_DST"
  if [[ ! -d "$MAC_SRC" ]]; then
    echo "Skip Mac: no $MAC_SRC (run the signed release build first)"
    return 0
  fi

  # GATE: only a notarized build may reach the shareable tester folder.
  if [[ -f "$MAC_SRC/Decks Bridge.dmg" ]] && ! assert_notarized_dmg "$MAC_SRC/Decks Bridge.dmg"; then
    echo "  ✗ REFUSING to sync: $MAC_SRC/Decks Bridge.dmg is not notarized (Gatekeeper would reject it)."
    echo "    Tester folders receive PUBLIC, notarized builds only. Internal builds live in release/internal/."
    return 1
  fi

  rm -rf "$MAC_DST/Decks Bridge.app"
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
