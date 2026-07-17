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

On success, this folder will contain:

- `Decks Bridge.dmg` — customer download
- `Decks Bridge.app.zip` — alternate download
- `Decks Bridge.app` — signed + notarized app bundle
- `Decks Bridge.app.tar.gz` + `.sig` — in-app updater

All artifacts pass `spctl -a -vvv` with **accepted / Notarized Developer ID**.
