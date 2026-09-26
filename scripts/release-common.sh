#!/usr/bin/env bash
# Shared helpers for the macOS release scripts: package-artifacts.sh,
# verify-release.sh, sync-tester-folders.sh and build-internal.sh. Source it;
# do not run it. Works with the bash 3.2 that ships with macOS.
#
# Public artifact names must match PLATFORM_FILES in scripts/release-tools.mjs,
# which the release workflow uses to validate a release and write latest.json.
# scripts/release-tools.test.mjs runs mac_release_files below to keep the two
# in step.

# shellcheck disable=SC2034  # used by the scripts that source this file
APP_BUNDLE_NAME="Decks Bridge.app"
APP_EXECUTABLE="decks-bridge"
# Overridable only so scripts/release-common.test.mjs can run these checks
# against stand-ins for the macOS tools.
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"

# Arch tag used in artifact names for a Rust target triple.
arch_tag_for_target() {
  case "$1" in
    aarch64-apple-darwin) echo "aarch64" ;;
    x86_64-apple-darwin) echo "x64" ;;
    *) return 1 ;;
  esac
}

# Arch tag for the architecture list printed by `lipo -archs`. A universal
# binary ("x86_64 arm64") has no single tag and is rejected.
arch_tag_for_macho() {
  case "$1" in
    arm64) echo "aarch64" ;;
    x86_64) echo "x64" ;;
    *) return 1 ;;
  esac
}

# Mach-O architecture (as printed by `lipo -archs`) for an arch tag.
macho_arch_for_tag() {
  case "$1" in
    aarch64) echo "arm64" ;;
    x64) echo "x86_64" ;;
    *) return 1 ;;
  esac
}

# Common prefix of every public macOS artifact, e.g. Decks.Bridge_1.2.3_aarch64.
# No spaces, so GitHub keeps release asset names exactly as written.
mac_artifact_base() {
  echo "Decks.Bridge_${1}_${2}"
}

# The public files for one architecture (version, arch tag), one per line.
mac_release_files() {
  local base
  base="$(mac_artifact_base "$1" "$2")"
  printf '%s\n' "$base.dmg" "$base.app.zip" "$base.app.tar.gz" "$base.app.tar.gz.sig"
}

# Arch tag of a built app, read from its executable. Never from `uname -m`:
# that is the build machine, and CI builds Intel apps on Apple Silicon runners.
app_arch_tag() {
  local archs
  archs="$(lipo -archs "$1/Contents/MacOS/$APP_EXECUTABLE" 2>/dev/null)" || return 1
  arch_tag_for_macho "$archs"
}

# Arch tag for a build: read from the built executable and, when a target was
# requested, required to match it. Prints the tag; explains any failure.
resolve_arch_tag() {
  local target="$1" app="$2" built expected
  if ! built="$(app_arch_tag "$app")"; then
    echo "ERROR: $app is not a single-architecture arm64 or x86_64 build (lipo -archs)." >&2
    return 1
  fi
  if [[ -n "$target" ]]; then
    if ! expected="$(arch_tag_for_target "$target")"; then
      echo "ERROR: unsupported target '$target' (use aarch64-apple-darwin or x86_64-apple-darwin)." >&2
      return 1
    fi
    if [[ "$built" != "$expected" ]]; then
      echo "ERROR: $app contains a $built build, but $target ($expected) was requested." >&2
      return 1
    fi
  fi
  echo "$built"
}

# Mounts a disk image read-only at a new private mount point and prints it.
# A fixed /Volumes/Decks Bridge path could be another, already-mounted copy.
attach_dmg() {
  local dmg="$1" mnt
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/decks-bridge-dmg.XXXXXX")"
  if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null; then
    rmdir "$mnt" 2>/dev/null || true
    return 1
  fi
  echo "$mnt"
}

detach_dmg() {
  hdiutil detach "$1" -quiet 2>/dev/null || hdiutil detach "$1" -force -quiet 2>/dev/null || true
  rmdir "$1" 2>/dev/null || true
}

