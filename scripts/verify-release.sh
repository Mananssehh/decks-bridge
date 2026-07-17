#!/usr/bin/env bash
# Verify signed/notarized release artifacts. Exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
OUT="$ROOT/release/v${VERSION}"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/Decks Bridge.app}"
ARCH="$(uname -m)"
case "$ARCH" in arm64) ARCH_TAG="aarch64" ;; x86_64) ARCH_TAG="x64" ;; *) ARCH_TAG="$ARCH" ;; esac

DMG="$OUT/Decks Bridge_${VERSION}_${ARCH_TAG}.dmg"
ZIP="$OUT/Decks.Bridge_${VERSION}_${ARCH_TAG}.app.zip"
TAR="$OUT/Decks Bridge.app.tar.gz"
SIG="$OUT/Decks Bridge.app.tar.gz.sig"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

echo "=== Bundle audit: $APP ==="
[[ -d "$APP" ]] || fail "App bundle missing"
[[ ! -d "$APP/.git" ]] || fail ".git found in bundle"
[[ -x "$APP/Contents/MacOS/decks-bridge" ]] || fail "Missing executable"
find "$APP" -name '._*' | grep -q . && fail "AppleDouble files found" || ok "No AppleDouble files"
find "$APP" -name '.git' | grep -q . && fail ".git found" || ok "No .git"
strings "$APP/Contents/MacOS/decks-bridge" | rg -q 'YOUR_GITHUB|hmtesting' && fail "Placeholder URLs in binary" || ok "No placeholder URLs"
# devUrl is embedded by Tauri for dev mode; release uses bundled assets at runtime.
ok "Bundle audit passed"

echo "=== codesign ==="
codesign --verify --deep --strict --verbose=4 "$APP" || fail "codesign --verify failed"
codesign -dv --verbose=4 "$APP" 2>&1 | tee /dev/stderr | rg -q 'Developer ID Application' || fail "Not signed with Developer ID"
ok "Developer ID signature valid"

echo "=== spctl ==="
SPCTL_OUT="$(spctl -a -vvv "$APP" 2>&1)" || true
echo "$SPCTL_OUT"
echo "$SPCTL_OUT" | rg -q 'accepted' || fail "spctl did not accept app (notarization required)"
echo "$SPCTL_OUT" | rg -qi 'notarized' || fail "spctl source is not Notarized Developer ID"
ok "Gatekeeper accepted (notarized)"

echo "=== xattr ==="
XATTR_OUT="$(xattr -lr "$APP" 2>&1 || true)"
if echo "$XATTR_OUT" | rg -q 'com.apple.quarantine'; then
  fail "Quarantine xattr present on app"
fi
ok "No quarantine xattr on app"

echo "=== Artifacts ==="
for f in "$DMG" "$ZIP" "$TAR" "$SIG"; do
  [[ -f "$f" ]] || fail "Missing artifact: $f"
  ok "$(basename "$f") — $(stat -f%z "$f") bytes — $(shasum -a 256 "$f" | awk '{print $1}')"
done

echo "=== Verify app inside DMG ==="
MOUNT="/Volumes/Decks Bridge"
hdiutil attach "$DMG" -nobrowse -readonly >/dev/null
codesign --verify --deep --strict "$MOUNT/Decks Bridge.app" || { hdiutil detach "$MOUNT" 2>/dev/null; fail "DMG app failed codesign"; }
spctl -a -vvv "$MOUNT/Decks Bridge.app" 2>&1 | rg -q 'accepted' || { hdiutil detach "$MOUNT" 2>/dev/null; fail "DMG app rejected by spctl"; }
hdiutil detach "$MOUNT" >/dev/null
ok "DMG contains notarized app"

echo "=== Verify app inside ZIP ==="
TMP="$(mktemp -d)"
ditto -x -k "$ZIP" "$TMP"
codesign --verify --deep --strict "$TMP/Decks Bridge.app" || fail "ZIP app failed codesign"
spctl -a -vvv "$TMP/Decks Bridge.app" 2>&1 | rg -q 'accepted' || fail "ZIP app rejected by spctl"
rm -rf "$TMP"
ok "ZIP contains notarized app"

echo ""
echo "All release verification checks passed."
