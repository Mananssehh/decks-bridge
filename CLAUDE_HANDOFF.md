# Decks Bridge — Claude Handoff

> **Written for a brand-new chat.** Everything needed to continue is here. Read it fully,
> inspect the code on disk, then continue from **§10 Exact next steps**.
> Last updated: 2026-07-17.

---

## 0. READ FIRST — the traps that cost days

**1) NEVER launch Bridge by bundle ID during development.**
`/Applications/Decks Bridge.app` (**STALE — built Jul 7, still present**) and the dev/release
builds **all share `com.decks.bridge`**. So `open -b com.decks.bridge`, `open -a "Decks Bridge"`,
and the computer-use `open_application` tool all resolve via **LaunchServices → the stale installed
app**. This manufactured four phantom bugs (missing launcher, missing DEV button, "openViewer is
broken", "Polling every 5s"). Hours were lost chasing them. **Always launch by explicit path:**

```bash
open -n ~/.decks-bridge-target/release/bundle/macos/Decks\ Bridge.app
```

*Tell-tale:* the real build says **"Detecting every 3s"**; the stale one says "Polling every 5s".
Verify: `ps -Ao pid,args | grep decks-bridge` → path **must** contain `.decks-bridge-target`.

**2) The repo lives on the iCloud-synced Desktop** (550 dataless files in `node_modules` right now).
Vite's file watcher **never fires** → HMR silently serves **stale modules**; cargo hits
`os error 60`. **Every change needs a full restart/rebuild — HMR cannot be trusted.**
Rust must build to a non-iCloud target:

```bash
export CARGO_TARGET_DIR="$HOME/.decks-bridge-target"
```

**3) The project folder keeps moving.** It has lived at 3+ paths. **Current source of truth:**
`/Users/manansseh/Desktop/Decks Bridge`
If it's not there: `mdfind -name "CLAUDE_HANDOFF.md"` or `mdfind "kMDItemFSName == 'tauri.conf.json'"`.
Verify a candidate is current by checking `src/lib/windows.ts` contains `applyConsoleWindow`.

---

## 1. Project overview

**Decks Bridge** is a macOS desktop companion for DJs. It detects the currently-playing track from
DJ software and pushes it to a paired **Decks** event's Now Playing, and displays that event's live
queue / trending / tips as a **Live Event Console**.

- **Stack:** Tauri v2 (Rust) + React + TypeScript + Vite. `@tauri-apps/api` **2.11.0**, cargo 1.95.
  No CSS framework — hand-rolled CSS with shared tokens.
- **Connects to Decks** two ways:
  1. **Write:** `now-playing-ingest` Edge Function (existing, **protected**) — sends detected track.
  2. **Read:** `bridge-event-snapshot` Edge Function — pulls event/queue/trending/tips (§3).
- **Supported DJ software (confirmed):** djay Pro (macOS Accessibility), Serato DJ Pro (local
  SQLite play history — *not* macOS Now Playing), rekordbox (macOS Accessibility). Plus Apple Music
  / Spotify (AppleScript). **Not supported:** Serato DJ Lite (no play history) → Manual Mode.
- **Bundle ID:** `com.decks.bridge` · **Signing:** `Decks Bridge Beta Signing` (self-signed,
  **not notarized**). `tauri.conf.json` has `signingIdentity: null`; signing is done by
  `scripts/sign-macos-beta.sh`.
- **Version:** `0.1.0` · **Apple Silicon only (arm64)**, macOS 11+.
- **Project path:** `/Users/manansseh/Desktop/Decks Bridge`
- **Dev build output:** `~/.decks-bridge-target/release/bundle/macos/Decks Bridge.app`

---

## 2. Completed & verified

### Detection / sync engine (PROTECTED — do not modify)
- **Local detection**: djay Pro, Serato DJ Pro, rekordbox, Apple Music, Spotify, Auto, Manual.
- **`src/lib/syncEngine.ts`**: `POLL_MS=3000` (detect), `HEARTBEAT_MS=30000`, `STALE_MS=15000`.
  Single loop, `inFlight` guard, `lastAppliedSeq` sequence protection (late results discarded),
  retry-on-failed-send, reconnect resend. **Sim: 14/14 passing.**
