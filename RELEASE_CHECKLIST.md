# Decks Bridge — Signed macOS Release Checklist

A macOS build is only publicly distributable when **every** box below is checked.
Until then it is internal-only and macOS Gatekeeper will reject it as "damaged"
on any Mac other than the one that built it.

> Why this exists: builds signed with a self-signed ("Decks Bridge Beta Signing")
> or ad-hoc certificate, without Apple notarization, are rejected by Gatekeeper.
> This was verified end-to-end with `spctl`, `codesign`, and `stapler`. The ZIP
> packaging and Google Drive transport were both proven clean — signing +
> notarization is the only gate.

## Prerequisites (one-time, then reused)

- [ ] **Apple Developer Program active** — paid membership ($99/year). Verify at
      https://developer.apple.com/account (Membership shows "Active").
- [ ] **Developer ID Application certificate installed** — in the login keychain.
      Verify: `security find-identity -v -p codesigning` lists
      `Developer ID Application: <Name> (<TEAMID>)`.
- [ ] **Notarization credentials configured** — either
      - App Store Connect API key: `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` +
        `APPLE_API_KEY_PATH` (the `.p8`), or
      - Apple ID: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
      In `.env.signing` locally, or as GitHub Actions secrets for CI.
- [ ] **Updater signing key configured** — `TAURI_SIGNING_PRIVATE_KEY`
      (+ password), or `~/.tauri/decks-bridge.key`, so the auto-update `.sig`
      artifact can be produced.

`scripts/preflight-signing.sh` asserts all four and aborts the build if any is
missing — it runs automatically as step [0/7] of `build-release.sh`.

## Build + sign + notarize (automated by `npm run build:release`)

- [ ] **Preflight passes** — `scripts/preflight-signing.sh` exits 0.
- [ ] **Release built** — `bash scripts/build-release.sh <target>`
      (`aarch64-apple-darwin` and/or `x86_64-apple-darwin`).
- [ ] **Developer ID signing** — Hardened Runtime enabled, entitlements applied.
- [ ] **Notarization passes** — `xcrun notarytool submit --wait` returns
      `status: Accepted`.
- [ ] **Stapler validation passes** — `xcrun stapler validate "Decks Bridge.app"`
      → "The validate action worked!".

## Verification gates (must all pass before publishing)

- [ ] **codesign verification passes** —
      `codesign --verify --deep --strict --verbose=4 "Decks Bridge.app"` → no errors,
      and `codesign -dv` shows `Authority=Developer ID Application: … (TEAMID)` and
      a `TeamIdentifier` (not "not set").
- [ ] **spctl assessment passes** —
      `spctl -a -t exec -vvv "Decks Bridge.app"` → `accepted` and
      `source=Notarized Developer ID`.
- [ ] **`scripts/verify-release.sh` passes** — runs all of the above on the `.app`
      and on the app inside the DMG **and** the ZIP.
- [ ] **DMG + ZIP re-verified** — the app *inside* each artifact is checked, not
      just the loose bundle.

## Clean-Mac install test (do NOT skip)

- [ ] **Download the actual artifact** (from the real distribution channel, so it
      gets the quarantine attribute) onto a Mac that did **not** build it.
- [ ] **Open it normally** — double-click, drag to Applications, launch. It must
      open with **no** "damaged" dialog and **no** Terminal / `xattr` workaround.
- [ ] Ideally test on both Apple Silicon and a real Intel Mac (Rosetta ≠ real HW).

## Publish (only after every box above is checked)

- [ ] Artifacts come only from `release/v<version>/mac/` (never `release/internal/`).
- [ ] `update-manifest.json` signatures populated (no `REPLACE_WITH_SIGNATURE`),
      and its `endpoints`/URLs point at a real, existing releases repo.
- [ ] GitHub Release / Google Drive / website links point to the **new** notarized
      artifacts — and the old unsigned ones are gone from every channel.

## Guardrails already in place

- `preflight-signing.sh` + `build-release.sh [0/7]` — refuse to build unsigned.
- `package-artifacts.sh` — refuses to package a non-Developer-ID / non-stapled app.
- `build-internal.sh` — writes only under `release/internal/`; never a public path.
- `sync-tester-folders.sh` — refuses to copy a non-notarized build to a shareable
  tester folder.
- `.github/workflows/release.yml` — no ad-hoc fallback; aborts if signing secrets
  are missing; publishes only notarized artifacts; fails if none are produced.
