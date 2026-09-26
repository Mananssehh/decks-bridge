# Decks Bridge — Signed macOS Release Checklist

A macOS build is only publicly distributable when **every** box below is checked.
Until then it is internal-only and macOS Gatekeeper will reject it as "damaged"
on any Mac other than the one that built it.

> Why this exists: builds signed with a self-signed ("Decks Bridge Beta Signing")
> or ad-hoc certificate, without Apple notarization, are rejected by Gatekeeper.
> This was verified end-to-end with `spctl`, `codesign`, and `stapler`. The ZIP
> packaging and Google Drive transport were both proven clean — signing +
> notarization is the only gate.

**Scope of the first public releases: macOS only** (Apple Silicon + Intel).
Windows is not built or published by the release workflow and is not in
`latest.json` yet (`RELEASE.md` → "Enabling Windows releases later").

Setup details, secret names and the pipeline: `RELEASE.md`.

## Prerequisites (one-time, then reused)

- [ ] **Apple Developer Program active** — paid membership ($99/year). Verify at
      https://developer.apple.com/account (Membership shows "Active").
- [ ] **Developer ID Application certificate** — created by the Account Holder.
      Local: in the login keychain (`security find-identity -v -p codesigning`
      lists `Developer ID Application: <Name> (<TEAMID>)`).
      CI: `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
      `APPLE_SIGNING_IDENTITY` Actions secrets.
- [ ] **Notarization credentials configured** — either
      - App Store Connect API key: CI secrets `APPLE_API_KEY` (the `.p8` file
        contents) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`; locally
        `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH` in
        `.env.signing`, or
      - Apple ID: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
- [ ] **Updater signing key configured** — `TAURI_SIGNING_PRIVATE_KEY` +
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (CI requires a password-protected
      key), or `~/.tauri/decks-bridge.key` locally. It must match
      `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (key ID
      `EE94C01FAE1F465D`), or installed apps reject every update.

In CI, the `prepare` job checks all of these (names only) and the updater key
before anything is built. Locally, `scripts/preflight-signing.sh` asserts them
and aborts the build if any is missing — it runs automatically as step [0/7] of
`build-release.sh`.

## First time after merging the pipeline: dry run (see `RELEASE.md`)

- [ ] **Run workflow** on `main` without secrets fails in `prepare` at
      *Release secrets are configured*, listing the missing names (optional).
- [ ] With secrets: **Run workflow** on `main` passes `prepare`, `verify` and both
      `build-macos` jobs; `publish` is skipped.
- [ ] The `macos-aarch64` / `macos-x64` workflow artifacts install cleanly on a
      Mac that did not build them (clean-Mac test below).
- [ ] Pre-release rehearsal: tag `vX.Y.Z-rc.1` publishes a GitHub **pre-release**
      (not Latest) with the eight macOS files, `latest.json` and
      `SHA256SUMS.txt`.

## Build + sign + notarize (automated: tag push, or `npm run build:release`)

- [ ] **Preflight passes** — `scripts/preflight-signing.sh` exits 0.
- [ ] **Release built** — `bash scripts/build-release.sh <target>` for both
      `aarch64-apple-darwin` and `x86_64-apple-darwin` (CI builds both).
- [ ] **Developer ID signing** — Hardened Runtime enabled, entitlements applied.
- [ ] **Notarization passes** — `xcrun notarytool submit --wait` returns
      `status: Accepted` (for the app, and again for the DMG).
- [ ] **Stapler validation passes** — `xcrun stapler validate` on the app and on
      the DMG → "The validate action worked!".

## Verification gates (must all pass before publishing)

`scripts/verify-release.sh "<app>" <target>` runs all of these and fails on the
first problem; CI runs it for each architecture.

- [ ] **codesign verification passes** —
      `codesign --verify --deep --strict --verbose=4 "Decks Bridge.app"` → no errors,
      and `codesign -dv` shows `Authority=Developer ID Application: … (TEAMID)`,
      a `TeamIdentifier` (not "not set") and `flags=…(runtime)`.
- [ ] **spctl assessment passes** —
      `spctl -a -t exec -vvv "Decks Bridge.app"` → `accepted` and
      `source=Notarized Developer ID` (on a Mac where `spctl --status` says
      "assessments enabled").
- [ ] **DMG itself passes** —
      `spctl -a -t open --context context:primary-signature -vvv <dmg>` →
      `accepted`, `source=Notarized Developer ID`; `xcrun stapler validate <dmg>`.
- [ ] **Every artifact re-verified** — the app *inside* the DMG, the ZIP and the
      updater `.app.tar.gz` each pass the checks above, not just the loose bundle.
- [ ] **Right architecture and version** — each executable is exactly the
      architecture in its file name (`lipo -archs`: `arm64` for `aarch64`,
      `x86_64` for `x64`) and `CFBundleShortVersionString` is the release version.
- [ ] **Updater signature verifies** —
      `node scripts/release-tools.mjs verify-signature <file>.app.tar.gz` succeeds
      against `plugins.updater.pubkey`.

## Clean-Mac install test (do NOT skip)

- [ ] **Download the actual artifact** (from the real distribution channel, so it
      gets the quarantine attribute) onto a Mac that did **not** build it.
- [ ] **Open it normally** — double-click, drag to Applications, launch. It must
      open with **no** "damaged" dialog and **no** Terminal / `xattr` workaround.
- [ ] Ideally test on both Apple Silicon and a real Intel Mac (Rosetta ≠ real HW).

## Publish (only after every box above is checked)

- [ ] Version bumped (`npm run release:version -- X.Y.Z`), `CHANGELOG.md` has
      `## [X.Y.Z] - date` with DJ-facing notes, merged to `main`.