- **Root cause of the old "stuck on previous song" bug** (FIXED): a one-cycle confirmation gate
  required two identical consecutive reads before sending. Noisy detectors never accumulated two in
  a row → new tracks silently skipped. Removed — now sends **immediately on change**.
- **`useBridgeConnection`**: exponential reconnect backoff `1,2,5,10,30s` + `onReconnect` resend.
- **Pairing**: 6-digit code → `{url, token, eventId, eventName}` in `localStorage`.

### Live Event Console (Recommendation A — IMPLEMENTED & verified with real data)
```
Unpaired → compact pairing screen (480×680)
  → DJ enters 6-digit code
  → SAME window becomes the Live Event Console (1024×720, centered)
  → all Bridge controls live behind the ⚙ gear (Settings)
  → Mini & Pill remain floating windows; opening one HIDES the main console
```
- **No "Open Live Console" step after pairing — the Console IS the main app.**
- Console shows: event name + LIVE chip + venue/DJ, Now Playing (+artwork, waveform),
  Guests/Tips/Queue, Trending, Live Queue, Recent Tips, Bridge Status, ● Synced pill,
  Console/Mini/Pill switcher, ⟳ Sync Now, ⚙ Settings.
- **Local-first Now Playing**: the locally-detected track is overlaid onto the cloud snapshot so it
  appears immediately instead of lagging a poll cycle (`consoleSnapshot` in `NowPlaying.tsx`).
- **Settings** (⚙): source segmented selector, ON/OFF badge, detection status, last checked/sent,
  friendly source guidance, Sync Now, Test detection, Manual Entry (title/artist/artwork →
  "Update Now Playing"), Diagnostics, Updates, Sign out. Opening/closing Settings does **not**
  restart detection/polling/pairing (same component, `view` state only).
- **Window sizing**: `applyConsoleWindow()` / `applyPairingWindow()` — default 1024×720 centered on
  first paired launch, min 900×620, remembers size/position, **clamps off-screen restores**.

### Single-viewer lifecycle (FIXED + natively verified)
- **Root cause:** `WebviewWindow.getByLabel()` is `(await getAllWebviewWindows()).find(...)`, but
  the capability **never granted window enumeration** → every lookup returned `null` →
  `closeOthers()` closed **nothing** → windows piled up. Hidden by a `try/catch { return null }`
  that swallowed the permission error.
- **Fix:** granted `core:webview:allow-get-all-webviews` + `core:window:allow-get-all-windows`;
  `aliveViewers()` now **throws loudly** instead of swallowing; lifecycle moved to the **main
  window** (viewers only `requestSwitch` — a window cannot close itself then create its replacement,
  its JS context dies mid-switch).
- **Verified:** 11 cycles / 33 transitions, 1468 samples @0.5s → **max WebContent = 2**, zero
  dual-viewer samples, `wc=1` moments prove **close→confirm→create** ordering.
- **Architecture decision (from measurements, not theory): KEEP separate windows.**

---

## 3. Backend contract

**Endpoint (read):**
```
POST https://rwdgnapajxcxktmewlxb.functions.supabase.co/functions/v1/bridge-event-snapshot
```
Override with `VITE_SNAPSHOT_URL`. Fallback derives from `config.url`'s project ref.

- **Auth:** `Authorization: Bearer <existing paired ingest token>` — header only, **never logged**.
- **Verified:** invalid token → `401 {"error":"Invalid pairing token"}`; missing header → `401`.
- **Response → `BridgeSnapshot`** (`src/lib/bridge/types.ts`): `eventName, venue, djName,
  eventStatus, roomCode, nowPlaying{title,artist,albumArt,source,startedAt},
  queue[]{title,artist,status,votes,requestCount,tipTotal,createdAt},
  trending[]{rank,title,artist,votes,tipTotal,queuePosition},
  tips[]{amount,currency,displayName,songTitle,paymentStatus,createdAt}, tipTotals, guestsOnline,
  eventDurationSeconds, bridgeLastSeen, bridgeLastSync, bridgeSourceType`.
  Mapping is defensive (nullable/unknown tolerant); **amounts arrive in cents → converted to dollars**.
