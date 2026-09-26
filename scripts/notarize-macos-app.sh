#!/usr/bin/env bash
# Submit a signed .app (or a signed .dmg that contains it) to Apple
# notarization and staple the ticket.
set -euo pipefail

ITEM="${1:?Usage: notarize-macos-app.sh /path/to/Decks Bridge.app | /path/to/image.dmg}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-signing-env.sh"

SUBMIT_ZIP=""
if [[ "$ITEM" == *.dmg ]]; then
  [[ -f "$ITEM" ]] || { echo "ERROR: Not a file: $ITEM" >&2; exit 1; }
  echo "==> Pre-notarization signature check (disk image)"
  codesign --verify --strict --verbose=4 "$ITEM"
  # notarytool takes a disk image as is.
  SUBMIT="$ITEM"
else
  [[ -d "$ITEM" ]] || { echo "ERROR: Not a directory: $ITEM" >&2; exit 1; }
  echo "==> Pre-notarization signature check"
  codesign --verify --deep --strict --verbose=4 "$ITEM"
  SUBMIT_ZIP="$(mktemp -t decks-bridge-notarize).zip"
  ditto -c -k --norsrc --noextattr --noqtn --keepParent "$ITEM" "$SUBMIT_ZIP"
  SUBMIT="$SUBMIT_ZIP"
fi

echo "==> Submitting to Apple notarization (this may take several minutes)"
if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  [[ -f "$APPLE_API_KEY_PATH" ]] || { echo "ERROR: APPLE_API_KEY_PATH not found" >&2; exit 1; }
  xcrun notarytool submit "$SUBMIT" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  xcrun notarytool submit "$SUBMIT" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
else
  cat >&2 <<'EOF'
ERROR: Notarization credentials missing.

Set in .env.signing (see .env.signing.example):
  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
    — or —
  APPLE_API_KEY_ID + APPLE_API_ISSUER + APPLE_API_KEY_PATH
EOF
  [[ -z "$SUBMIT_ZIP" ]] || rm -f "$SUBMIT_ZIP"
  exit 1
fi

[[ -z "$SUBMIT_ZIP" ]] || rm -f "$SUBMIT_ZIP"

# Stapling fails unless Apple accepted the submission (there is no ticket to
# staple otherwise), so a rejected build always stops here.
echo "==> Stapling notarization ticket"
xcrun stapler staple "$ITEM"
xcrun stapler validate "$ITEM"

echo "==> Gatekeeper assessment (must be accepted for public release)"
if [[ "$ITEM" == *.dmg ]]; then
  spctl -a -vvv -t open --context context:primary-signature "$ITEM"
else
  spctl -a -vvv "$ITEM"
fi
