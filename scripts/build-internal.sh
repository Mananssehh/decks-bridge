#!/usr/bin/env bash
# Internal/private testing build — ad-hoc signed. NOT for public website download.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
OUT="$ROOT/release/v${VERSION}-internal/mac"
MAC="$ROOT/release/mac"
DIST="$ROOT/decks bridge Mac"

# Build to a LOCAL (non-iCloud) target dir by default. The in-project
# src-tauri/target lives under the iCloud-synced Desktop, where cargo's
# fingerprint writes race iCloud eviction and fail with "Operation timed out
# (os error 60)". Override with CARGO_TARGET_DIR if you need a different path.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.decks-bridge-target}"
echo "==> CARGO_TARGET_DIR=$CARGO_TARGET_DIR"

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

BUILD_ARGS=()
if [[ -n "$TARGET" ]]; then
  BUILD_ARGS+=(--target "$TARGET")
fi

echo "==> Decks Bridge INTERNAL testing build v${VERSION}"

echo "==> [1/6] Build frontend"
npm run build

echo "==> [2/6] Build Tauri (.app only)"
if ((${#BUILD_ARGS[@]})); then
  npx tauri build --bundles app "${BUILD_ARGS[@]}"
else
  npx tauri build --bundles app
fi

echo "==> [3/6] Patch Info.plist (must happen BEFORE signing)"
bash "$ROOT/scripts/fix-macos-plist.sh"

APP="$CARGO_TARGET_DIR/release/bundle/macos/Decks Bridge.app"
if [[ -n "$TARGET" ]]; then
  APP="$CARGO_TARGET_DIR/$TARGET/release/bundle/macos/Decks Bridge.app"
fi

echo "==> [4/6] Sign with stable self-signed beta identity"
# All Info.plist edits are done above; the app is signed last and nothing
# modifies it afterwards (packaging only copies the already-signed bundle).
bash "$ROOT/scripts/sign-macos-beta.sh" "$APP"

echo "==> [5/6] Package DMG + ZIP"
mkdir -p "$OUT" "$MAC" "$DIST"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ARCH_TAG="aarch64" ;;
  x86_64) ARCH_TAG="x64" ;;
  *) ARCH_TAG="$ARCH" ;;
esac

# Package from a clean copy (avoids iCloud Desktop xattrs on the source path).
PACK="$(mktemp -d)"
ditto --norsrc --noextattr --noqtn "$APP" "$PACK/Decks Bridge.app"

[[ ! -d "$PACK/Decks Bridge.app/.git" ]] || { echo "ERROR: .git in bundle" >&2; exit 1; }
find "$PACK/Decks Bridge.app" -name '._*' | grep -q . && { echo "ERROR: AppleDouble files" >&2; exit 1; } || true

DMG="$MAC/Decks Bridge.dmg"
ZIP="$MAC/Decks Bridge.zip"
APP_OUT="$MAC/Decks Bridge.app"

# DMG
STAGE="$(mktemp -d)"
ditto --norsrc --noextattr --noqtn "$PACK/Decks Bridge.app" "$STAGE/Decks Bridge.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Decks Bridge" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$DMG" >/dev/null
rm -rf "$STAGE"
echo "Created: $DMG"

# ZIP
rm -f "$ZIP"
ditto -c -k --norsrc --noextattr --noqtn --keepParent "$PACK/Decks Bridge.app" "$ZIP"
echo "Created: $ZIP"

# Standalone .app folder
rm -rf "$APP_OUT"
ditto --norsrc --noextattr --noqtn "$PACK/Decks Bridge.app" "$APP_OUT"
echo "Created: $APP_OUT"

rm -rf "$PACK"

# Versioned copies
cp "$DMG" "$OUT/Decks Bridge_${VERSION}_${ARCH_TAG}.dmg"
cp "$ZIP" "$OUT/Decks.Bridge_${VERSION}_${ARCH_TAG}.app.zip"
cp "$DMG" "$DIST/Decks Bridge.dmg"
cp "$ZIP" "$DIST/Decks Bridge.zip"
cp TEST_INSTALL.md "$DIST/"
bash "$ROOT/scripts/sync-tester-folders.sh"

echo "==> [6/6] Verify packaged artifacts"
TMP="$(mktemp -d)"
ditto -x -k "$ZIP" "$TMP"
codesign --verify --deep --strict --verbose=4 "$TMP/Decks Bridge.app"
find "$TMP/Decks Bridge.app" -name '._*' | grep -q . && { echo "ERROR: AppleDouble in ZIP" >&2; exit 1; } || true
xattr -lr "$TMP/Decks Bridge.app" 2>&1 | rg 'quarantine|FinderInfo' && { echo "ERROR: bad xattrs in ZIP" >&2; exit 1; } || true
rm -rf "$TMP"

MOUNT="/Volumes/Decks Bridge"
hdiutil attach "$DMG" -nobrowse -readonly >/dev/null
codesign --verify --deep --strict --verbose=4 "$MOUNT/Decks Bridge.app"
find "$MOUNT/Decks Bridge.app" -name '._*' | grep -q . && { hdiutil detach "$MOUNT" 2>/dev/null; echo "ERROR: AppleDouble in DMG" >&2; exit 1; } || true
hdiutil detach "$MOUNT" >/dev/null

echo "==> Portability simulation (clean directory + quarantine)"
SIM="/tmp/decks-bridge-portability-$$"
rm -rf "$SIM"
mkdir -p "$SIM"
ditto -x -k "$ZIP" "$SIM"
# Simulate what AirDrop/Drive/Dropbox does to downloaded files:
xattr -w com.apple.quarantine "0081;$(date +%s);share;|com.apple.quarantine" "$SIM/Decks Bridge.app"
SPCTL_OUT="$(spctl -a -vvv "$SIM/Decks Bridge.app" 2>&1)" || true
echo "$SPCTL_OUT"
echo "$SPCTL_OUT" | rg -q 'rejected' && echo "NOTE: spctl rejects (expected — self-signed beta build is not notarized)" || true
xattr -dr com.apple.quarantine "$SIM/Decks Bridge.app"
codesign --verify --deep --strict "$SIM/Decks Bridge.app"
echo "OK: App remains valid after quarantine strip; launch may still need Right-click → Open"
rm -rf "$SIM"

# Fail loudly if the packaged app somehow ended up ad-hoc instead of self-signed.
if codesign -dv --verbose=4 "$APP_OUT" 2>&1 | grep -q "Signature=adhoc"; then
  echo "ERROR: packaged app is AD-HOC signed, not self-signed beta identity" >&2
  exit 1
fi
echo "OK: DMG and ZIP contain a self-signed (beta identity) app — not ad-hoc"
codesign -dv --verbose=4 "$APP_OUT" 2>&1 | grep -E '^Authority=|^Identifier=' || true

# Deregister the loose build-output .app copies from LaunchServices so they can
# never hijack `open`/launch resolution against the user's /Applications install.
# (They share bundle id com.decks.bridge; a registered duplicate is exactly what
# caused TCC/Accessibility grants to appear "not to work".) Files are kept for
# hashing — only the LaunchServices registration is removed.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  for stray in "$APP_OUT" "$DIST/Decks Bridge.app" "$MAC/Decks Bridge.app"; do
    [[ -d "$stray" ]] && "$LSREGISTER" -u "$stray" 2>/dev/null || true
  done
  echo "OK: deregistered loose build .app copies from LaunchServices (only /Applications should be registered)"
fi

echo ""
echo "==> Internal testing build complete"
echo "BETA (send these to testers):"
echo "  APP: $APP_OUT"
echo "  DMG: $DMG"
echo "  ZIP: $ZIP"
echo "Also: $OUT/ and $DIST/"
shasum -a 256 "$DMG" "$ZIP" "$APP_OUT/Contents/MacOS/decks-bridge"
bash "$ROOT/scripts/hash-release.sh"
