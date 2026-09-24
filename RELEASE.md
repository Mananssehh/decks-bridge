# Decks Bridge — Cross-Platform Release Guide

Direct download distribution for **macOS** and **Windows**. Not App Store / Microsoft Store.

A release is published **only** when you push a version tag (`v1.2.3`). The tag
builds both platforms in GitHub Actions and publishes a GitHub Release, and
installed apps then offer that version as an in-app update.

---

## In-app updates: how a release reaches DJs

```
git tag v1.2.3 ─▶ .github/workflows/release.yml
                    ├─ checks: tag = app version, notes in CHANGELOG.md, tests, secrets
                    ├─ macOS aarch64 + x64: build → sign (beta identity) → DMG/ZIP/.app.tar.gz → minisign .sig
                    ├─ Windows x64: NSIS installer → .nsis.zip → minisign .sig
                    └─ publish: verify every .sig → latest.json → draft release → publish
                                                                       │
Installed app ──(launch + every 4 h)──▶ github.com/Mananssehh/decks-bridge/releases/latest/download/latest.json
```

- **Nothing else publishes.** Pushes and merges to `main` never reach DJs: the
  app reads `latest.json` from the newest *published, non-pre-release* GitHub
  Release, and only the tag workflow creates releases. Tags like `v1.2.3-rc.1`
  become GitHub *pre-releases*, which installed apps ignore; the app also
  refuses any pre-release version on its own (`src-tauri/src/updater.rs`).
- **When the app checks:** about 10 seconds after launch, then every 4 hours
  while open (30 minutes after a failed check, e.g. offline at a venue). Only the
  main window checks. DJs can check by hand in Settings → Diagnostics →
  **Check for updates**.
- **The alert** shows the new version, the installed version and the release
  notes, with **Update Now** and **Remind Me Later**. If a track is playing it
  warns that updating restarts the app.
- **Remind Me Later** hides that version for 24 hours (remembered across
  restarts). A newer release, or a manual check, shows the alert right away.
- **Update Now** downloads the update, verifies its signature against the public
  key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) **before**
  installing, installs it, and restarts. On Windows the installer closes and
  reopens the app. Pairing and settings are kept (they live outside the app
  bundle).
- Code: `src-tauri/src/updater.rs` (check/install commands, stable-only
  policy), `src/lib/updateController.ts` (scheduling, reminders),
  `src/components/UpdateAlert.tsx` (the alert). The webview has no direct
  access to the updater plugin: `src-tauri/capabilities/default.json` grants no
  `updater:*` permissions.

---

## One-time setup (before the first release)

The workflow fails early, listing the missing secret names, until these exist.
Add them under **Settings → Secrets and variables → Actions → Repository
secrets**, or with the GitHub CLI as shown. Never commit them, paste them into
issues/chats, or echo them in scripts.

