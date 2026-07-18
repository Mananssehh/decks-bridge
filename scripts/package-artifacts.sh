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

# $MAC was used by cp but never created: under `set -e` that aborted the
# release AFTER signing + notarizing, i.e. after the slowest steps had run.
mkdir -p "$OUT" "$DIST" "$MAC"

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

  echo "==> Confirming app is Developer ID signed + notarized + stapled before packaging"
  # These are PUBLIC-distribution artifacts. If any of the three checks below
  # fail, the app would land on users' machines as "damaged" — so abort rather
  # than package it. This is the last gate before an artifact becomes a download.
  codesign --verify --deep --strict --verbose=4 "$APP_PATH"

  if ! codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -q "Developer ID Application"; then
    echo "ERROR: $APP_PATH is not Developer ID signed — refusing to package for public distribution." >&2
    echo "       (Ad-hoc / self-signed builds are rejected by Gatekeeper as \"damaged\".)" >&2
    exit 1
  fi

  if ! xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
    echo "ERROR: $APP_PATH has no stapled notarization ticket — refusing to package." >&2
    echo "       Run scripts/notarize-macos-app.sh first (Apple notarization + staple)." >&2
    exit 1
  fi

  # spctl is Gatekeeper itself: this must say "accepted ... source=Notarized Developer ID".
  spctl -a -vvv -t exec "$APP_PATH"

  # Architecture MUST come from the requested $TARGET, not from `uname -m`.
  #
  # `uname -m` reports the BUILD MACHINE. CI runs both matrix jobs on
  # macos-latest (arm64), so the x86_64-apple-darwin job used to report arm64
  # and label an Intel build "aarch64". Both jobs then emitted identically
  # named artifacts that collided on publish — an Intel DJ could be handed an
  # Apple Silicon build (or vice versa) and the app simply would not launch.
  # Only fall back to uname for a bare local build with no explicit target.
  case "${TARGET:-$(uname -m)}" in
    aarch64-apple-darwin|arm64) ARCH_TAG="aarch64" ;;
    x86_64-apple-darwin|x86_64) ARCH_TAG="x64" ;;
    *)
      echo "ERROR: cannot determine arch tag from target '${TARGET:-$(uname -m)}'" >&2
      exit 1
      ;;
  esac
  echo "==> Packaging for ${TARGET:-native} → arch tag: ${ARCH_TAG}"

  DMG_NAME="Decks Bridge_${VERSION}_${ARCH_TAG}.dmg"
  DMG_PATH="$OUT/$DMG_NAME"
  ZIP_NAME="Decks.Bridge_${VERSION}_${ARCH_TAG}.app.zip"
  ZIP_PATH="$OUT/$ZIP_NAME"
  # The updater tarball MUST carry the arch too: it previously had none, so the
  # aarch64 and x64 builds produced the same filename and overwrote each other
  # in release/mac, leaving one arch silently shipping the other's binary.
  TAR_PATH="$OUT/Decks.Bridge_${VERSION}_${ARCH_TAG}.app.tar.gz"

  create_dmg_from_app "$APP_PATH" "$DMG_PATH"
  create_zip_from_app "$APP_PATH" "$ZIP_PATH"
  create_updater_tarball "$APP_PATH" "$TAR_PATH"
  sign_updater_tarball "$TAR_PATH"

  # Every copy is arch-qualified. The old arch-less "Decks Bridge.dmg" /
  # "Decks Bridge.zip" names were written by BOTH matrix jobs, so whichever
  # finished last silently overwrote the other arch's binary under the same
  # filename.
  cp "$DMG_PATH" "$MAC/$DMG_NAME"
  cp "$ZIP_PATH" "$MAC/$ZIP_NAME"
  cp "$TAR_PATH" "$MAC/"
  cp "$TAR_PATH.sig" "$MAC/" 2>/dev/null || true

  echo "==> Copying public release artifacts to $DIST"
  # Clear only build outputs. `rm -rf "$DIST"/*` also deleted README.md and
  # TEST_INSTALL.md, which are tracked in git — every release wiped them from
  # the working tree.
  find "$DIST" -mindepth 1 -maxdepth 1 \
    \( -name '*.dmg' -o -name '*.zip' -o -name '*.tar.gz' -o -name '*.sig' -o -name '*.app' \) \
    -exec rm -rf {} +
  cp "$DMG_PATH" "$DIST/$DMG_NAME"
  cp "$ZIP_PATH" "$DIST/$ZIP_NAME"
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
