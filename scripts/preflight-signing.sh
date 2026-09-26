#!/usr/bin/env bash
# Fail-closed preflight for a PUBLIC macOS release.
#
# A release that is not Developer ID signed AND notarized shows up on users'
# machines as "Decks Bridge is damaged and can't be opened" the moment it is
# downloaded (quarantine + Gatekeeper rejection). That failure is invisible on
# the build machine, so the ONLY safe place to catch it is before we build.
#
# This script asserts that everything required to produce a distributable,
# notarizable build is actually present. It prints exactly what is missing and
# exits non-zero so the release aborts instead of silently shipping a build that
# Gatekeeper will reject. Run it as the first step of any public release path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1091
source "$ROOT/scripts/load-signing-env.sh" 2>/dev/null || true

problems=()

# ── 1. A real Developer ID Application signing identity must be available ──────
# Either the caller pinned APPLE_SIGNING_IDENTITY, or exactly one Developer ID
# Application identity is in the keychain. Ad-hoc ("-") and the self-signed
# "Decks Bridge Beta Signing" identity are NOT acceptable for a public release.
identity_ok=false
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$APPLE_SIGNING_IDENTITY"; then
    if [[ "$APPLE_SIGNING_IDENTITY" == *"Developer ID Application"* ]]; then
      identity_ok=true
    else
      problems+=("APPLE_SIGNING_IDENTITY is set to '$APPLE_SIGNING_IDENTITY' but that is not a 'Developer ID Application' identity. Gatekeeper only trusts Developer ID for downloaded apps.")
    fi
  else
    problems+=("APPLE_SIGNING_IDENTITY='$APPLE_SIGNING_IDENTITY' was not found in the keychain (security find-identity -v -p codesigning).")
  fi
else
  devid_count=$(security find-identity -v -p codesigning 2>/dev/null | grep -c "Developer ID Application" || true)
  if [[ "$devid_count" -ge 1 ]]; then
    identity_ok=true
  else
    problems+=("No 'Developer ID Application' certificate in the keychain. Enroll in the Apple Developer Program, create a Developer ID Application cert, and install it (or set APPLE_CERTIFICATE/APPLE_CERTIFICATE_PASSWORD in CI).")
  fi
fi

# ── 2. Notarization credentials must be present ───────────────────────────────
# notarytool needs EITHER an App Store Connect API key OR an Apple ID app
# password. Without these the build cannot be notarized and will be "damaged".
notary_ok=false
if [[ -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ -f "${APPLE_API_KEY_PATH}" ]]; then
    notary_ok=true
  else
    problems+=("APPLE_API_KEY_PATH='${APPLE_API_KEY_PATH}' does not exist (the App Store Connect .p8 key file is missing).")
  fi
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notary_ok=true
else
  problems+=("No notarization credentials. Set APPLE_API_KEY_ID + APPLE_API_ISSUER + APPLE_API_KEY_PATH, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (see .env.signing.example).")
fi

# ── 3. Updater signing key (so the .sig auto-update artifact can be produced) ──
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && ! -f "$HOME/.tauri/decks-bridge.key" ]]; then
  problems+=("No Tauri updater signing key (TAURI_SIGNING_PRIVATE_KEY unset and ~/.tauri/decks-bridge.key missing). Auto-update artifacts cannot be signed.")
fi

if [[ ${#problems[@]} -gt 0 ]]; then
  echo "" >&2
  echo "╳ RELEASE PREFLIGHT FAILED — refusing to build a macOS release that" >&2
  echo "  Gatekeeper would reject as \"damaged\" on every user's machine." >&2
  echo "" >&2
  for p in "${problems[@]}"; do
    echo "  • $p" >&2
  done
  echo "" >&2
  echo "  Fix the above, or run scripts/build-internal.sh for a LOCAL-ONLY" >&2
  echo "  ad-hoc build (never distribute internal builds to end users)." >&2
  echo "" >&2
  exit 1
fi

echo "✓ Release preflight passed: Developer ID identity present, notarization credentials present, updater key present."
if [[ "$identity_ok" == true && "$notary_ok" == true ]]; then
  exit 0
fi
exit 0
