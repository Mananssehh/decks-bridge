#!/usr/bin/env bash
# Sign Decks Bridge with Developer ID Application (hardened runtime). No ad-hoc fallback.
set -euo pipefail

APP="${1:?Usage: sign-macos-app.sh /path/to/Decks Bridge.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/src-tauri/entitlements.plist"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-signing-env.sh"

[[ -d "$APP" ]] || { echo "ERROR: Not a directory: $APP" >&2; exit 1; }
[[ -x "$APP/Contents/MacOS/decks-bridge" ]] || { echo "ERROR: Missing executable" >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "ERROR: Missing entitlements.plist" >&2; exit 1; }

resolve_signing_identity() {
  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    echo "$APPLE_SIGNING_IDENTITY"
    return
  fi
  security find-identity -v -p codesigning 2>/dev/null \
    | rg 'Developer ID Application' \
    | head -1 \
    | sed -E 's/.*"(Developer ID Application:.*)"/\1/' || true
}

SIGNING_IDENTITY="$(resolve_signing_identity)"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  cat >&2 <<'EOF'
ERROR: No Developer ID Application certificate found.

Public distribution requires:
  1. Apple Developer Program membership
  2. Developer ID Application certificate in Keychain
  3. APPLE_SIGNING_IDENTITY in .env.signing (see .env.signing.example)

Run: security find-identity -v -p codesigning
EOF
  exit 1
fi

echo "==> Signing with: $SIGNING_IDENTITY"

# Always sign from a clean copy outside iCloud Desktop sync paths.
STAGE="$(mktemp -d)"
STAGED_APP="$STAGE/Decks Bridge.app"
ditto --norsrc --noextattr --noqtn "$APP" "$STAGED_APP"

rm -rf "$STAGED_APP/Contents/_CodeSignature"
xattr -cr "$STAGED_APP" 2>/dev/null || true

codesign --remove-signature "$STAGED_APP/Contents/MacOS/decks-bridge" 2>/dev/null || true
codesign --force \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGNING_IDENTITY" \
  "$STAGED_APP/Contents/MacOS/decks-bridge"

codesign --force \
  --options runtime \
  --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$SIGNING_IDENTITY" \
  "$STAGED_APP"

echo "==> Verifying staged signature"
codesign --verify --deep --strict --verbose=4 "$STAGED_APP"

rm -rf "$APP"
ditto --norsrc --noextattr --noqtn "$STAGED_APP" "$APP"
rm -rf "$STAGE"

echo "==> Verifying installed signature"
codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | rg "Authority=|TeamIdentifier=|Signature=|Sealed Resources" || true
