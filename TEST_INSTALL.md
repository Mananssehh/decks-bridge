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

Private test builds aren’t notarized by Apple, so macOS blocks them the first time you open them. You may see “Decks Bridge” Not Opened, “Apple could not verify…” or “unidentified developer”. This is expected.

**A. Allow it in System Settings (macOS 15 Sequoia and newer)**

1. Double-click `Decks Bridge` in **Applications**. When the warning appears, click **Done** (not **Move to Trash**).
2. Open **System Settings** → **Privacy & Security**.
3. Scroll down to **Security** and click **Open Anyway** next to Decks Bridge. (No button? Do step 1 again. The button only shows for about an hour.)
4. Confirm: click **Open Anyway** again if asked, and enter your Mac password (or use Touch ID).

Decks Bridge opens, and after that it opens normally. Repeat this once for each new test build.

> **macOS 14 Sonoma or earlier?** The old shortcut still works there: **right-click** `Decks Bridge` in Applications → **Open** → **Open**. Apple removed it in macOS 15.

**B. If macOS says the app is “damaged”**

This usually means Gatekeeper quarantine, not a broken file. **Open Anyway** isn’t offered in this case. Don’t click **Move to Trash**. Instead, open **Terminal** (press ⌘-Space, type Terminal) and run:

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
