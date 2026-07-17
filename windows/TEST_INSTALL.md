# Windows private beta install guide

## Download

Get one of these from the person who sent you the build:

- **`Decks Bridge Setup.exe`** (recommended) — installs to Program Files
- **`Decks Bridge Portable.exe`** — no installer; runs from any folder
- **`Decks Bridge.zip`** — portable exe only

Requires **Windows 10 or 11 (64-bit)**.

---

## Install from Setup.exe (recommended)

1. Download **`Decks Bridge Setup.exe`**.
2. Double-click to run the installer.
3. Follow the prompts (installs to Program Files, Start Menu shortcut).
4. Launch **Decks Bridge** from the Start Menu.

### If SmartScreen blocks the app

Private beta builds may be **unsigned**. Windows may show:

> **Windows protected your PC** / **Unknown publisher**

Click **More info** → **Run anyway**.

This is expected for internal testing, not a broken installer.

---

## Portable install

1. Download **`Decks Bridge Portable.exe`** or extract **`Decks Bridge.zip`**.
2. Place the exe anywhere (Desktop, USB drive, etc.).
3. Double-click **`Decks Bridge Portable.exe`**.

Settings are stored in:

```
%LOCALAPPDATA%\Decks Bridge\
```

Logs:

```
%LOCALAPPDATA%\Decks Bridge\Logs\
```

---

## System tray

On Windows, closing the window **minimizes to the system tray** — Decks Bridge keeps running in the background.

- **Left-click** the tray icon to show the window again.
- **Right-click** the tray icon → **Quit Decks Bridge** to exit fully.

Optional: enable **Start Decks Bridge with Windows** in the debug panel (⚙).

---

## Pair with Decks

1. Open Decks Bridge.
2. In your Decks event dashboard, generate a pairing code.
3. Enter the 6-digit code in Decks Bridge.

---

## Now Playing

Decks Bridge reads **Windows System Media Transport Controls** from Spotify, Rekordbox, djay, browsers, and other apps that publish Now Playing metadata.

Play a track in your DJ app, then enable auto-detect in Decks Bridge.

---

## Questions?

Contact the person who sent you this build. This is a **private test version**, not the final public release.
