#!/usr/bin/env bash
# Copy latest release artifacts into tester-facing folders.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/release-common.sh
source "$ROOT/scripts/release-common.sh"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
MAC_SRC="$ROOT/release/mac"
MAC_DST="$ROOT/decks bridge Mac"
WIN_SRC="$ROOT/release/windows"
WIN_DST="$ROOT/windows"

# Refuse to publish an artifact whose app is not notarized (Gatekeeper-accepted).
# "decks bridge Mac" is a shareable folder; an ad-hoc/self-signed build copied
# there reaches a tester's Mac as "damaged". The only way in is a notarized build
# of the architecture its name promises.
assert_notarized_dmg() {
  local dmg="$1" arch_tag="$2" mount rc=0
  check_public_dmg "$dmg" || return 1
  mount="$(attach_dmg "$dmg")" || { echo "  ✗ refuse: cannot mount $dmg"; return 1; }
  check_public_app "$mount/$APP_BUNDLE_NAME" "$VERSION" "$arch_tag" || rc=1
  detach_dmg "$mount"
  return $rc
}

assert_notarized_zip() {
  local zip="$1" arch_tag="$2" tmp rc=0
  tmp="$(mktemp -d)"
  if ditto -x -k "$zip" "$tmp"; then
    check_public_app "$tmp/$APP_BUNDLE_NAME" "$VERSION" "$arch_tag" || rc=1
  else
    echo "  ✗ refuse: cannot extract $zip"
    rc=1
  fi
  rm -rf "$tmp"
  return $rc
}

sync_mac() {
  mkdir -p "$MAC_DST"

  # package-artifacts.sh writes Decks.Bridge_<version>_<aarch64|x64>.{dmg,app.zip}
  # into release/mac; only this version's files are candidates.
  local files=() arch base dmg zip
  for arch in aarch64 x64; do
    base="$(mac_artifact_base "$VERSION" "$arch")"
    dmg="$MAC_SRC/$base.dmg"
    zip="$MAC_SRC/$base.app.zip"
    if [[ ! -f "$dmg" && ! -f "$zip" ]]; then
      echo "  - no $arch build of v$VERSION in $MAC_SRC"
      continue
    fi
    # GATE: only a notarized build may reach the shareable tester folder, and
    # the DMG and ZIP of an architecture travel together.
    if [[ ! -f "$dmg" || ! -f "$zip" ]]; then
      echo "  ✗ REFUSING to sync: the $arch build of v$VERSION needs both $base.dmg and $base.app.zip."
      return 1
    fi
    if ! assert_notarized_dmg "$dmg" "$arch" || ! assert_notarized_zip "$zip" "$arch"; then
      echo "  ✗ REFUSING to sync: the $arch build of v$VERSION is not a notarized $arch build (Gatekeeper would reject it)."
      echo "    Tester folders receive PUBLIC, notarized builds only. Internal builds live in release/internal/."
      return 1
    fi
    files+=("$dmg" "$zip")
  done

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "Skip Mac: no notarized v$VERSION build in $MAC_SRC (run npm run build:release first)"
    return 0
  fi

  # Replace every earlier build (other versions, the old arch-less names) so
  # testers cannot pick up a stale or wrong-architecture download.
  find "$MAC_DST" -mindepth 1 -maxdepth 1 \
    \( -name '*.dmg' -o -name '*.zip' -o -name '*.app' \) \
    -exec rm -rf {} +
  cp -f "${files[@]}" "$MAC_DST/"

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
