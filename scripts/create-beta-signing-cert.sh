#!/usr/bin/env bash
# Create/import a STABLE self-signed code-signing identity for Decks Bridge beta
# builds. A stable identity keeps the app's macOS "designated requirement"
# constant across rebuilds, so Accessibility/Automation (TCC) grants are less
# likely to reset every time a new beta build is installed.
#
# INTERNAL BETA ONLY. This is NOT a Developer ID cert. It does NOT remove
# Gatekeeper warnings and does NOT replace Apple notarization.
set -euo pipefail

IDENTITY="Decks Bridge Beta Signing"
KEYCHAIN="$HOME/Library/Keychains/decks-bridge-beta.keychain-db"
KEYCHAIN_PW="decks-bridge-beta"   # fixed, internal-only; the cert has no trust value
P12_PW="beta"
OPENSSL="/usr/bin/openssl"        # LibreSSL — produces keychain-compatible PKCS#12

# Already installed? Stable identity — reuse it, NEVER regenerate (a new cert
# would change the app's designated requirement and reset TCC grants).
# NOTE: self-signed certs are "not trusted", so `find-identity -v` (valid only)
# will NOT list them — we must query without -v.
if [[ -f "$KEYCHAIN" ]] && security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "==> Identity already present (reusing): $IDENTITY"
  security find-identity -p codesigning "$KEYCHAIN" | grep "$IDENTITY"
  exit 0
fi

echo "==> Creating self-signed code-signing certificate: $IDENTITY"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = Decks Bridge Beta Signing

[v3]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf"

"$OPENSSL" pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/beta.p12" -passout "pass:$P12_PW" -name "$IDENTITY"

# Dedicated keychain with a known password so codesign can use the key
# non-interactively (no login-keychain password needed).
if [[ ! -f "$KEYCHAIN" ]]; then
  security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
fi
security set-keychain-settings "$KEYCHAIN"                 # disable auto-lock timeout
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security import "$TMP/beta.p12" -k "$KEYCHAIN" -P "$P12_PW" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null 2>&1 || true

# Add our keychain to the user search list (preserve existing entries).
EXISTING="$(security list-keychains -d user | sed 's/[[:space:]]*"\(.*\)"/\1/')"
if ! printf '%s\n' "$EXISTING" | grep -q "decks-bridge-beta.keychain"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $EXISTING
fi

echo "==> Done. Installed identity (self-signed → shows as not-trusted, which is expected):"
security find-identity -p codesigning "$KEYCHAIN" | grep "$IDENTITY" || {
  echo "ERROR: identity not found after import" >&2
  exit 1
}
