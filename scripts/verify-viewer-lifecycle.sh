#!/usr/bin/env bash
# ── Decks Bridge — viewer lifecycle / single-viewer verifier ──────────────────
#
# Resumable native check. Safe to run at any time; makes no changes.
#
#   ./scripts/verify-viewer-lifecycle.sh            # one snapshot
#   ./scripts/verify-viewer-lifecycle.sh --watch    # snapshot every 2s
#   ./scripts/verify-viewer-lifecycle.sh --launch   # launch correct build first
#
# WHY THIS EXISTS
#   1. `/Applications/Decks Bridge.app` and the dev/release builds share bundle id
#      `com.decks.bridge`. `open -b com.decks.bridge` (LaunchServices) opens the
#      STALE INSTALLED app. Always launch by EXPLICIT PATH. This script refuses to
#      pass if the process under test is the /Applications one.
#   2. The single-viewer invariant must hold: main window + AT MOST ONE viewer.
#      Expected WebKit WebContent processes = 2 (main + one viewer); 1 when no
#      viewer is open. >=3 means duplicate viewers => VIOLATION.

set -uo pipefail

TARGET_APP="${DECKS_BRIDGE_APP:-$HOME/.decks-bridge-target/release/bundle/macos/Decks Bridge.app}"
BIN="$TARGET_APP/Contents/MacOS/decks-bridge"
STALE="/Applications/Decks Bridge.app"

c_ok=$'\033[32m'; c_bad=$'\033[31m'; c_warn=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
ok()   { echo "  ${c_ok}PASS${c_off}  $*"; }
bad()  { echo "  ${c_bad}FAIL${c_off}  $*"; }
warn() { echo "  ${c_warn}WARN${c_off}  $*"; }

launch_correct() {
  pkill -f "$STALE/Contents/MacOS/decks-bridge" 2>/dev/null
  pkill -f "\.decks-bridge-target/.*/decks-bridge" 2>/dev/null
  sleep 2
  echo "Launching by EXPLICIT PATH (never LaunchServices/bundle id):"
  echo "  $TARGET_APP"
  open -n "$TARGET_APP"
  sleep 6
}

snapshot() {
  echo "════════════════════════════════════════════════════════════"
  echo " Decks Bridge — viewer lifecycle check   $(date '+%H:%M:%S')"
  echo "════════════════════════════════════════════════════════════"

  # ── 1. Which executable is under test? ────────────────────────────────────
  local pid path
  pid="$(pgrep -f "\.decks-bridge-target/.*/decks-bridge" 2>/dev/null | head -1)"
  local stale_pid
  stale_pid="$(pgrep -f "$STALE/Contents/MacOS/decks-bridge" 2>/dev/null | head -1)"

  if [ -n "$stale_pid" ]; then
    bad "STALE INSTALLED APP IS RUNNING (pid $stale_pid) — /Applications/Decks Bridge.app"
    bad "Kill it; test only the explicit-path build."
  fi
  if [ -z "$pid" ]; then
    bad "No dev/release Bridge process running. Use --launch."
    echo ""
    return 1
  fi

  path="$(ps -o args= -p "$pid" 2>/dev/null | awk '{print $1}')"
  echo "Executable under test:"
  echo "  pid   : $pid"
  echo "  path  : $path"
  case "$path" in
    "$STALE"*) bad "Testing the STALE INSTALLED app — ABORT." ; return 1 ;;
    *"/.decks-bridge-target/"*) ok "correct build (non-/Applications target path)" ;;
    *) warn "unrecognised path — verify manually" ;;
  esac
  echo "  bundle: $(defaults read "$TARGET_APP/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo '?')"
  echo "  built : $(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$BIN" 2>/dev/null || echo '?')"

  # ── 2. Capability check (single-viewer depends on window enumeration) ──────
  local cap="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/capabilities/default.json"
  for p in "core:webview:allow-get-all-webviews" "core:window:allow-get-all-windows"; do
    if grep -q "$p" "$cap" 2>/dev/null; then ok "capability granted: $p"
    else bad "capability MISSING: $p  (getByLabel() will return null → closeOthers closes nothing)"; fi
  done

  # ── 3. Single-viewer invariant via WebContent processes ───────────────────
  echo ""
  echo "WebKit processes:"
  ps -Ao pid,%cpu,rss,comm 2>/dev/null | grep -iE "WebKit\.(WebContent|GPU|Networking)" | grep -v grep \
    | awk '{printf "  %-7s cpu=%5s%%  rss=%5dMB  %s\n",$1,$2,$3/1024,($4 ~ /WebContent/ ? "WebContent" : ($4 ~ /GPU/ ? "GPU" : "Networking"))}'
  local wc
  wc="$(ps -Ao comm 2>/dev/null | grep -ic 'WebKit.WebContent')"
  echo ""
  echo "WebContent count = $wc"
  case "$wc" in
    0) warn "0 — app has no webview (not running?)" ;;
    1) ok  "1 = main window only (no viewer open)" ;;
    2) ok  "2 = main window + EXACTLY ONE viewer  → invariant holds" ;;
    *) bad "$wc = DUPLICATE VIEWERS → SINGLE-VIEWER VIOLATION" ;;
  esac

  # ── 4. Visible window titles (catches hidden/off-screen orphans) ──────────
  echo ""
  echo "Bridge windows (AppleScript):"
  osascript -e 'tell application "System Events" to tell process "Decks Bridge" to get name of every window' 2>/dev/null \
    | tr ',' '\n' | sed 's/^ */  - /' || echo "  (unavailable — grant Accessibility to the terminal, or app not focused)"

  # ── 5. Resource totals ────────────────────────────────────────────────────
  echo ""
  echo "Resources:"
  ps -o pid,%cpu,rss,comm -p "$pid" 2>/dev/null | tail -1 \
    | awk '{printf "  main process : cpu=%s%%  rss=%dMB\n",$2,$3/1024}'
  local total
  total="$(ps -Ao pid,rss,comm 2>/dev/null | grep -iE "decks-bridge|WebKit\.(WebContent|GPU|Networking)" | grep -v grep | awk '{s+=$2} END {printf "%d", s/1024}')"
  echo "  Bridge total : ~${total}MB (app + WebKit helpers)"
  echo ""
}

case "${1:-}" in
  --launch) launch_correct; snapshot ;;
  --watch)  while true; do clear; snapshot; sleep 2; done ;;
  *)        snapshot ;;
esac
