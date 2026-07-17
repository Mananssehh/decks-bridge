# Decks Bridge — Private Testing Install (macOS)

**For DJ testing only.** This build is signed with a self-signed beta identity (not Apple notarized). Do not publish this DMG on the public Decks website.

---

## Download

Get one of these from this folder:

- **`Decks Bridge.dmg`** (recommended)
- **`Decks Bridge.zip`**

Requires **Apple Silicon Mac** (M1/M2/M3/M4).

---

## Install from DMG (recommended)

1. **Download** the DMG file.
2. **Double-click** the DMG to open it.
3. **Drag** `Decks Bridge` to the **Applications** folder shortcut.
4. **Open** Decks Bridge from Applications (or Spotlight).

### If macOS blocks the app

macOS may show “Decks Bridge cannot be opened” or “unidentified developer” for private test builds. Try in order:

**A. Right-click open (easiest)**

1. Open **Applications**.
2. **Right-click** `Decks Bridge` → **Open**.
3. Click **Open** in the dialog.

**B. If macOS says the app is “damaged”**

This usually means Gatekeeper quarantine, not a broken file. In **Terminal**, run:

```bash
xattr -dr com.apple.quarantine "/Applications/Decks Bridge.app"
```

Then open the app normally from Applications.

---

## Install from ZIP

1. Download and **double-click** the ZIP to extract.
2. Drag `Decks Bridge.app` to **Applications**.
3. Follow the same “If macOS blocks the app” steps above if needed.

---

## Pair with Decks

1. Open Decks Bridge.
2. In your Decks event dashboard, generate a pairing code.
3. Enter the 6-digit code in Decks Bridge (or use the `decksbridge://` link if prompted).

---

## Questions?

Contact the person who sent you this build. This is a **private test version**, not the final public release.