- **Polling** (`useBridgeSnapshot.ts`, **separate from the 3s detector**): **4s** visible/non-pill,
  **15s** hidden/minimised/pill, **paused offline**. Immediate refresh on mount / reconnect /
  foreground. Monotonic sequence IDs discard stale responses.
- **Error backoff:** `4 → 8 → 15 → 30s`, reset to normal cadence on success.
- **Trending:** **server-ordered — rendered verbatim, no client re-sort.** The formula lives in the
  backend (intended inputs: upvotes, vote velocity, duplicate request count, tip/boost amount,
  recency). Bridge does **not** compute it and does **not** query tables directly.
- **Security:** Bridge holds **no** Supabase anon/service-role key, **no** Stripe or webhook
  secrets. It only uses the paired ingest token. All DB access + RLS stay server-side.
- **Contract doc:** `docs/bridge-event-snapshot-contract.md`.

---

## 4. Files changed / created

**Core data layer**
- `src/lib/bridge/types.ts` — `BridgeSnapshot` model (no secrets/PII/full payment IDs by design).
- `src/lib/bridge/provider.ts` — `BridgeDataProvider` seam.
- `src/lib/bridge/MockBridgeProvider.ts` — dev-only; **tree-shaken out of production**.
- `src/lib/bridge/LiveBridgeProvider.ts` — real endpoint, Bearer auth, defensive mapping.
- `src/lib/bridge/env.ts` / `factory.ts` — `import.meta.env.DEV && shouldUseMock()`; prod never mocks.
- `src/hooks/useBridgeSnapshot.ts` — snapshot polling loop (4s/15s, backoff, seq guard).
- `scripts/check-no-mock.mjs` — build guard: fails any prod build with mock enabled.
- `.env.development` — `VITE_MOCK_DATA=false` (dev uses the **live** provider).

**Windows / lifecycle**
- `src/lib/windows.ts` — viewer lifecycle: `performSwitch` (expanded = **main window**; mini/pill =
  floating + hide main), `aliveViewers` (**throws loudly**), `assertSingleViewerWindow`,
  `closeViewerAndWait`, `requestSwitch`/`initViewerHost`, string-keyed geometry store,
  `applyConsoleWindow()` / `applyPairingWindow()` (sizing + off-screen clamp).
- `src-tauri/capabilities/default.json` — window/webview permissions (see §5).
- `src-tauri/tauri.conf.json` — main window now `resizable: true`, `minWidth 420`, `minHeight 560`.

**UI**
- `src/components/NowPlaying.tsx` — **main window root**: owns the detection engine + connection,
  renders **Console** (`ExpandedDashboard`) or **Settings**. Local-first overlay lives here.
- `src/components/viewer/ExpandedDashboard.tsx` — the Console (+ `onOpenSettings` ⚙).
- `src/components/viewer/{MiniPlayer,FloatingPill,ViewerRoot,ViewerFallback,useHighValueTip,format}`
- `src/components/viewer/ConsoleLauncher.tsx` — now an **inline** button (was a floating overlay).
- `src/styles/tokens.css` — **single source of truth** for design tokens.
- `src/components/bridge.css` — main-window styling (mirrors the Console).
- `src/components/viewer/viewer.css` — Console/Mini/Pill; `--vw-*` now **alias** the shared tokens.
- `src/App.tsx` — routing + `initViewerHost()` + window sizing on paired/unpaired transition.
- `src/main.tsx` — imports `tokens.css` before `index.css`; hash routing → `ViewerRoot`.

**Tooling**
- `scripts/verify-viewer-lifecycle.sh` — `--launch` / `--watch`; verifies executable path,
  capabilities, WebContent count, windows, CPU/RAM. **Resumable after a session teardown.**

**Deliberate token decision:** tokens are **additive** (`--glass`, `--hairline`, `--radius-md`).
Legacy names (`--surface`, `--border`, `--radius`, `--text-muted`) are **NOT** overridden because
`PairingScreen`, `SetupScreen`, `DiagnosticsPanel` still consume them — retheming globally would
silently restyle unreviewed screens. Migrate those three deliberately, one at a time.

