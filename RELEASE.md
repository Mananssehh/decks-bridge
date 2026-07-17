# Decks Bridge — Cross-Platform Release Guide

Direct download distribution for **macOS** and **Windows**. Not App Store / Microsoft Store.

Every tagged release (`v*`) builds both platforms via GitHub Actions and publishes GitHub Release assets.

---

## Release layout

```
release/
├── mac/                          # Latest macOS beta/production copies
│   ├── Decks Bridge.dmg
│   ├── Decks Bridge.zip
│   ├── Decks Bridge.app.tar.gz   # updater (production)
│   └── Decks Bridge.app.tar.gz.sig
├── windows/                      # Latest Windows copies (built on Windows)
│   ├── Decks Bridge Setup.exe
│   ├── Decks Bridge Portable.exe
│   ├── Decks Bridge.zip
│   ├── Decks Bridge Setup.nsis.zip
│   └── Decks Bridge Setup.nsis.zip.sig
├── v{version}/mac/               # Versioned macOS artifacts
├── v{version}/windows/           # Versioned Windows artifacts
└── SHA256SUMS.txt                # Checksums (scripts/hash-release.sh)
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
| In-app updater | ✅ | ✅ |
| File logging | `~/Library/Logs/Decks Bridge/` | `%LOCALAPPDATA%\Decks Bridge\Logs\` |
| Sentry (optional) | Set `SENTRY_DSN` | Set `SENTRY_DSN` |

### Platform differences

- **macOS detection** uses MediaRemote, Apple Music AppleScript, and djay accessibility fallbacks.
- **Windows detection** uses SMTC only — no djay-specific AX scraping.
- **macOS beta** builds are ad-hoc signed; testers bypass Gatekeeper (see `TEST_INSTALL.md`).
- **Windows beta** builds are unsigned; testers bypass SmartScreen (see `TEST_INSTALL_WINDOWS.md`).
- **Windows** requires **WebView2** (pre-installed on most Windows 10/11; NSIS installer bootstraps if missing).
- **Portable Windows exe** does not register `decksbridge://` — use the NSIS installer for deep links.

---

## macOS builds

### Internal beta (ad-hoc, private DJ testing)

```bash
cd "/Users/manansseh/Desktop/Decks Bridge"
npm run build:internal
```

Output: `release/mac/Decks Bridge.dmg`, `.zip`, `.app`

Send **`TEST_INSTALL.md`** with the DMG.

### Production (Developer ID + notarization)

```bash
cp .env.signing.example .env.signing
# Fill Apple + minisign credentials
npm run build:release
```

Output: `release/v{version}/mac/` + copies in `release/mac/`

---

## Windows builds

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

Generates signed updater archive when `TAURI_SIGNING_PRIVATE_KEY` is set.

---

## Auto updates

Updater manifest: separate repo `decks-bridge-releases` → `update-manifest.json`

| Platform | Updater artifact | Manifest key |
|----------|------------------|--------------|
| macOS arm64 | `Decks Bridge.app.tar.gz` + `.sig` | `darwin-aarch64` |
| macOS x64 | `Decks Bridge.app.tar.gz` + `.sig` | `darwin-x86_64` |
| Windows x64 | `Decks Bridge_*_x64-setup.nsis.zip` + `.sig` | `windows-x86_64` |

After each release, update the manifest URLs and minisign signatures from the build output.

Template: `update-manifest.json` in this repo.

---

## GitHub Actions

**Trigger:** `git tag vX.Y.Z && git push origin vX.Y.Z`

**Workflow:** `.github/workflows/release.yml`

1. Build frontend
2. **macOS** (matrix aarch64 + x64): sign → notarize → DMG/ZIP/updater tarballs → `release/mac/`
3. **Windows** (x64): NSIS + portable + updater zip → `release/windows/`
4. Generate `SHA256SUMS.txt`
5. Upload all assets to GitHub Release

### Required secrets (production)

| Secret | Platform |
|--------|----------|
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | macOS |
| `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` | macOS |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` **or** API key trio | macOS notarization |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater (both) |
| `WINDOWS_SIGNING_CERT`, `WINDOWS_SIGNING_CERT_PASSWORD` | Windows Authenticode (optional) |

Without Apple secrets, macOS job fails at signing. Without Windows cert, Windows builds still run unsigned.

---

## Versioning

1. Bump `version` in `src-tauri/tauri.conf.json` and `package.json`.
2. Tag: `git tag v0.2.0 && git push origin v0.2.0`
3. CI builds and publishes both platforms.
4. Update `decks-bridge-releases` manifest with new URLs + signatures.

### Rollback

Publish a new tag with the previous version's code, or update the updater manifest to point at the last known-good artifact URLs/signatures.

---

## Release checklist

- [ ] Version bumped in `tauri.conf.json` + `package.json`
- [ ] macOS internal/production build passes `codesign --verify --deep --strict`
- [ ] Windows build produces Setup + Portable + ZIP
- [ ] Pairing + ingest tested on macOS
- [ ] Pairing + ingest + SMTC tested on Windows
- [ ] Updater `.sig` files generated with minisign key
- [ ] `update-manifest.json` updated in releases repo
- [ ] `SHA256SUMS.txt` generated (`bash scripts/hash-release.sh`)
- [ ] `TEST_INSTALL.md` / `TEST_INSTALL_WINDOWS.md` attached for beta testers
- [ ] GitHub Release assets uploaded by CI

---

## Security notes

Release scripts verify:

- No `.git` in app bundles
- No AppleDouble `._*` files (macOS packaging)
- No embedded signing secrets (use `.env.signing`, gitignored)
- Config stored locally (localStorage / AppData), not in the binary

macOS compile-path strings (`/Users/.../.cargo/...`) may appear in panic messages — not runtime dependencies.

`localhost:1420` in the binary is Tauri dev metadata; release builds serve bundled assets via `tauri://localhost`.

---

## Crash reporting (Sentry)

Not enabled by default. To prepare for a future release:

1. Set `SENTRY_DSN` environment variable at launch.
2. Add the Sentry SDK in `src-tauri/src/sentry.rs` when ready.

The stub logs whether `SENTRY_DSN` is configured at startup.
