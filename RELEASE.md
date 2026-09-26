# Decks Bridge — Release Guide

Direct download distribution (not the App Store or Microsoft Store).

**Initial public release scope: macOS only** — Apple Silicon and Intel builds,
every one **Developer ID signed, notarized by Apple, stapled, and accepted by
Gatekeeper**. The Windows app code is unchanged and Windows can still be built
locally, but the release workflow does not build or publish Windows and
`latest.json` has no Windows entry until a Windows code-signing certificate is
in place ([Enabling Windows releases later](#enabling-windows-releases-later)).

A release is published **only** when you push a version tag (`v1.2.3`). Installed
apps then offer that version as an in-app update.

`RELEASE_CHECKLIST.md` is the per-release checklist; this file explains the
setup and the pipeline.

---

## How a release reaches DJs

```
git tag v1.2.3 ─▶ .github/workflows/release.yml
   prepare (Linux)   tag = app version · stable tags are on main · CHANGELOG notes
                     · every Apple + Tauri secret present · updater key matches the app
   verify (macOS)    typecheck · lint · tests · frontend build · Rust tests
   build-macos       Apple Silicon and Intel, each:
                     Developer ID sign → notarize + staple → DMG (itself signed,
                     notarized, stapled) · ZIP · updater .app.tar.gz + .sig
                     → scripts/verify-release.sh checks every artifact
   publish           tag pushes only: complete artifact set → latest.json from
                     verified signatures → SHA256SUMS.txt → draft → publish
                                                        │
Installed app ──(launch + every 4 h)──▶ github.com/Mananssehh/decks-bridge/releases/latest/download/latest.json
```

- **Nothing else publishes.** Pushes and merges to any branch, `main` included,
  never run the release workflow. The app reads `latest.json` from the newest
  *published, non-pre-release* GitHub Release, and only a tag push creates
  releases. Tags like `v1.2.3-rc.1` become GitHub *pre-releases*, which
  installed apps ignore; the app also refuses any pre-release version on its
  own (`src-tauri/src/updater.rs`).
- **When the app checks:** about 10 seconds after launch, then every 4 hours
  while open (30 minutes after a failed check, e.g. offline at a venue). Only the
  main window checks. DJs can check by hand: Diagnostics → **Check for updates**.
- **The alert** shows the new version, the installed version and the release
  notes, with **Update Now** and **Remind Me Later**. If a track is playing it
  warns that updating restarts the app.
- **Remind Me Later** hides that version for 24 hours (remembered across
  restarts). A newer release, or a manual check, shows the alert right away.
- **Update Now** downloads the update with progress, verifies its signature
  against the public key in `src-tauri/tauri.conf.json`
  (`plugins.updater.pubkey`) **before** installing, installs it and restarts.
  Pairing and settings are kept (they live outside the app bundle).
- Code: `src-tauri/src/updater.rs` (check/install commands, stable-only policy,
  typed errors), `src/lib/updateController.ts` (scheduling, reminders),
  `src/components/UpdateAlert.tsx` (the alert). The webview has no direct access
  to the updater plugin: `src-tauri/capabilities/default.json` grants no
  `updater:*` permissions.

### What a release contains

| File | What it is |
|------|------------|
| `Decks.Bridge_<version>_aarch64.dmg` / `_x64.dmg` | Download for Apple Silicon / Intel Macs. The disk image and the app inside are both notarized and stapled. |
| `Decks.Bridge_<version>_aarch64.app.zip` / `_x64.app.zip` | Alternative download (the same notarized app) |
| `Decks.Bridge_<version>_aarch64.app.tar.gz` / `_x64.app.tar.gz` | In-app update archives |
| `….app.tar.gz.sig` | Their updater signatures (minisign) |
| `latest.json` | The update manifest installed apps read: `darwin-aarch64` and `darwin-x86_64` only |
| `SHA256SUMS.txt` | Checksums of all of the above |

The file set is defined once, in `scripts/release-tools.mjs` (`PLATFORM_FILES`,
`RELEASE_PLATFORMS`) and `scripts/release-common.sh`; the workflow refuses a
release with any file missing, empty or unexpected.

---

## One-time setup (before the first release)

Everything here is a GitHub Actions secret under **Settings → Secrets and
variables → Actions → Repository secrets**. The workflow stops in its first job,
before building anything, and lists the missing secret **names** until they
exist. Never commit them, paste them into issues or chats, or echo them in
scripts. The `gh secret set` commands below read values from a file or a hidden
prompt, so nothing lands in your shell history.

| Secret | Required | What it is |
|--------|----------|------------|
| `APPLE_CERTIFICATE` | yes | Your **Developer ID Application** certificate and private key, exported as `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | yes | The password you chose when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | yes | The identity's full name, e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_KEY` | notarization, option A | Contents of the App Store Connect API key file `AuthKey_<KEYID>.p8` |
| `APPLE_API_KEY_ID` | notarization, option A | That key's ID |
| `APPLE_API_ISSUER` | notarization, option A | Your App Store Connect issuer ID |
| `APPLE_ID` | notarization, option B | Apple ID email of an account on the team |
| `APPLE_APP_SPECIFIC_PASSWORD` | notarization, option B | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | notarization, option B (recommended with A too) | Your 10-character Team ID; when set, verification also checks every signature comes from this team |
| `TAURI_SIGNING_PRIVATE_KEY` | yes | Contents of the updater private key file (from `tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | yes | That key's password (the release requires a password-protected key) |

Notarization needs **one complete option**: A (`APPLE_API_KEY` +
`APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, recommended) or B (`APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`).

### 1. Apple Developer ID certificate

Requires a paid Apple Developer Program membership; only the team's Account
Holder can create a Developer ID certificate.

1. In Xcode (Settings → Accounts → Manage Certificates → **+** → *Developer ID
   Application*) or at developer.apple.com → Certificates, create a
   **Developer ID Application** certificate (not "Apple Development", not
   "Developer ID Installer").
2. In Keychain Access → My Certificates, right-click
   `Developer ID Application: … (TEAMID)` → **Export** → `.p12`, with a new
   export password.
3. Store it:
   ```bash
   base64 -i ~/Desktop/developer-id.p12 | gh secret set APPLE_CERTIFICATE
   gh secret set APPLE_CERTIFICATE_PASSWORD      # prompts; paste the export password
   gh secret set APPLE_SIGNING_IDENTITY          # prompts; paste the name, e.g. Developer ID Application: Your Name (TEAMID)
   rm ~/Desktop/developer-id.p12
   ```
   `security find-identity -v -p codesigning` shows the exact name. Keep the
   `.p12` only in the secret and your password manager: it is the key that
   makes macOS trust an app as yours.

### 2. Notarization credentials

**Option A — App Store Connect API key (recommended).** App Store Connect →
Users and Access → Integrations → **Team Keys** → generate a key with the
*Developer* role. Download `AuthKey_<KEYID>.p8` (Apple lets you download it only
once) and note the Key ID and Issuer ID shown on that page.

```bash
gh secret set APPLE_API_KEY < ~/Downloads/AuthKey_ABC123DEFG.p8   # the file itself, not base64
gh secret set APPLE_API_KEY_ID                                    # prompts; e.g. ABC123DEFG
gh secret set APPLE_API_ISSUER                                    # prompts; the issuer UUID
gh secret set APPLE_TEAM_ID                                       # optional here; prompts
```

The workflow writes the key to `$RUNNER_TEMP/AuthKey.p8`, passes that exact path
to the build as `APPLE_API_KEY_PATH`, and deletes it at the end of the job.
(Tauri's own docs use `APPLE_API_KEY` for the key *ID*; here it is the key
*file*, and the check catches the mix-up before building.)

**Option B — Apple ID.** Create an app-specific password at account.apple.com →
Sign-In and Security → App-Specific Passwords, then set `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` the same way.

### 3. Updater signing key

Installed apps only accept updates signed by the private key that matches the
public key committed in `src-tauri/tauri.conf.json` (key ID `EE94C01FAE1F465D`).
It was probably created as `~/.tauri/decks-bridge.key` (see
`scripts/load-signing-env.sh`). Check it on your Mac — this compares **public**
keys only:

```bash
[ "$(cat ~/.tauri/decks-bridge.key.pub)" = "$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")" ] \
  && echo "MATCH: use ~/.tauri/decks-bridge.key" || echo "DIFFERENT or missing"
```

**If it matches** and you know its password, go to "Store it". **If it is
missing, different, has no password, or you forgot the password,** create a new
pair. No updater-capable build has shipped yet, so replacing the key costs
nothing now:

```bash
mkdir -p ~/.tauri
# Prompts for a password (use a strong one; it is not echoed).
# Writes the private key to the file and prints only file paths — never the key.
npx tauri signer generate -w ~/.tauri/decks-bridge-updater.key
cat ~/.tauri/decks-bridge-updater.key.pub   # public — safe to copy
```

Put that public key into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`
and commit it. For local signing, point `.env.signing` (gitignored) at the new
key or rename it to `~/.tauri/decks-bridge.key`.

**Store it:**

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/decks-bridge.key   # or decks-bridge-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD                      # prompts; paste the password
```

The workflow signs a throwaway file with this key and verifies it against
`plugins.updater.pubkey` before any build starts, so a wrong key or password
fails in a minute, not after the macOS builds. Back up the key file and password
in your password manager: **if either is lost, installed apps can never accept
another update** — every DJ would have to reinstall manually.

### 4. Optional hardening (GitHub settings — your call)

- A **tag ruleset** restricting who can create `v*` tags, since pushing a tag
  publishes to every DJ.
- Keep `main` protected so stable tags (which must point at `main`) only ever
  contain reviewed code.
- An `environment` with required reviewers on the `publish` job would add a
  manual approval before anything is published.

---

## After merging: dry-run sequence

`workflow_dispatch` only works once the workflow is on the default branch, so
these steps start **after** this pipeline is merged to `main`. None of them
publishes anything until step 3.

0. **Fail-closed check (before adding secrets, optional).** Actions → Release →
   **Run workflow** on `main`. Expected: `prepare` fails at *Release secrets are
   configured* and lists the missing secret names; `verify`, `build-macos` and
   `publish` never start. This proves a missing credential stops the release
   before any build.
1. **Add the secrets** (One-time setup above).
2. **Full dry run.** Run workflow on `main` again. Expected: `prepare`, `verify`
   and both `build-macos` jobs pass; `publish` is **skipped** (manual runs never
   publish). Download the `macos-aarch64` and `macos-x64` workflow artifacts and,
   on a Mac:
   ```bash
   spctl -a -vvv -t open --context context:primary-signature Decks.Bridge_*_aarch64.dmg   # accepted, Notarized Developer ID
   xcrun stapler validate Decks.Bridge_*_aarch64.dmg
   ```
   Then install each DMG on a Mac that did not build it — Apple Silicon and, if
   you can, a real Intel Mac — by opening it from the downloaded file: no
   "damaged" or "unidentified developer" dialog, no Terminal workaround.
3. **Pre-release rehearsal.** On a branch, `npm run release:version -- 0.2.0-rc.1`,
   add a `## [0.2.0-rc.1]` section to `CHANGELOG.md`, commit, and push tag
   `v0.2.0-rc.1`. Expected: a GitHub **pre-release** with the eight macOS files,
   `latest.json` (two `darwin-*` entries) and `SHA256SUMS.txt`, not marked
   Latest. Installed apps ignore it. Delete the pre-release (and its tag) when
   done, or keep it for reference.
4. **First stable release.** Follow [Publishing a release](#publishing-a-release)
   with `0.2.0`. Testers on 0.1.0 install it manually once (0.1.0 cannot
   auto-update; see Limitations).
5. **End-to-end update test (required before relying on updates).**
   1. Install `0.2.0` from its DMG on a Mac; pair it and grant permissions.
   2. Publish `0.2.1` (stable).
   3. Open `0.2.0`: within ~10 s the alert shows 0.2.1 and its notes.
   4. **Remind Me Later**, quit and reopen: no alert. Diagnostics → **Check for
      updates**: the alert is back.
   5. **Update Now**: progress, then the app restarts as 0.2.1. Check the
      version, that pairing survived, and that djay/rekordbox/Music detection
      still works without re-granting permissions.
   6. Repeat on an Intel Mac.

The automated checks cover the logic (Rust and Vitest suites, the release-tool
and policy tests) and every signature is verified against the app's public key,
but only this test proves the real download → verify → install → restart path.

---

## Publishing a release

1. Bump the version everywhere it is recorded (`tauri.conf.json` — what the app
   reports at runtime — plus `package.json`, `package-lock.json`, `Cargo.toml`,
   `Cargo.lock`):
   ```bash
   npm run release:version -- 0.2.0
   ```
2. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [0.2.0] - YYYY-MM-DD` and
   write the notes **for DJs** — they appear in the update alert and on the
   GitHub Release.
3. Commit, open a PR, merge to `main`.
4. Tag the merged commit and push the tag:
   ```bash
   git checkout main && git pull
   git tag -a v0.2.0 -m "Decks Bridge 0.2.0"
   git push origin v0.2.0
   ```
5. Watch **Actions → Release**. When it finishes, the GitHub Release `v0.2.0`
   holds the files listed above and is marked Latest. Installed apps offer the
   update at their next launch or within about 4 hours.

Always tag a higher version than the current Latest release: the newest
*published* stable release is what installed apps read.

**If the workflow fails,** nothing has been published: the release is created as
a draft and only made public in the last step. Fix the problem, then either use
**Re-run all jobs** (same commit) or, for a code fix, delete the tag
(`git push --delete origin v0.2.0 && git tag -d v0.2.0`), merge the fix and tag
again. The workflow replaces a leftover draft but refuses to touch a release
that is already published.

---

## What the release workflow checks

Before building (`prepare`):
- The tag equals the version in every version file, and a stable tag points at a
  commit on `main`.
- `CHANGELOG.md` has a section for the version.
- Every required Apple and Tauri secret is set, in the expected form (names
  only; values are never printed), and the updater key matches
  `plugins.updater.pubkey`.

Before packaging, per architecture (`build-macos`, `scripts/build-release.sh`):
- `scripts/preflight-signing.sh`: a Developer ID Application identity is in the
  keychain and notarization credentials exist.
- The app is Developer ID signed with the hardened runtime, notarized, stapled,
  and Gatekeeper (`spctl`) accepts it as *Notarized Developer ID* — on a runner
  where Gatekeeper assessments are verified to be on.
- Its executable is the architecture of the requested target (`lipo`), never
  the runner's, and its `CFBundleShortVersionString` equals the release version.

After packaging (`scripts/verify-release.sh`):
- The DMG itself is Developer ID signed, notarized, stapled and accepted.
- The app inside the DMG, the ZIP and the updater tarball each pass all the app
  checks above.
- The updater signature verifies against `plugins.updater.pubkey`.
- The job's files are exactly this architecture's four files.

Before publishing (`publish`, tag pushes only):
- Both architectures are present, nothing missing or extra.
- `latest.json` is generated only after every updater signature verifies again.
- The final set (with `latest.json` and `SHA256SUMS.txt`) is checked, uploaded
  to a draft, and only then published.

Throughout: the token is read-only except in `publish` (`contents: write`),
checkouts do not keep credentials, each secret is exposed only to the steps that
use it, and no `if:` reads secrets. `scripts/release-policy.mjs` encodes these
rules and `scripts/release-policy.test.mjs` (part of `npm test`) fails if the
workflow or the release scripts drift from them — for example a branch trigger,
a self-signed or ad-hoc step, a missing gate, or an unchecked secret.

---

## Enabling Windows releases later

The Windows app code and build scripts are kept as they are. To publish Windows
once you have a Windows code-signing certificate (OV/EV Authenticode, or a cloud
signing service):

1. **Make the Windows build fail closed.** `scripts/build-release-windows.ps1`
   currently skips Authenticode signing silently when `signtool` or
   `WINDOWS_SIGNING_CERT` is missing, and `package-windows-artifacts.ps1` skips
   the updater signature when `TAURI_SIGNING_PRIVATE_KEY` is missing. Both must
   become errors, and the build should verify the result
   (`signtool verify /pa /v` on the installer and portable exe; the updater
   signature with `node scripts/release-tools.mjs verify-signature`).
2. **Secrets.** Add `WINDOWS_SIGNING_CERT` (base64 `.pfx`) and
   `WINDOWS_SIGNING_CERT_PASSWORD`, and add them to `REQUIRED_SECRETS` in
   `scripts/release-tools.mjs` so `check-secrets` requires them.
3. **Workflow.** Add a `build-windows` job (`windows-latest`, needs `prepare` and
   `verify`) that builds, verifies the signatures, renames the outputs to the
   names in `PLATFORM_FILES["windows-x86_64"]`
   (`Decks.Bridge_<version>_x64-setup.exe`, `…_x64-setup.nsis.zip` + `.sig`,
   `…_x64-portable.zip`), checks them with
   `check-release-files --platforms windows-x86_64` and uploads them; make
   `publish` need it and copy its files in.
4. **Manifest.** Add `"windows-x86_64"` to `RELEASE_PLATFORMS` in
   `scripts/release-tools.mjs`: `latest.json` then lists Windows and
   `check-release-files` requires its files.
5. **Policy.** Update `scripts/release-policy.mjs` (it rejects Windows jobs
   today) to require the Windows gates instead, and its tests.
6. Dry run, pre-release rehearsal and an end-to-end update test on Windows, as
   for macOS. Until then, Windows installs find no Windows entry in
   `latest.json`: background checks fail quietly (logged, retried) and a manual
   check says update information isn't available.

---

## Local builds

```
release/
├── v{version}/mac/     # PUBLIC: Decks.Bridge_{version}_{aarch64|x64}.{dmg,app.zip,app.tar.gz,app.tar.gz.sig}
├── mac/                # copies of those public files (all versions built here)
├── internal/           # INTERNAL ONLY — self-signed/ad-hoc, never published or synced
│   ├── v{version}/mac/
│   ├── mac/
│   └── testers-mac/
├── windows/            # Windows builds (made on Windows; not published)
├── v{version}/windows/
└── SHA256SUMS.txt      # scripts/hash-release.sh
```

- **Production, same pipeline as CI** (needs the Developer ID certificate in
  your keychain and credentials in `.env.signing`, see `.env.signing.example`;
  locally the API key is a file, `APPLE_API_KEY_PATH`):
  ```bash
  npm run build:release                          # this Mac's architecture
  bash scripts/build-release.sh x86_64-apple-darwin
  npm run sync:testers                           # copy the notarized build into "decks bridge Mac"
  ```
  `sync:testers` copies only builds that pass the same notarization checks.
- **Internal beta** (self-signed "Decks Bridge Beta Signing", local testing only;
  `docs/BETA_SIGNING.md`): `npm run build:internal`. Output stays under
  `release/internal/` and is never published or synced to shareable folders.
  Send `TEST_INSTALL.md` with it; testers need the Gatekeeper workaround it
  describes.
- **Windows** (on Windows 10/11 x64): `npm run build:internal:windows` (unsigned
  internal build, `TEST_INSTALL_WINDOWS.md`) or `npm run build:release:windows`
  (see "Enabling Windows releases later" before distributing it).

---

## Limitations

1. **Not yet run on GitHub's macOS runners.** The signing, notarization,
   stapling and Gatekeeper steps have been checked with stub tests and
   ShellCheck but have never produced a real notarized build. The dry-run
   sequence above is the first real run.
2. **Builds already installed (0.1.0) cannot auto-update.** They poll the old
   endpoint (`raw.githubusercontent.com/Mananssehh/decks-bridge-releases/main/update-manifest.json`,
   a repository that does not exist). Testers install the first
   updater-capable release manually once; later releases arrive in-app.
3. **Testers re-grant permissions once.** macOS ties Accessibility (djay Pro,
   rekordbox) and Automation (Music, Spotify) grants to the signing identity.
   Moving from a self-signed beta build to the first Developer ID build changes
   it, so testers re-grant once; Developer ID updates after that keep the grants
   (the requirement is tied to your Team ID). Confirm in the end-to-end test.
4. **Replacing the app may prompt.** If the DJ's account cannot write to
   `/Applications`, macOS asks for an administrator password during the update.
5. **Repository visibility.** The app downloads updates from this repository's
   GitHub Releases, which works because the repository is public (its GitHub
   description says "Private"). If you make it private, installed apps can no
   longer fetch updates: first ship an update whose endpoint points at a public
   releases repository, then change visibility.
6. **No downgrades or rollback.** Installed apps never move to an older version.
   To stop a bad release spreading, delete it or mark it as a pre-release (the
   endpoint then serves the previous release); fix forward with a higher version.
7. **Intel Macs:** built and verified as x86_64 in CI, but not yet tested on
   Intel hardware.
8. **Mini/Pill:** the alert lives in the main window. A DJ using only Mini or
   Pill sees it when they return to the main window.
9. **Windows:** not published yet (see above).

---

## Feature parity

| Feature | macOS | Windows |
|---------|-------|---------|
| Pairing (6-digit code) | ✅ | ✅ |
| Deep link (`decksbridge://`) | ✅ (asks before connecting) | ✅ (registered by NSIS installer) |
| Supabase bridge-pair | ✅ | ✅ |
| now-playing-ingest | ✅ | ✅ |
| Auto Now Playing detection | MediaRemote + AppleScript | SMTC (System Media Transport Controls) |
| Manual track entry | ✅ | ✅ |
| Reconnect / heartbeat | ✅ | ✅ |
| Background operation | Dock (closing the window hides it) | System tray |
| Minimize to tray | — | ✅ (close hides to tray) |
| Start with OS (optional) | ✅ (autostart plugin) | ✅ (autostart plugin) |
| Public release + in-app updates | ✅ (Developer ID + notarized; see Limitations) | Not published yet |
| File logging | `~/Library/Logs/Decks Bridge/` | `%LOCALAPPDATA%\Decks Bridge\Logs\` |
| Sentry (optional) | Set `SENTRY_DSN` | Set `SENTRY_DSN` |

Update checks and installs are logged under the `update` category in the log
files above.

### Platform differences

- **macOS detection** uses MediaRemote, Apple Music AppleScript, and djay accessibility fallbacks.
- **Windows detection** uses SMTC only — no djay-specific AX scraping.
- **Windows** requires **WebView2** (pre-installed on most Windows 10/11; NSIS installer bootstraps if missing).
- **Portable Windows exe** does not register `decksbridge://` — use the NSIS installer for deep links.

---

## Security notes

Release scripts verify:

- No `.git` in app bundles
- No AppleDouble `._*` files (macOS packaging)
- No placeholder URLs in the binary
- No embedded signing secrets (use `.env.signing`, gitignored, or Actions secrets)
- Config stored locally (localStorage / AppData), not in the binary

macOS compile-path strings (`/Users/.../.cargo/...`) may appear in panic messages — not runtime dependencies.

`localhost:1420` in the binary is Tauri dev metadata; release builds serve bundled assets via `tauri://localhost`.

---

## Crash reporting (Sentry)

Not enabled by default. To prepare for a future release:

1. Set `SENTRY_DSN` environment variable at launch.
2. Add the Sentry SDK in `src-tauri/src/sentry.rs` when ready.

The stub logs whether `SENTRY_DSN` is configured at startup.