---

## 5. Known development traps

- **Bundle-ID launch trap**, **iCloud watcher/build trap**, **moving project folder** → see **§0**.
- **Dev target:** `~/.decks-bridge-target` (release bundle at
  `~/.decks-bridge-target/release/bundle/macos/Decks Bridge.app`).
- **Required Tauri capabilities** (all now granted in `src-tauri/capabilities/default.json`):
  `core:webview:allow-create-webview-window`, **`core:webview:allow-get-all-webviews`**,
  **`core:window:allow-get-all-windows`**, `allow-show/hide/close/center/set-focus`,
  `allow-set-always-on-top`, `allow-start-dragging`, `allow-set-position/size`,
  **`allow-set-min-size`, `allow-set-resizable`, `allow-outer-position`, `allow-outer-size`,
  `allow-scale-factor`, `allow-current-monitor`, `allow-available-monitors`**.
  ⚠️ Missing enumeration perms caused the single-viewer bug; missing
  `outer-position`/`outer-size`/`scale-factor` silently broke geometry persistence.
  **If a window op mysteriously no-ops, suspect a missing capability first — and never swallow the error.**
- **Correct viewer lifecycle order:** persist geometry → **close** old → **await confirmation it's
  gone** → verify none remain → **create** target → focus → assert exactly one.
  **Never create-then-close.** If the old window won't close: **abort, do not create**.
- **Protected / do not modify:** `syncEngine.ts`, `useNowPlayingSync.ts`, `useBridgeConnection.ts`,
  `playback.ts`, `offlineQueue.ts`, `api.ts`, `src-tauri/src/main.rs` (detectors), pairing,
  heartbeat, reconnect, `now-playing-ingest`. Also: Stripe, the Decks web app, backend functions.
- **Protected installers:** see **§9** — do not overwrite.

---

## 6. Verified tests

| Test | Result |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm run build` (frontend) | ✅ pass; mock guard clean; mock absent from `dist` |
| `npm run tauri build` (native) | ✅ pass (ad-hoc bundle) |
| Real endpoint auth | ✅ invalid token → 401; no header → 401 |
| Real event data | ✅ KWAKU/LIVE/W5/DJ Captain; "Dance Groove"/Dj Yk Beats + artwork; Trending ×5 (S.P.Y `$1 tipped · #5`); Queue ×5; Tips $1; ● Synced; **no MOCK badge** |
| Window cycle | ✅ 11 cycles / 33 transitions |
| WebContent count | ✅ **max 2** (main + one viewer); 0 dual-viewer samples |
| CPU/RAM (**Expanded only**) | main **3.4% / 27MB**; viewer **7.1% / 33MB**; total **~142MB** |
| Sync-engine sim | ✅ **14/14** |
| Pairing → Console | ✅ main window becomes Console at 1024×720 |
| Settings navigation | ✅ ⚙ opens/closes without restarting detection/polling |
| Manual Mode UI | ✅ shows Title/Artist/Artwork + "Update Now Playing"; hides auto rows |
| Automatic-source guidance | ✅ e.g. *"rekordbox is set as your Now Playing source, but no track is playing there yet… also needs Accessibility permission."* |
| Mini / Pill | ✅ render real data; opening one hides the main Console |
| Secret scan (`src`/`dist`/`.app`) | ✅ clean; token log = `"(present, redacted)"` |
| Race guards | ✅ `inFlight` + `lastAppliedSeq` + snapshot seq refs |

### ❌ STILL UNVERIFIED — do not claim these
- **Mini/Pill per-mode CPU/RAM** (only Expanded measured) · **long-session soak**
- **Always-on-top** · **drag** · **focus-vs-rekordbox** · **audio stutter**
- **Local-first A→B→C→A with a real rekordbox track** (engine sim only)
- **Offline → "Local only — reconnecting" → reconnect refresh** (live)
- **Pairing-expired UI** state (endpoint 401 verified; UI not driven)
- **Relaunch persistence** of console size/position (code added, not exercised)
- **Manual-mode submit** end-to-end (UI verified; send path not driven)
- Accessibility pass; keyboard shortcuts; Windows/nsis

