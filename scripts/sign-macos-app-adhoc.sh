#!/usr/bin/env bash
# Ad-hoc sign for private/internal testing only. Not for public direct download.
set -euo pipefail

APP="${1:?Usage: sign-macos-app-adhoc.sh /path/to/Decks Bridge.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTITLEMENTS="$ROOT/src-tauri/entitlements.plist"

[[ -d "$APP" ]] || { echo "ERROR: Not a directory: $APP" >&2; exit 1; }
[[ -x "$APP/Contents/MacOS/decks-bridge" ]] || { echo "ERROR: Missing executable" >&2; exit 1; }
[[ -f "$ENTITLEMENTS" ]] || { echo "ERROR: Missing entitlements: $ENTITLEMENTS" >&2; exit 1; }

xattr -d com.apple.FinderInfo "$APP" 2>/dev/null || true
xattr -d com.apple.fileprovider.fpfs#P "$APP" 2>/dev/null || true

# Re-sign only if the current signature is valid AND already carries the
# Apple-events automation entitlement (required for AppleScript Now Playing
# detection under hardened runtime). Otherwise fall through and re-sign.
if codesign --verify --deep --strict "$APP" 2>/dev/null \
   && codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q "com.apple.security.automation.apple-events"; then
  echo "==> Already validly ad-hoc signed with automation entitlement: $APP"
  codesign -dv --verbose=4 "$APP" 2>&1 | rg "Signature=|TeamIdentifier=|Sealed Resources" || true
  exit 0
fi

echo "==> Ad-hoc signing (internal testing only): $APP"

STAGE="$(mktemp -d)"
STAGED_APP="$STAGE/Decks Bridge.app"
ditto --norsrc --noextattr --noqtn "$APP" "$STAGED_APP"

rm -rf "$STAGED_APP/Contents/_CodeSignature"
xattr -cr "$STAGED_APP" 2>/dev/null || true

# Sign with entitlements + hardened runtime so the automation entitlement is
# actually honored. The nested binary is signed first, then the app bundle.
codesign --remove-signature "$STAGED_APP/Contents/MacOS/decks-bridge" 2>/dev/null || true
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --timestamp=none \
  --sign - "$STAGED_APP/Contents/MacOS/decks-bridge"
codesign --force --options runtime --entitlements "$ENTITLEMENTS" --timestamp=none \
  --sign - "$STAGED_APP"

echo "==> Verifying staged signature"
codesign --verify --deep --strict --verbose=4 "$STAGED_APP"

rm -rf "$APP"
ditto --norsrc --noextattr --noqtn "$STAGED_APP" "$APP"
rm -rf "$STAGE"

echo "==> Verifying installed signature"
codesign --verify --deep --strict --verbose=4 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | rg "Signature=|TeamIdentifier=|Sealed Resources" || true
