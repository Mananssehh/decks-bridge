# Decks Bridge — Mac beta (send this folder)

Notarized build for **Apple Silicon** (M1/M2/M3/M4) and **Intel** Macs.
`scripts/sync-tester-folders.sh` copies it here only after checking that it is
Developer ID signed, notarized and stapled.

## What's in this folder

| File | Use |
|------|-----|
| `Decks.Bridge_<version>_aarch64.dmg` | Apple Silicon Macs — recommended, drag to Applications |
| `Decks.Bridge_<version>_x64.dmg` | Intel Macs |
| `Decks.Bridge_<version>_<arch>.app.zip` | Alternative if the DMG doesn't work |
| **TEST_INSTALL.md** | Step-by-step install + Gatekeeper help |

## Quick start (testers)

1. Open the **.dmg** for your Mac (`aarch64` = Apple Silicon, `x64` = Intel)
2. Drag **Decks Bridge** to Applications
3. If macOS blocks it: **Right-click → Open → Open**
4. Pair with your Decks event using the 6-digit code

See **TEST_INSTALL.md** for full instructions.