---

## 7. Audit findings — Launch Readiness **69/100**
Security 78 · Performance 80 · Reliability 58 · UX 70 · Maintainability 65 · Production 55

**🔴 CRITICAL**
1. **Updater endpoint 404.** `plugins.updater.endpoints` →
   `https://raw.githubusercontent.com/Mananssehh/decks-bridge-releases/main/update-manifest.json`
   returns **404**, and `dialog:false` makes failures **silent**. ⇒ **No way to ship a fix to a DJ
   mid-set.** *Biggest launch risk.* (2–4h)

**🟠 HIGH**
2. **Pairing token stored plaintext** in `localStorage` (`saveConfig`) → move to **Keychain**;
   keep url/eventId in localStorage. (0.5–1d)
3. **`loadViewerMode()` has 0 call sites** → last viewer mode never restored. (15m)
4. **Always-on-top toggle unimplemented** — `applyAlwaysOnTop()`/`setAlwaysOnTopPref()` have
   0 call sites (pref only read at window creation). (1h)
5. **Swallowed exceptions (~27 sites; `windows.ts` had 12)** — *this pattern caused the
   single-viewer bug AND broke geometry persistence.* Never swallow capability/IPC errors on
   correctness paths. (2–3h)
6. **Dev/prod share `com.decks.bridge`** → add dev identity `com.decks.bridge.dev` /
   "Decks Bridge Dev". ⚠️ *Different bundle ID = different data dir → dev starts unpaired and needs
   its own Accessibility grant.* (1h)
7. Finish native reliability tests (§6 unverified list). (2–3h)

**🟡 MEDIUM**
8. **Idle CPU ~7%** from the always-animating waveform — app is meant to run all night beside
   rekordbox. Pause when unfocused (`visibilitychange` does **not** fire for unfocused-but-visible
   always-on-top windows — use focus events); `prefers-reduced-motion` already honored. (2h)
9. **Not notarized** (self-signed) → Gatekeeper friction / "damaged" reports. (0.5d + Apple acct)
10. **Repo on iCloud Desktop** → stale-build risk. (15m to move)

