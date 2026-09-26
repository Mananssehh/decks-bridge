# Decks Bridge — Public Release (091)

This folder receives **production-ready** artifacts after a successful notarized build.

## Current status: NOT READY

This machine has **no Developer ID Application certificate** installed. A notarized build cannot be produced until you complete setup in `RELEASE.md`.

## To populate this folder

1. Copy `.env.signing.example` → `.env.signing` and fill in Apple Developer credentials
2. Install **Developer ID Application** certificate in Keychain
3. Run:

```bash
cd "/Users/manansseh/Desktop/Decks Bridge"
npm run build:release
```

On success, this folder will contain (for the architecture just built —
`aarch64` for Apple Silicon, `x64` for Intel):

- `Decks.Bridge_<version>_<arch>.dmg` — customer download (itself signed, notarized and stapled)
- `Decks.Bridge_<version>_<arch>.app.zip` — alternate download
- `Decks Bridge.app` — signed + notarized app bundle
- `Decks.Bridge_<version>_<arch>.app.tar.gz` + `.sig` — in-app updater

All artifacts pass `spctl` with **accepted / Notarized Developer ID**. Public
GitHub Releases are built by `.github/workflows/release.yml`, not from this folder
(see `RELEASE.md`).
