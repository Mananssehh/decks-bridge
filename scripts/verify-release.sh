#!/usr/bin/env bash
# Verify one architecture's public macOS release before anything can publish it.
#
#   verify-release.sh "<path to Decks Bridge.app>" [aarch64-apple-darwin|x86_64-apple-darwin]
#
# Checks the built app and the copy of it inside every artifact in
# release/v<version>/mac (DMG, ZIP, updater tarball): Developer ID signature,
# hardened runtime, stapled notarization ticket, Gatekeeper acceptance as
# "Notarized Developer ID", version and architecture. The architecture comes
# from the requested target, checked against the built executable; without a
# target it is read from the executable. Never from the build machine.
# Also verifies the updater signature against the public key the installed
# apps trust. Exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/release-common.sh
source "$ROOT/scripts/release-common.sh"

APP="${1:?Usage: verify-release.sh <path to Decks Bridge.app> [target triple]}"
TARGET="${2:-}"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
OUT="$ROOT/release/v${VERSION}/mac"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

[[ -d "$APP" ]] || fail "App bundle missing: $APP"
ARCH_TAG="$(resolve_arch_tag "$TARGET" "$APP")" || fail "Architecture check failed for $APP"
ok "Built for $ARCH_TAG ($(lipo -archs "$APP/Contents/MacOS/$APP_EXECUTABLE"))${TARGET:+, as requested by $TARGET}"

BASE="$OUT/$(mac_artifact_base "$VERSION" "$ARCH_TAG")"
DMG="$BASE.dmg"
ZIP="$BASE.app.zip"
TAR="$BASE.app.tar.gz"
SIG="$TAR.sig"

WORK="$(mktemp -d)"
MNT=""
cleanup() {
  if [[ -n "$MNT" ]]; then detach_dmg "$MNT"; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== Bundle audit: $APP ==="
BIN="$APP/Contents/MacOS/$APP_EXECUTABLE"
[[ -x "$BIN" ]] || fail "Missing executable: $BIN"
[[ -z "$(find "$APP" -name '.git' -print -quit)" ]] || fail ".git found in bundle"
[[ -z "$(find "$APP" -name '._*' -print -quit)" ]] || fail "AppleDouble files found in bundle"
# grep -a reads the binary directly: no pipeline whose early exit could hide a
# match. 0 = found, 1 = not found, anything else = could not read it.
placeholder=0
grep -a -q -E 'YOUR_GITHUB|hmtesting' "$BIN" || placeholder=$?
case "$placeholder" in
  0) fail "Placeholder URLs in binary" ;;
  1) ok "No placeholder URLs" ;;
  *) fail "Could not scan $BIN for placeholder URLs" ;;
esac
XATTRS="$(xattr -lr "$APP" 2>&1 || true)"
if grep -q 'com.apple.quarantine' <<<"$XATTRS"; then
  fail "Quarantine xattr present on app"
fi
ok "Bundle audit passed"

echo "=== Built app: signature, notarization, Gatekeeper, version, architecture ==="
check_public_app "$APP" "$VERSION" "$ARCH_TAG" || fail "Built app is not ready for public distribution"
ok "Developer ID signed, notarized, stapled and accepted by Gatekeeper"

echo "=== Artifacts in $OUT ==="
for f in "$DMG" "$ZIP" "$TAR" "$SIG"; do
  [[ -s "$f" ]] || fail "Missing or empty artifact: $f"
  ok "$(basename "$f") — $(stat -f%z "$f") bytes — $(shasum -a 256 "$f" | awk '{print $1}')"
done

echo "=== DMG ==="
check_public_dmg "$DMG" || fail "DMG is not signed, notarized and stapled"
ok "DMG is Developer ID signed, notarized and stapled"
MNT="$(attach_dmg "$DMG")" || fail "Could not mount $DMG"
[[ -d "$MNT/$APP_BUNDLE_NAME" ]] || fail "DMG does not contain $APP_BUNDLE_NAME"
[[ -L "$MNT/Applications" ]] || fail "DMG has no Applications shortcut"
check_public_app "$MNT/$APP_BUNDLE_NAME" "$VERSION" "$ARCH_TAG" || fail "App inside the DMG failed verification"
detach_dmg "$MNT"
MNT=""
ok "DMG contains the notarized $ARCH_TAG app"

echo "=== ZIP ==="
mkdir -p "$WORK/zip"
ditto -x -k "$ZIP" "$WORK/zip"
check_public_app "$WORK/zip/$APP_BUNDLE_NAME" "$VERSION" "$ARCH_TAG" || fail "App inside the ZIP failed verification"
ok "ZIP contains the notarized $ARCH_TAG app"

echo "=== Updater tarball ==="
# tauri-plugin-updater drops the first path component of every entry, so the
# archive must hold exactly one top-level item: the app bundle.
LISTING="$(tar -tzf "$TAR")" || fail "Could not list $TAR"
OUTSIDE="$(grep -c -v -E '^Decks Bridge\.app(/|$)' <<<"$LISTING" || true)"
[[ "$OUTSIDE" == "0" ]] || fail "$TAR has $OUTSIDE entries outside $APP_BUNDLE_NAME/"
mkdir -p "$WORK/tar"
tar -xzf "$TAR" -C "$WORK/tar"
check_public_app "$WORK/tar/$APP_BUNDLE_NAME" "$VERSION" "$ARCH_TAG" || fail "App inside the updater tarball failed verification"
node "$ROOT/scripts/release-tools.mjs" verify-signature "$TAR" "$SIG" || fail "Updater signature does not verify against plugins.updater.pubkey"
ok "Updater tarball contains the notarized $ARCH_TAG app and its signature verifies"

echo ""
echo "All release verification checks passed for $ARCH_TAG."