**🟢 LOW**
11. **Unused dependency:** `@tauri-apps/plugin-updater` (0 frontend imports; updater runs via Rust).
12. **Duplicated relative-time logic:** `ago()` in `NowPlaying.tsx` vs `viewer/format.ts`.
13. **Dead code:** `closeAllViewers`, `applyAlwaysOnTop`, `loadViewerMode` (latter two are
    *symptoms* of #3/#4).
14. Legacy screens still on old tokens: `PairingScreen`, `SetupScreen`, `DiagnosticsPanel`.
15. `version` still `0.1.0`; `bundle.targets` includes `nsis` (Windows, untested).

**Verified clean:** no `sk_live`/`sk_test`/`whsec_`/`service_role`/private-key patterns; no
TODOs/FIXMEs; intervals cleaned; race guards present.

---

## 8. Auto-update plan (desired behavior)

- DJs **manually install one updater-enabled version**; all future versions update **inside Bridge**.
- Use the **official Tauri v2 updater** (already configured; **public** key in `tauri.conf.json`).
- **Signed updater artifacts** — every release signed with the updater private key.
- **Endpoint / `latest.json`**: publish manifest + assets to the release repo so the endpoint stops
  404-ing. Manifest must match: `version`, platform key (`darwin-aarch64`), asset `url`, `signature`.
- **UI:** `UpdateChecker` supports **Update Now** and **Install After Event**
  (`installWhenIdle` + `isPerforming`) — **never interrupt a live set**.
- **Preserve pairing + settings** across updates (same bundle ID ⇒ same data dir).
- 🔐 **The updater private key must NEVER enter the repo.** Keep it in a password manager / CI
  secret. Only the **public** key belongs in `tauri.conf.json`.
- **Do not claim auto-update ready** until proven end-to-end: discovery → signed download →
  install → relaunch → state preserved → invalid signature rejected.

---

## 9. Protected production state

Installers live in: `/Users/manansseh/Desktop/untitled folder 2/`
⚠️ **note:** the *project* moved to `~/Desktop/Decks Bridge`, but the **installers did not** —
they remain in `untitled folder 2`.

| Item | Status |
|---|---|
| `Decks Bridge Mac Installer/` | protected (original) — its outer `.zip` went missing earlier; folder intact, checksums verified |
| `Decks Bridge Mac Installer - New Icon/` + `.zip` | protected — flat-emblem icon |
| **`Decks Bridge Mac Installer - Squircle Icon/` + `.zip`** | **CURRENT FINAL — do not overwrite** |
| `Decks Bridge Mac Installer - FINAL SQUIRCLE BACKUP.zip` | backup — `db90dbc43079a2aafe4cbb4e5ad7b42da34f4b9323785145ba97072c11c13f32` |
| `Decks Bridge Mac Installer - Squircle Icon-1` | stray Finder duplicate |

Squircle checksums: DMG `5bd250ae0810b77138d43b67b57626560e05fd735f6f884ceea211f100acda1f` ·
ZIP `d7048eebe72cdc6f408b66fae4361f2d5eeeb255c60f502cc8f39c3ddb6e428e` · outer `db90dbc4…`
Bundle `com.decks.bridge` · Signing `Decks Bridge Beta Signing` · Notarized **No** · arm64 only.

> ⚠️ **The `uchg` lock is GONE.** Re-checked 2026-07-17: the backup `.zip` reports flags
> `[compressed,dataless]` and the SHA256 sidecar `[-]` — **no `uchg` on either**. They were moved
> and iCloud-evicted, so they are **no longer write-protected**. Re-lock with
> `chflags uchg "<path>"`. Also, the SHA256 sidecar still references the **old** `~/Desktop/...`
> path, so `shasum -c` fails on path until regenerated.

**Do not rebuild or overwrite any installer** until the punch list is closed.

---

## 10. Exact next steps

### Must fix before **controlled invite beta** (5–10 DJs)
1. 🔴 **Updater 404** — publish `latest.json` + signed assets; prove the full update path (§8).
2. 🟠 **Keychain for the pairing token** (stop plaintext `localStorage`).
3. 🟠 **Wire `loadViewerMode()`** — restore last viewer mode (15m).
4. 🟠 **Implement the always-on-top toggle** + verify Mini/Pill float over rekordbox (1h).
5. 🟠 **Finish native verification** (§6 unverified): Mini/Pill CPU/RAM, always-on-top, drag,
   focus-vs-rekordbox, local-first A→B→C with rekordbox, offline→reconnect, pairing-expired UI,
   relaunch persistence. Use `scripts/verify-viewer-lifecycle.sh --launch`.
6. 🟠 **Re-lock the FINAL SQUIRCLE BACKUP** (`chflags uchg`) + regenerate its SHA256 sidecar path.

### Must fix before **public beta**
7. **Notarization** (Developer ID). 8. **De-swallow invariant-critical catches** (~27 sites).
9. **Dev identity** `com.decks.bridge.dev` + **move repo off iCloud**.
10. **Waveform idle CPU** (~7%) — pause when unfocused. 11. Version bump off `0.1.0`.

### Can wait until after launch
12. Accessibility pass + keyboard shortcuts. 13. Long-session soak.
14. Dead code (`closeAllViewers`, unused `@tauri-apps/plugin-updater`, duplicated `ago()`).
15. Migrate `PairingScreen` / `SetupScreen` / `DiagnosticsPanel` onto shared tokens
    (**one at a time, visually reviewed** — do not globally override legacy vars).
16. Windows/nsis validation.

### ⚠️ Highest-risk fact about this codebase
**There is NO version control.** This project is **not a git repo** — no history, no diff, no
rollback. Every change exists only as files on disk, in a folder that has already moved 3+ times
and is subject to iCloud eviction. **Strongly recommend `git init` + an initial commit before any
further work.**

---

## 11. Exact continuation prompt

```
Read `CLAUDE_HANDOFF.md`, inspect the current code on disk, verify the current project state,
and continue from the documented next step. Do not redo completed work. Do not modify protected
installers or working detection logic unless the handoff explicitly requires it.
```
