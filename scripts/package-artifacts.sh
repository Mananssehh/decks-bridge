#!/usr/bin/env bash
# Package signed + notarized .app into DMG, ZIP, and updater artifacts.
# The .app must already be signed and stapled — this script does NOT modify the app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
OUT="$ROOT/release/v${VERSION}/mac"
MAC="$ROOT/release/mac"
DIST="$ROOT/decks bridge 091"

resolve_target_dir() {
  if [[ -n "$TARGET" ]]; then
    echo "$ROOT/src-tauri/target/$TARGET/release"
  else
    echo "$ROOT/src-tauri/target/release"
  fi
}

TARGET_DIR="$(resolve_target_dir)"
BUNDLE="$TARGET_DIR/bundle"
APP_NAME="Decks Bridge.app"
APP_PATH="$BUNDLE/macos/$APP_NAME"

mkdir -p "$OUT" "$DIST"

verify_app_bundle() {
  local app="$1"
  [[ -d "$app" ]] || { echo "ERROR: Missing app bundle: $app" >&2; exit 1; }
  [[ -f "$app/Contents/Info.plist" ]] || { echo "ERROR: Missing Info.plist" >&2; exit 1; }
  [[ -x "$app/Contents/MacOS/decks-bridge" ]] || { echo "ERROR: Missing MacOS/decks-bridge" >&2; exit 1; }
  [[ -f "$app/Contents/Resources/icon.icns" ]] || { echo "ERROR: Missing icon.icns" >&2; exit 1; }
  [[ ! -d "$app/.git" ]] || { echo "ERROR: .git in bundle" >&2; exit 1; }
  find "$app" -name '._*' | grep -q . && { echo "ERROR: AppleDouble files in bundle" >&2; exit 1; } || true
  echo "Verified bundle structure: $app"
}

create_dmg_from_app() {
  local app="$1"
  local dmg="$2"
  local stage
  stage="$(mktemp -d)"

  ditto --norsrc --noextattr --noqtn "$app" "$stage/$APP_NAME"
  ln -s /Applications "$stage/Applications"

  rm -f "$dmg"
  hdiutil create \
    -volname "Decks Bridge" \
    -srcfolder "$stage" \
    -ov \
    -format UDZO \
    -imagekey zlib-level=9 \
    "$dmg" >/dev/null

  rm -rf "$stage"
  echo "Created DMG: $dmg"
}

create_zip_from_app() {
  local app="$1"
  local zip="$2"
  rm -f "$zip"
  ditto -c -k --norsrc --noextattr --noqtn --keepParent "$app" "$zip"
  echo "Created ZIP: $zip"
}

create_updater_tarball() {
  local app="$1"
  local tarball="$2"
  local work
  work="$(mktemp -d)"
  ditto --norsrc --noextattr --noqtn "$app" "$work/$APP_NAME"
  tar -C "$work" --disable-copyfile -czf "$tarball" "$APP_NAME"
  rm -rf "$work"
  echo "Created updater tarball: $tarball"
}

sign_updater_tarball() {
  local tarball="$1"
  local sig="${tarball}.sig"
  # shellcheck disable=SC1091
  source "$ROOT/scripts/load-signing-env.sh"

  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    npx tauri signer sign "$tarball"
    echo "Signed updater tarball: $sig"
  else
    echo "ERROR: TAURI_SIGNING_PRIVATE_KEY required for updater .sig" >&2
    exit 1
  fi
}

if [[ "$(uname -s)" == "Darwin" && -d "$APP_PATH" ]]; then
  verify_app_bundle "$APP_PATH"

  echo "==> Confirming app is signed + notarized before packaging"
  codesign --verify --deep --strict --verbose=4 "$APP_PATH"
  spctl -a -vvv "$APP_PATH"

  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64) ARCH_TAG="aarch64" ;;
    x86_64) ARCH_TAG="x64" ;;
    *) ARCH_TAG="$ARCH" ;;
  esac

  DMG_NAME="Decks Bridge_${VERSION}_${ARCH_TAG}.dmg"
  DMG_PATH="$OUT/$DMG_NAME"
  ZIP_NAME="Decks.Bridge_${VERSION}_${ARCH_TAG}.app.zip"
  ZIP_PATH="$OUT/$ZIP_NAME"
  TAR_PATH="$OUT/Decks Bridge.app.tar.gz"

  create_dmg_from_app "$APP_PATH" "$DMG_PATH"
  create_zip_from_app "$APP_PATH" "$ZIP_PATH"
  create_updater_tarball "$APP_PATH" "$TAR_PATH"
  sign_updater_tarball "$TAR_PATH"

  cp "$DMG_PATH" "$MAC/Decks Bridge.dmg"
  cp "$ZIP_PATH" "$MAC/Decks Bridge.zip"
  cp "$TAR_PATH" "$MAC/"
  cp "$TAR_PATH.sig" "$MAC/" 2>/dev/null || true

  echo "==> Copying public release artifacts to decks bridge 091"
  rm -rf "$DIST"/*
  cp "$DMG_PATH" "$DIST/Decks Bridge.dmg"
  cp "$ZIP_PATH" "$DIST/Decks Bridge.app.zip"
  cp "$TAR_PATH" "$DIST/"
  cp "$TAR_PATH.sig" "$DIST/"
  ditto --norsrc --noextattr --noqtn "$APP_PATH" "$DIST/$APP_NAME"

  echo "Release artifacts ready in $OUT"
  ls -la "$OUT"
  echo "Public distribution copies in $DIST"
  ls -la "$DIST"
fi

if [[ -d "$BUNDLE/nsis" ]]; then
  WIN_OUT="$ROOT/release/windows"
  VER_WIN="$ROOT/release/v${VERSION}/windows"
  mkdir -p "$WIN_OUT" "$VER_WIN"
  shopt -s nullglob
  for exe in "$BUNDLE/nsis/"*.exe; do
    cp "$exe" "$WIN_OUT/Decks Bridge Setup.exe"
    cp "$exe" "$VER_WIN/Decks Bridge_${VERSION}_x64-setup.exe"
  done
  if [[ -f "$TARGET_DIR/decks-bridge.exe" ]]; then
    cp "$TARGET_DIR/decks-bridge.exe" "$WIN_OUT/Decks Bridge Portable.exe"
    cp "$TARGET_DIR/decks-bridge.exe" "$VER_WIN/Decks.Bridge_${VERSION}_x64-portable.exe"
  fi
  shopt -u nullglob
fi