# Checks one copy of the app for public distribution: Developer ID signature
# with the hardened runtime, a stapled notarization ticket, Gatekeeper
# acceptance as "Notarized Developer ID", and the expected version and
# architecture. Prints every problem found; returns non-zero if there were any.
check_public_app() {
  local app="$1" version="$2" arch_tag="$3"
  local problems=0 info spctl_out archs want_arch short_version

  if [[ ! -x "$app/Contents/MacOS/$APP_EXECUTABLE" ]]; then
    echo "  ✗ $app: missing Contents/MacOS/$APP_EXECUTABLE" >&2
    return 1
  fi

  if ! codesign --verify --deep --strict "$app" 2>/dev/null; then
    echo "  ✗ $app: codesign --verify --deep --strict failed" >&2
    problems=$((problems + 1))
  fi

  info="$(codesign -dv --verbose=4 "$app" 2>&1 || true)"
  if ! grep -q '^Authority=Developer ID Application: ' <<<"$info"; then
    echo "  ✗ $app: not signed with a Developer ID Application certificate" >&2
    problems=$((problems + 1))
  fi
  if grep -q '^Signature=adhoc' <<<"$info"; then
    echo "  ✗ $app: ad-hoc signature" >&2
    problems=$((problems + 1))
  fi
  if ! grep -Eq 'flags=0x[0-9a-f]+\([^)]*runtime' <<<"$info"; then
    echo "  ✗ $app: hardened runtime is not enabled" >&2
    problems=$((problems + 1))
  fi
  if [[ -n "${APPLE_TEAM_ID:-}" ]] && ! grep -qx "TeamIdentifier=$APPLE_TEAM_ID" <<<"$info"; then
    echo "  ✗ $app: not signed by team $APPLE_TEAM_ID" >&2
    problems=$((problems + 1))
  fi

  if ! xcrun stapler validate "$app" >/dev/null 2>&1; then
    echo "  ✗ $app: no valid stapled notarization ticket" >&2
    problems=$((problems + 1))
  fi

  spctl_out="$(spctl -a -vvv -t exec "$app" 2>&1 || true)"
  if grep -q 'override=security disabled' <<<"$spctl_out"; then
    echo "  ✗ Gatekeeper assessments are disabled on this Mac, so it cannot vouch for $app." >&2
    echo "    Enable them with: sudo spctl --master-enable" >&2
    problems=$((problems + 1))
  elif ! grep -q ': accepted' <<<"$spctl_out" || ! grep -qx 'source=Notarized Developer ID' <<<"$spctl_out"; then
    echo "  ✗ $app: Gatekeeper does not accept it as Notarized Developer ID:" >&2
    printf '    %s\n' "$spctl_out" >&2
    problems=$((problems + 1))
  fi

  short_version="$("$PLISTBUDDY" -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$short_version" != "$version" ]]; then
    echo "  ✗ $app: CFBundleShortVersionString is '$short_version', expected '$version'" >&2
    problems=$((problems + 1))
  fi

  want_arch="$(macho_arch_for_tag "$arch_tag" || true)"
  archs="$(lipo -archs "$app/Contents/MacOS/$APP_EXECUTABLE" 2>/dev/null || true)"
  if [[ -z "$want_arch" || "$archs" != "$want_arch" ]]; then
    echo "  ✗ $app: executable architecture is '$archs', expected '${want_arch:-?}' ($arch_tag)" >&2
    problems=$((problems + 1))
  fi

  [[ "$problems" -eq 0 ]]
}

# Checks a disk image itself: Developer ID signature, stapled notarization
# ticket and Gatekeeper acceptance as "Notarized Developer ID".
check_public_dmg() {
  local dmg="$1" problems=0 info spctl_out

  if ! codesign --verify --strict "$dmg" 2>/dev/null; then
    echo "  ✗ $dmg: codesign --verify failed (the disk image is not signed)" >&2
    problems=$((problems + 1))
  fi
  info="$(codesign -dv --verbose=4 "$dmg" 2>&1 || true)"
  if ! grep -q '^Authority=Developer ID Application: ' <<<"$info"; then
    echo "  ✗ $dmg: not signed with a Developer ID Application certificate" >&2
    problems=$((problems + 1))
  fi
  if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    echo "  ✗ $dmg: no valid stapled notarization ticket" >&2
    problems=$((problems + 1))
  fi
  spctl_out="$(spctl -a -vvv -t open --context context:primary-signature "$dmg" 2>&1 || true)"
  if grep -q 'override=security disabled' <<<"$spctl_out"; then
    echo "  ✗ Gatekeeper assessments are disabled on this Mac, so it cannot vouch for $dmg." >&2
    echo "    Enable them with: sudo spctl --master-enable" >&2
    problems=$((problems + 1))
  elif ! grep -q ': accepted' <<<"$spctl_out" || ! grep -qx 'source=Notarized Developer ID' <<<"$spctl_out"; then
    echo "  ✗ $dmg: Gatekeeper does not accept it as Notarized Developer ID:" >&2
    printf '    %s\n' "$spctl_out" >&2
    problems=$((problems + 1))
  fi

  [[ "$problems" -eq 0 ]]
}
