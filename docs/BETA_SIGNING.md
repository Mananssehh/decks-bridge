# Beta signing (internal reference)

Decks Bridge internal beta builds are signed with a **stable self-signed code
signing identity** so the app keeps the same macOS *designated requirement*
across rebuilds. That helps TCC permissions (Accessibility for djay Pro,
Automation for Music/Spotify) **persist across beta updates** instead of
resetting on every new build a tester installs.

> This is **internal beta only**. It is NOT Apple Developer ID, it is NOT
> notarized, and it does NOT remove Gatekeeper warnings. Testers still launch
> with Right-click → Open on first run.

## Identity

- **Certificate name:** `Decks Bridge Beta Signing`
- **Bundle identifier:** `com.decks.bridge` (kept stable — do not change)
- **Keychain:** `~/Library/Keychains/decks-bridge-beta.keychain-db`
  (fixed password `decks-bridge-beta`, internal-only)
- **Designated requirement produced:**
  `identifier "com.decks.bridge" and certificate leaf = H"<cert-sha1>"`

Because the requirement pins the certificate, TCC keeps matching new builds as
long as they are signed with the **same** certificate. Keep the beta keychain —
if you delete it and recreate the cert, the leaf hash changes and testers must
re-grant permissions once.

## How it fits the build

`npm run build:internal` runs:

1. Build frontend + Tauri `.app`
2. Patch `Info.plist` (all plist edits happen here, **before** signing)
3. `scripts/sign-macos-beta.sh` signs the finished bundle with the beta identity
   (hardened runtime + entitlements). Nothing modifies the app after this.
4. Package DMG/ZIP from the already-signed bundle and verify it is **not**
   ad-hoc.

## Scripts

- `scripts/create-beta-signing-cert.sh` — creates/imports the cert if missing.
  Idempotent: if the identity already exists it is reused, never regenerated.
- `scripts/sign-macos-beta.sh <app>` — signs a bundle with the beta identity;
  creates the cert first if needed.

## Verify a build

```bash
codesign --verify --deep --strict --verbose=4 "/Applications/Decks Bridge.app"
codesign -dv --verbose=4 "/Applications/Decks Bridge.app"   # Authority=Decks Bridge Beta Signing
codesign -d -r- "/Applications/Decks Bridge.app"            # designated => … certificate leaf = H"…"
```

`Authority=Decks Bridge Beta Signing` (not `Signature=adhoc`) means it worked.

## If a tester's permission still resets

Self-signed identity reduces resets but macOS can still occasionally drop a
grant. Tell testers: remove the old **Decks Bridge** entry from the relevant
Privacy list and re-add `/Applications/Decks Bridge.app`, then relaunch.

## Note on other machines

The cert lives on the machine that created it. If you build betas from a second
Mac, either copy the same identity over (export the cert+key as `.p12` and
import it) or accept that builds from a different Mac have a different identity
(testers re-grant once). For consistent persistence, always build betas on the
same Mac.

## Public releases are different

This identity is for local internal builds only (`npm run build:internal`,
output under `release/internal/`). Public releases are built by
`.github/workflows/release.yml` with a **Developer ID Application** certificate
and are notarized and stapled (`RELEASE.md`); CI never uses the beta identity.
Because the certificate changes, a tester moving from a beta build to the first
Developer ID build re-grants Accessibility/Automation once; Developer ID builds
after that keep the grants.
