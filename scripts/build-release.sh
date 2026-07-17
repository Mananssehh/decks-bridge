#!/usr/bin/env bash
# Production release build: Tauri → patch plist → Developer ID sign → notarize → package → verify
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
OUT="$ROOT/release/v${VERSION}/mac"

export CARGO_TARGET_DIR="$ROOT/src-tauri/target"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-signing-env.sh"

echo "==> Decks Bridge PRODUCTION release v${VERSION}"

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "ERROR: Rust/cargo not found" >&2
  exit 1
fi

BUILD_ARGS=()
if [[ -n "$TARGET" ]]; then
  BUILD_ARGS+=(--target "$TARGET")
fi

echo "==> [1/7] Build frontend"
npm run build

echo "==> [2/7] Build Tauri (.app bundle only)"
if ((${#BUILD_ARGS[@]})); then
  npx tauri build --bundles app "${BUILD_ARGS[@]}"
else
  npx tauri build --bundles app
fi

echo "==> [3/7] Patch Info.plist (before signing)"
bash "$ROOT/scripts/fix-macos-plist.sh"

APP="$ROOT/src-tauri/target/release/bundle/macos/Decks Bridge.app"
if [[ -n "$TARGET" ]]; then
  APP="$ROOT/src-tauri/target/$TARGET/release/bundle/macos/Decks Bridge.app"
fi

echo "==> [4/7] Developer ID sign (hardened runtime)"
bash "$ROOT/scripts/sign-macos-app.sh" "$APP"

echo "==> [5/7] Notarize + staple"
bash "$ROOT/scripts/notarize-macos-app.sh" "$APP"

echo "==> [6/7] Create DMG / ZIP / updater artifacts (no app modifications after sign)"
bash "$ROOT/scripts/package-artifacts.sh" "$TARGET"

echo "==> [7/7] Verify release"
bash "$ROOT/scripts/verify-release.sh" "$APP"

echo "==> Production release complete: $OUT"