- [ ] Tag `vX.Y.Z` pushed from `main`, higher than the current Latest release.
- [ ] Release workflow green. The GitHub Release holds exactly the eight macOS
      files (`Decks.Bridge_X.Y.Z_{aarch64,x64}.{dmg,app.zip,app.tar.gz,app.tar.gz.sig}`),
      `latest.json` (generated by the workflow from verified signatures; only
      `darwin-aarch64` and `darwin-x86_64`) and `SHA256SUMS.txt`, and is Latest.
- [ ] Artifacts come only from `release/v<version>/mac/` (never `release/internal/`).
- [ ] Google Drive / website links point to the **new** notarized artifacts —
      and the old unsigned ones are gone from every channel.
- [ ] End-to-end update test done once (`RELEASE.md` → dry-run sequence, step 5):
      an older installed build shows the alert, updates, restarts, keeps pairing
      and permissions.

## Guardrails already in place

- `release.yml` `prepare` — refuses to start any build when a secret is missing
  or malformed, or the updater key does not match the app.
- `preflight-signing.sh` + `build-release.sh [0/7]` — refuse to build unsigned.
- `package-artifacts.sh` — refuses to package an app that is not Developer ID
  signed, notarized, stapled and Gatekeeper-accepted, or not the requested
  architecture; notarizes the DMG; verifies the updater signature.
- `verify-release.sh` — re-checks every artifact of the requested architecture.
- `release-tools.mjs check-release-files` — the release must be exactly the
  expected files; `latest-json` refuses any signature that does not verify.
- `release.yml` `publish` — tag pushes only, draft first, never replaces a
  published release; manual runs never publish.
- `release-policy.test.mjs` (`npm test`) — fails if the workflow or scripts gain a
  branch trigger, a self-signed/ad-hoc/internal step, a missing gate, `secrets`
  in an `if:`, or an unchecked secret.
- `build-internal.sh` — writes only under `release/internal/`; never a public path.
- `sync-tester-folders.sh` — copies only this version's notarized, arch-correct
  DMG/ZIP into the shareable tester folder.
