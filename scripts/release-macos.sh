#!/usr/bin/env bash
# Build and package ONE macOS architecture for a GitHub Release with in-app
# update artifacts. Used by .github/workflows/release.yml; also runs locally on
# the Mac that holds the beta signing identity (docs/BETA_SIGNING.md).
#
#   scripts/release-macos.sh build        <target>  # compile the .app (no secrets)
#   scripts/release-macos.sh package      <target>  # beta-sign, verify, DMG + ZIP + updater .tar.gz
#   scripts/release-macos.sh sign-updater <target>  # minisign the .tar.gz (TAURI_SIGNING_PRIVATE_KEY)
#
# <target>: aarch64-apple-darwin or x86_64-apple-darwin (separate per-arch
# builds, as before — no Universal Binary). Output: release/upload/, with the
# exact file names the GitHub Release gets.
#
# Signing status is unchanged: self-signed "Decks Bridge Beta Signing"
# identity, NOT Developer ID, NOT notarized (see RELEASE.md → Limitations).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

USAGE="Usage: release-macos.sh <build|package|sign-updater> <aarch64-apple-darwin|x86_64-apple-darwin>"
STEP="${1:?$USAGE}"
TARGET="${2:?$USAGE}"

case "$TARGET" in
  aarch64-apple-darwin) ARCH_TAG="aarch64"; LIPO_ARCH="arm64" ;;
  x86_64-apple-darwin) ARCH_TAG="x64"; LIPO_ARCH="x86_64" ;;
  *) echo "ERROR: unsupported target '$TARGET'. $USAGE" >&2; exit 1 ;;
esac

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
# Same default as build-internal.sh: keep cargo output off the iCloud Desktop.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.decks-bridge-target}"
APP="$CARGO_TARGET_DIR/$TARGET/release/bundle/macos/Decks Bridge.app"
OUT="$ROOT/release/upload"
BASE="Decks.Bridge_${VERSION}_${ARCH_TAG}"
TARBALL="$OUT/$BASE.app.tar.gz"

IDENTITY="Decks Bridge Beta Signing"
KEYCHAIN="$HOME/Library/Keychains/decks-bridge-beta.keychain-db"

fail() { echo "ERROR: $*" >&2; exit 1; }

build() {
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
  echo "==> Building Decks Bridge $VERSION for $TARGET"
  # beforeBuildCommand runs `npm run build` (mock-data guard + tsc + vite).
  npx tauri build --bundles app --target "$TARGET"
  echo "==> Patching Info.plist (before signing)"
  bash "$ROOT/scripts/fix-macos-plist.sh"
  [[ -d "$APP" ]] || fail "Missing app bundle: $APP"
}

# Everything a DJ's machine will run must pass these checks: right CPU
# architecture, right version (or the updater would re-offer this release
# forever), and a valid signature from the stable beta identity.
verify_app() {
  local app="$1"
  local bin="$app/Contents/MacOS/decks-bridge"
  [[ -x "$bin" ]] || fail "Missing executable in $app"
  [[ ! -d "$app/.git" ]] || fail ".git inside $app"

  local archs
  archs="$(lipo -archs "$bin")"
  [[ "$archs" == "$LIPO_ARCH" ]] || fail "$app contains '$archs', expected '$LIPO_ARCH' for $TARGET"

  local bundle_version
  bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
  [[ "$bundle_version" == "$VERSION" ]] || fail "$app reports version $bundle_version, expected $VERSION"

  codesign --verify --deep --strict --verbose=2 "$app"
  local info
  info="$(codesign -dv --verbose=4 "$app" 2>&1 || true)"
  grep -q "^Authority=$IDENTITY\$" <<<"$info" || fail "$app is not signed by '$IDENTITY'"
  # macOS keys Accessibility/Automation grants to this requirement; it must be
  # identical across releases for DJs to keep their permissions.
  codesign -d -r- "$app" 2>&1 | grep "designated" || true
}

hdiutil_create() {
  # hdiutil occasionally fails with "Resource busy" on CI runners; retry.
  local attempt
  for attempt in 1 2 3; do
    if hdiutil create "$@" >/dev/null; then return 0; fi
    echo "hdiutil create failed (attempt $attempt); retrying…" >&2
    sleep 5
  done
  fail "hdiutil create failed"
}

package() {
  [[ -d "$APP" ]] || fail "Missing app bundle: $APP (run the build step first)"

  # Sign with the SAME identity as every earlier build so DJs keep their macOS
  # permissions after updating. sign-macos-beta.sh would create a brand-new
  # identity if none exists — acceptable for a first local build, never for a
  # release (every DJ would have to re-grant Accessibility/Automation).
  if ! { [[ -f "$KEYCHAIN" ]] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; }; then
    fail "Signing identity '$IDENTITY' not found in $KEYCHAIN. In CI set the MACOS_BETA_SIGNING_P12_BASE64 and MACOS_BETA_SIGNING_P12_PASSWORD secrets (RELEASE.md)."
  fi
  bash "$ROOT/scripts/sign-macos-beta.sh" "$APP"
  verify_app "$APP"

  mkdir -p "$OUT"
  rm -f "$OUT/$BASE.dmg" "$OUT/$BASE.app.zip" "$TARBALL" "$TARBALL.sig"

  echo "==> DMG"
  local stage
  stage="$(mktemp -d)"
  ditto --norsrc --noextattr --noqtn "$APP" "$stage/Decks Bridge.app"
  ln -s /Applications "$stage/Applications"
  hdiutil_create -volname "Decks Bridge" -srcfolder "$stage" -ov -format UDZO \
    -imagekey zlib-level=9 "$OUT/$BASE.dmg"
  rm -rf "$stage"

  echo "==> ZIP"
  ditto -c -k --norsrc --noextattr --noqtn --keepParent "$APP" "$OUT/$BASE.app.zip"

  echo "==> Updater archive"
  # The .app sits at the archive root, which is what tauri-plugin-updater
  # extracts. Built from the signed bundle; nothing modifies it afterwards.
  local work
  work="$(mktemp -d)"
  ditto --norsrc --noextattr --noqtn "$APP" "$work/Decks Bridge.app"
  tar -C "$work" --disable-copyfile -czf "$TARBALL" "Decks Bridge.app"
  rm -rf "$work"

  # Verify exactly what the updater will install.
  local check
  check="$(mktemp -d)"
  tar -xzf "$TARBALL" -C "$check"
  verify_app "$check/Decks Bridge.app"
  if find "$check" -name '._*' | grep -q .; then fail "AppleDouble files in $TARBALL"; fi
  rm -rf "$check"

  echo "==> Packaged $TARGET"
  ls -la "$OUT/$BASE".*
}

sign_updater() {
  [[ -f "$TARBALL" ]] || fail "Missing $TARBALL (run the package step first)"
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    # Local runs: .env.signing or ~/.tauri/decks-bridge.key (never CI).
    # shellcheck disable=SC1091
    source "$ROOT/scripts/load-signing-env.sh"
  fi
  [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || fail "TAURI_SIGNING_PRIVATE_KEY is not set"
  # Must be defined even when empty (passwordless key); unset makes the
  # signer try to prompt, which fails without a terminal.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

  echo "==> Signing $TARBALL"
  npx tauri signer sign "$TARBALL" >/dev/null
  # Fail here, before anything is published, if the key does not match the
  # public key installed apps trust.
  node "$ROOT/scripts/release-tools.mjs" verify-signature "$TARBALL"
}

case "$STEP" in
  build) build ;;
  package) package ;;
  sign-updater) sign_updater ;;
  *) fail "unknown step '$STEP'. $USAGE" ;;
esac
