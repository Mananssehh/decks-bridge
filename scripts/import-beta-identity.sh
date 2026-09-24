#!/usr/bin/env bash
# CI only: import the stable "Decks Bridge Beta Signing" identity from GitHub
# Actions secrets into the keychain that sign-macos-beta.sh uses, so release
# builds are signed exactly like the builds DJs already have installed.
#
# The identity is exported once from the Mac that created it — see RELEASE.md
# ("One-time setup"). This script never prints secret values.
set -euo pipefail

: "${MACOS_BETA_SIGNING_P12_BASE64:?secret MACOS_BETA_SIGNING_P12_BASE64 is not set}"
: "${MACOS_BETA_SIGNING_P12_PASSWORD:?secret MACOS_BETA_SIGNING_P12_PASSWORD is not set}"

IDENTITY="Decks Bridge Beta Signing"
KEYCHAIN="$HOME/Library/Keychains/decks-bridge-beta.keychain-db"
KEYCHAIN_PW="decks-bridge-beta" # same fixed, non-secret value as create-beta-signing-cert.sh

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
P12="$TMP/identity.p12"
printf '%s' "$MACOS_BETA_SIGNING_P12_BASE64" | base64 --decode > "$P12"

if [[ ! -f "$KEYCHAIN" ]]; then
  security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
fi
security set-keychain-settings "$KEYCHAIN" # no auto-lock during the build
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$MACOS_BETA_SIGNING_P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

EXISTING="$(security list-keychains -d user | sed 's/[[:space:]]*"\(.*\)"/\1/')"
if ! printf '%s\n' "$EXISTING" | grep -q "decks-bridge-beta.keychain"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $EXISTING
fi

# Self-signed certificates are "not trusted", so query without -v.
if ! security find-identity -p codesigning "$KEYCHAIN" | grep -q "$IDENTITY"; then
  echo "ERROR: MACOS_BETA_SIGNING_P12_BASE64 does not contain the '$IDENTITY' identity." >&2
  exit 1
fi
echo "Imported signing identity '$IDENTITY'."
