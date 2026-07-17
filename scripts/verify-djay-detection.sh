#!/usr/bin/env bash
# Confirm djay Pro detection in the REAL installed app.
#
# Launches the app under its real macOS identity (via LaunchServices, NOT as a
# terminal child — so AXIsProcessTrusted reflects the actual app). Uses the
# focused --check-djay mode: Accessibility trust + djay AX read only, so it never
# blocks on a Music/Spotify Automation prompt. The app writes its result to the
# log dir (always writable); this script copies it to the Desktop for you.
set -euo pipefail

APP="/Applications/Decks Bridge.app"
LOGDIR="$HOME/Library/Logs/Decks Bridge"
LOGFILE="$LOGDIR/decks-bridge-djay-check.txt"
DESKTOP="$HOME/Desktop/decks-bridge-diagnostics.txt"

[[ -d "$APP" ]] || { echo "ERROR: $APP not found — install from the DMG first." >&2; exit 1; }

echo "== App identity =="
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E '^Identifier=|^Authority='
echo ""

echo "== djay Pro state =="
if pgrep -x "djay Pro" >/dev/null; then echo "djay Pro: running"; else echo "djay Pro: NOT running (open it and load/play a track)"; fi
echo ""

echo "== Launching the app under its real identity (--check-djay)… =="
# Force a fresh instance so args are honored, and clear the old result first.
pkill -x decks-bridge 2>/dev/null || true
sleep 1
rm -f "$LOGFILE"
open -n -a "$APP" --args --check-djay
i=0
until [[ -f "$LOGFILE" || $i -ge 20 ]]; do sleep 1; i=$((i+1)); done
[[ -f "$LOGFILE" ]] || { echo "ERROR: app did not write $LOGFILE (is it launching? check Gatekeeper)." >&2; exit 1; }

# Mirror to Desktop (this script has Terminal's Desktop access).
cp -f "$LOGFILE" "$DESKTOP" 2>/dev/null || true

echo ""
echo "== Result =="
cat "$LOGFILE"
echo ""

if grep -q "AXIsProcessTrusted: true" "$LOGFILE" && grep -qi "FINAL chosen source: djay" "$LOGFILE"; then
  echo "RESULT: ✅ djay Pro detected — Accessibility granted and Bridge reads the track."
elif grep -q "AXIsProcessTrusted: false" "$LOGFILE"; then
  echo "RESULT: ⚠️  AXIsProcessTrusted=false — grant Accessibility to /Applications/Decks Bridge.app:"
  echo "        System Settings → Privacy & Security → Accessibility → + → /Applications/Decks Bridge.app → ON"
else
  echo "RESULT: djay not read. See $LOGFILE"
fi
echo ""
echo "Report also copied to: $DESKTOP"
