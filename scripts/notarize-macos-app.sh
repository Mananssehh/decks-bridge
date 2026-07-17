#!/usr/bin/env bash
# Submit signed .app to Apple notarization and staple the ticket.
set -euo pipefail

APP="${1:?Usage: notarize-macos-app.sh /path/to/Decks Bridge.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-signing-env.sh"

[[ -d "$APP" ]] || { echo "ERROR: Not a directory: $APP" >&2; exit 1; }

echo "==> Pre-notarization signature check"
codesign --verify --deep --strict --verbose=4 "$APP"

SUBMIT_ZIP="$(mktemp -t decks-bridge-notarize).zip"
ditto -c -k --norsrc --noextattr --noqtn --keepParent "$APP" "$SUBMIT_ZIP"

echo "==> Submitting to Apple notarization (this may take several minutes)"
if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  [[ -f "$APPLE_API_KEY_PATH" ]] || { echo "ERROR: APPLE_API_KEY_PATH not found" >&2; exit 1; }
  xcrun notarytool submit "$SUBMIT_ZIP" \
    --key "$APPLE_API_KEY_PATH" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  xcrun notarytool submit "$SUBMIT_ZIP" \
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
  rm -f "$SUBMIT_ZIP"
  exit 1
fi

rm -f "$SUBMIT_ZIP"

echo "==> Stapling notarization ticket"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

echo "==> Gatekeeper assessment (must be accepted for public release)"
spctl -a -vvv "$APP"
