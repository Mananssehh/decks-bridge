#!/usr/bin/env bash
# Sign a Decks Bridge .app with the STABLE self-signed beta identity so the
# app's macOS designated requirement stays constant across builds (helps TCC
# grants — Accessibility/Automation — persist across beta updates).
#
# INTERNAL BETA ONLY. Self-signed, NOT notarized, NOT Developer ID. DJs will
# still see Gatekeeper warnings on first launch (right-click → Open).
set -euo pipefail

APP="${1:?Usage: sign-macos-beta.sh /path/to/Decks Bridge.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/src-tauri/entitlements.plist"
IDENTITY="Decks Bridge Beta Signing"
KEYCHAIN="$HOME/Library/Keychains/decks-bridge-beta.keychain-db"
KEYCHAIN_PW="decks-bridge-beta"

[[ -d "$APP" ]] || { echo "ERROR: Not a directory: $APP" >&2; exit 1; }
[[ -x "$APP/Contents/MacOS/decks-bridge" ]] || { echo "ERROR: Missing executable" >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "ERROR: Missing entitlements: $ENTITLEMENTS" >&2; exit 1; }

# Ensure the stable identity exists (create it once if missing).
if ! ( [[ -f "$KEYCHAIN" ]] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY" ); then
  echo "==> Beta identity missing — creating it now"
  bash "$ROOT/scripts/create-beta-signing-cert.sh"
fi

# Make sure the beta keychain is unlocked and in the search list so codesign
# can find the identity and use the private key without prompting.
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN" 2>/dev/null || true
EXISTING="$(security list-keychains -d user | sed 's/[[:space:]]*"\(.*\)"/\1/')"
if ! printf '%s\n' "$EXISTING" | grep -q "decks-bridge-beta.keychain"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $EXISTING
fi

echo "==> Beta signing: $APP"

# Stage a clean copy (avoids iCloud/Desktop xattrs on the source path breaking
# codesign), sign there, then copy back. NOTHING modifies the app after signing.
STAGE="$(mktemp -d)"
STAGED_APP="$STAGE/Decks Bridge.app"
ditto --norsrc --noextattr --noqtn "$APP" "$STAGED_APP"
rm -rf "$STAGED_APP/Contents/_CodeSignature"
xattr -cr "$STAGED_APP" 2>/dev/null || true

# Sign the nested Mach-O first, then the bundle, with entitlements + hardened
# runtime so the automation entitlement is honored.
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --timestamp=none \
  --keychain "$KEYCHAIN" --sign "$IDENTITY" "$STAGED_APP/Contents/MacOS/decks-bridge"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --timestamp=none \
  --keychain "$KEYCHAIN" --sign "$IDENTITY" "$STAGED_APP"

echo "==> Verifying staged signature"
codesign --verify --deep --strict --verbose=4 "$STAGED_APP"

# Replace original with the signed copy.
rm -rf "$APP"
ditto --norsrc --noextattr --noqtn "$STAGED_APP" "$APP"
rm -rf "$STAGE"

echo "==> Verifying installed signature"
codesign --verify --deep --strict --verbose=4 "$APP"

# Capture codesign info ONCE, then read from the variable. (Piping codesign
# straight into `grep | head` under `set -o pipefail` can SIGPIPE-abort the
# script; `|| true` + a captured string avoids that.)
INFO="$(codesign -dv --verbose=4 "$APP" 2>&1 || true)"
printf '%s\n' "$INFO" | grep -E '^Authority=|^Identifier=' || true

if printf '%s\n' "$INFO" | grep -q "Signature=adhoc"; then
  echo "ERROR: app is still AD-HOC signed — beta identity was not applied" >&2
  exit 1
fi
echo "==> OK: signed with self-signed identity '$IDENTITY' (not ad-hoc)"