| Secret | Required | What it is |
|--------|----------|------------|
| `TAURI_SIGNING_PRIVATE_KEY` | yes | Contents of the updater private key file (minisign, from `tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | yes | That key's password (the workflow requires a password-protected key) |
| `MACOS_BETA_SIGNING_P12_BASE64` | yes | The "Decks Bridge Beta Signing" certificate + private key as a base64 `.p12` |
| `MACOS_BETA_SIGNING_P12_PASSWORD` | yes | The password you chose when exporting that `.p12` |
| `WINDOWS_SIGNING_CERT` | no | Base64 `.pfx` for Authenticode (unchanged, optional) |
| `WINDOWS_SIGNING_CERT_PASSWORD` | no | Its password |

### 1. Updater signing key

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

**Store it** (the GitHub CLI reads from stdin, so nothing lands in shell history):

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/decks-bridge.key   # or decks-bridge-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD                      # prompts; paste the password
```

Also back up the key file and password in your password manager. **If the key
or password is lost, installed apps can never accept another update** — every
DJ would have to reinstall manually.

### 2. macOS signing identity (keeps DJs' permissions across updates)

macOS ties Accessibility (djay Pro, rekordbox) and Automation (Music, Spotify)
grants to the app's code-signing identity. CI must sign with the **same**
self-signed "Decks Bridge Beta Signing" identity your Mac already uses
(`docs/BETA_SIGNING.md`); a new identity would make every DJ re-grant
permissions after updating, and Now Playing detection would stop until they do.
The workflow refuses to build without it rather than create a new one.

On the Mac that builds the betas:

```bash
read -rs P12_PASSWORD   # type a NEW export password, press Enter (not echoed)
security unlock-keychain -p decks-bridge-beta ~/Library/Keychains/decks-bridge-beta.keychain-db
security export -k ~/Library/Keychains/decks-bridge-beta.keychain-db \
  -t identities -f pkcs12 -P "$P12_PASSWORD" -o ~/Desktop/decks-bridge-beta.p12
base64 -i ~/Desktop/decks-bridge-beta.p12 | gh secret set MACOS_BETA_SIGNING_P12_BASE64
printf '%s' "$P12_PASSWORD" | gh secret set MACOS_BETA_SIGNING_P12_PASSWORD
rm ~/Desktop/decks-bridge-beta.p12; unset P12_PASSWORD
```

(Allow the keychain access prompt if macOS shows one; the beta keychain password
is `decks-bridge-beta`, as set by `scripts/create-beta-signing-cert.sh`.) The
`.p12` is a real private key: anyone holding it can sign apps that macOS treats
as Decks Bridge for permission purposes. Keep it only in the GitHub secret and
your password manager.

To confirm CI uses the same identity as the installed builds, compare the
`designated => … certificate leaf = H"…"` line printed by the workflow's
"Sign and package" step with:

```bash
codesign -d -r- "/Applications/Decks Bridge.app"
```

### 3. Optional hardening (GitHub settings — your call)

- A **tag ruleset** restricting who can create `v*` tags, since pushing a tag
  publishes to every DJ.
- Keep `main` protected so stable tags (which must point at `main`) only ever
  contain reviewed code.

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
   holds the DMG/ZIP per architecture, the Windows installer, the updater
   archives with `.sig` files, `latest.json` and `SHA256SUMS.txt`. Installed
   apps offer the update at their next launch or within about 4 hours.

**If the workflow fails,** nothing has been published: the release is created as
a draft and only made public in the last step. Fix the problem, then either use
**Re-run all jobs** (same commit) or, for a code fix, delete the tag
(`git push --delete origin v0.2.0 && git tag -d v0.2.0`), merge the fix and tag
again. The workflow replaces a leftover draft but refuses to touch a release
that is already published.

---

## Testing before you rely on it

- **Dry run:** Actions → Release → **Run workflow** on `main`. It builds, signs
  and verifies everything and uploads the files as workflow artifacts, but never
  publishes. This is the way to confirm the secrets work.
- **Pre-release:** bump to e.g. `0.2.0-rc.1`, add a `## [0.2.0-rc.1]` section,
  and push tag `v0.2.0-rc.1`. It publishes a GitHub pre-release you can download
  and install; installed apps ignore it. (Windows packaging of pre-release
  version numbers has not been tried.)
- **End-to-end updater test (not done yet — required before trusting it):**
  1. Publish a first updater-capable release (e.g. `0.2.0`) and install its DMG on
     a Mac; pair it and grant permissions.
  2. Publish `0.2.1`.
  3. Open `0.2.0`: within ~10 s the alert shows 0.2.1 and its notes.
  4. **Remind Me Later**, quit and reopen: no alert. Settings → Diagnostics →
     **Check for updates**: the alert is back.
  5. **Update Now**: progress, then the app restarts as 0.2.1 — check Settings
     shows 0.2.1, pairing survived, and djay/rekordbox/Music detection still
     works without re-granting permissions.
  6. Repeat on an Intel Mac and on Windows if you support them.

The automated checks cover the logic (Rust and Vitest suites) and CI verifies
every signature against the app's public key, but only this manual test proves
the real download → install → restart path on a real machine.

---

## What the release workflow checks before publishing

- The tag equals the version in all version files, and a stable tag points at a
  commit on `main`.
- `CHANGELOG.md` has a section for the version.
- All required secrets exist (names only; values are never printed).
- Typecheck, frontend tests, production frontend build, Rust tests.
- macOS, per architecture: the binary's CPU architecture matches the target,
  `CFBundleShortVersionString` equals the release version (otherwise the app
  would re-offer the same update forever), the signature is valid and comes
  from "Decks Bridge Beta Signing" (never ad-hoc or a new identity), and the app
  extracted back out of the updater archive passes the same checks.
- Every updater archive's signature verifies against `plugins.updater.pubkey`,
  once in the build job and again when `latest.json` is generated — so a
  release installed apps could not accept is never published.
- Signing secrets are exposed only to the steps that use them; the build steps
  (which run npm scripts) never see them.

---

## Limitations of the current signing setup

Signing is unchanged: macOS builds use the self-signed "Decks Bridge Beta
Signing" identity (not Apple Developer ID, not notarized); Windows builds are
Authenticode-signed only if `WINDOWS_SIGNING_CERT` is set.

1. **First install still hits Gatekeeper.** A DMG downloaded in a browser is
   quarantined, and macOS rejects the self-signed app ("damaged" / "can't be
   opened"). Testers follow `TEST_INSTALL.md` (the `xattr` command, or System
   Settings → Privacy & Security → Open Anyway). Only Developer ID signing plus
   notarization (paid Apple Developer Program) removes this.
2. **In-app updates should not hit Gatekeeper.** The app downloads the update
   itself, so the new bundle is not quarantined. Expected, but not yet verified
   on a real Mac — confirm in the end-to-end test.
3. **Permissions survive only with the same identity.** See setup step 2. If the
   identity ever changes (new Mac, deleted keychain), DJs re-grant
   Accessibility/Automation once after that update.
4. **Replacing the app may prompt.** If the DJ's account cannot write to
   `/Applications`, macOS asks for an administrator password. On macOS 13+,
   the "App Management" privacy setting may also ask to allow Decks Bridge to
   update apps, because a self-signed app has no Apple Team ID. Unverified —
   check during the end-to-end test.
5. **Windows:** without `WINDOWS_SIGNING_CERT` the installer is unsigned
   (SmartScreen on first install). Updates run the per-machine NSIS installer in
   passive mode, which needs a UAC prompt. The Windows update path is untested.
6. **Intel Macs:** x64 builds are produced as before but have not been tested on
   Intel hardware.
7. **Mini/Pill:** the alert lives in the main window. A DJ using only Mini or
   Pill sees it when they return to the main window.
8. **Repository visibility:** the app downloads updates from this repository's
   GitHub Releases, which works because the repository is public (its GitHub
   description says "Private"). If you make it private, installed apps can no
   longer fetch updates: first ship an update whose endpoint points at a public
   releases repository, then change visibility.
9. **Builds already installed (0.1.0) cannot auto-update.** They poll the old
   endpoint (`raw.githubusercontent.com/Mananssehh/decks-bridge-releases/main/update-manifest.json`,
   a repository that does not exist). Testers install the first updater-capable
   release manually once; later releases then arrive in-app.
10. **No downgrades / rollback.** Installed apps never move to an older version.
    To stop a bad release spreading, delete it or mark it as a pre-release (the
    endpoint then serves the previous release); fix forward with a higher
    version.

---

## Release layout (local builds)

```
release/
├── upload/                       # release-macos.sh output (same files CI publishes)
├── mac/                          # Latest macOS beta/production copies
│   ├── Decks Bridge.dmg
│   └── Decks Bridge.zip
├── windows/                      # Latest Windows copies (built on Windows)
│   ├── Decks Bridge Setup.exe
│   ├── Decks Bridge Portable.exe
│   ├── Decks Bridge.zip
│   └── Decks Bridge Setup.nsis.zip
├── v{version}/mac/               # Versioned macOS artifacts
├── v{version}/windows/           # Versioned Windows artifacts
└── SHA256SUMS.txt                # Checksums (scripts/hash-release.sh)
```

To reproduce the CI macOS release locally (on the Mac with the beta identity):

```bash
bash scripts/release-macos.sh build aarch64-apple-darwin
bash scripts/release-macos.sh package aarch64-apple-darwin
bash scripts/release-macos.sh sign-updater aarch64-apple-darwin   # uses .env.signing or ~/.tauri/decks-bridge.key
```

---

## Feature parity

| Feature | macOS | Windows |
|---------|-------|---------|
| Pairing (6-digit code) | ✅ | ✅ |
| Deep link (`decksbridge://`) | ✅ | ✅ (registered by NSIS installer) |
| Supabase bridge-pair | ✅ | ✅ |
| now-playing-ingest | ✅ | ✅ |
| Auto Now Playing detection | MediaRemote + AppleScript | SMTC (System Media Transport Controls) |
| Manual track entry | ✅ | ✅ |
| Reconnect / heartbeat | ✅ | ✅ |
| Background operation | Dock | System tray |
| Minimize to tray | — | ✅ (close hides to tray) |
| Start with OS (optional) | ✅ (autostart plugin) | ✅ (autostart plugin) |
| In-app updater | ✅ (see Limitations) | ✅ (untested) |
| File logging | `~/Library/Logs/Decks Bridge/` | `%LOCALAPPDATA%\Decks Bridge\Logs\` |
| Sentry (optional) | Set `SENTRY_DSN` | Set `SENTRY_DSN` |

Update checks and installs are logged under the `update` category in the log
files above.

### Platform differences

- **macOS detection** uses MediaRemote, Apple Music AppleScript, and djay accessibility fallbacks.
- **Windows detection** uses SMTC only — no djay-specific AX scraping.
- **macOS beta** builds are signed with the self-signed beta identity; testers bypass Gatekeeper (see `TEST_INSTALL.md`).
- **Windows beta** builds are unsigned; testers bypass SmartScreen (see `TEST_INSTALL_WINDOWS.md`).
- **Windows** requires **WebView2** (pre-installed on most Windows 10/11; NSIS installer bootstraps if missing).
- **Portable Windows exe** does not register `decksbridge://` — use the NSIS installer for deep links.

---

## macOS builds (local)

### Internal beta (self-signed, private DJ testing)

```bash
cd "/Users/manansseh/Desktop/Decks Bridge"
npm run build:internal
```

Output: `release/mac/Decks Bridge.dmg`, `.zip`, `.app`

Send **`TEST_INSTALL.md`** with the DMG.

### Production (Developer ID + notarization — not set up yet)

```bash
cp .env.signing.example .env.signing
# Fill Apple + minisign credentials
npm run build:release
```

Output: `release/v{version}/mac/` + copies in `release/mac/`. Requires an Apple
Developer ID certificate and notarization credentials. The tag workflow does
not use this path; it publishes the self-signed builds described above.

---

## Windows builds (local)

Run on **Windows 10/11 x64** (local machine or CI).

### Internal beta

```powershell
cd "C:\path\to\Decks Bridge"
npm run build:internal:windows
```

Output: `release/windows/Decks Bridge Setup.exe`, `Decks Bridge Portable.exe`, `Decks Bridge.zip`

Send **`TEST_INSTALL_WINDOWS.md`** with the installer.

### Production

```powershell
# Optional: set WINDOWS_SIGNING_CERT + WINDOWS_SIGNING_CERT_PASSWORD for Authenticode
npm run build:release:windows
```

Generates a signed updater archive when `TAURI_SIGNING_PRIVATE_KEY` is set.

---

## Release checklist

- [ ] One-time secrets configured (see above); a dry run (**Run workflow**) passes
- [ ] `npm run release:version -- X.Y.Z` committed
- [ ] `CHANGELOG.md` has `## [X.Y.Z] - date` with DJ-facing notes
- [ ] Pairing + ingest tested on macOS (and Windows if shipping it)
- [ ] Merged to `main`; tag `vX.Y.Z` pushed from `main`
- [ ] Release workflow green; GitHub Release has `latest.json`
- [ ] An older installed build shows the update alert and updates cleanly
- [ ] `TEST_INSTALL.md` / `TEST_INSTALL_WINDOWS.md` sent to new testers (first install only)

---

## Security notes

Release scripts verify:

- No `.git` in app bundles
- No AppleDouble `._*` files (macOS packaging)
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
