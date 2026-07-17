// ── useBridgeSnapshot — the ONE snapshot polling loop ────────────────────────
//
// Drives the viewer's cloud data (queue / tips / trending / event details). It
// is completely separate from the existing 3 s Now Playing detector and the
// 30 s heartbeat — this loop only READS the event snapshot and never touches
// detection, pairing, or the sync engine.
//
// Guarantees (per the backend/handoff spec):
//   • exactly one loop, self-scheduling (setTimeout, never setInterval)
//   • no overlapping requests (in-flight guard)
//   • monotonic sequence id — stale/out-of-order responses are discarded
//   • 4 s cadence while the surface is visible & not in pill mode; 15 s when
//     hidden/minimised or in pill mode; PAUSED entirely while offline
//   • error backoff 4 → 8 → 15 → 30 s; reset to the normal cadence on success
//   • immediate refresh after pairing (mount), on reconnect (online),
//     and when the window returns to the foreground
//   • local-first: an OLDER backend now-playing never overwrites a newer one
//   • keeps the last good snapshot on failure (shows "stale", never fake data)

import { useCallback, useEffect, useRef, useState } from "react";
import type { BridgeDataProvider, ProviderError } from "../lib/bridge/provider";
import type {
  BridgeSnapshot,
  NowPlayingItem,
  SnapshotState,
  SyncConfidence,
} from "../lib/bridge/types";

const FAST_INTERVAL_MS = 4_000; // visible & not pill
const SLOW_INTERVAL_MS = 15_000; // hidden / minimised / pill
const BACKOFF_MS = [4_000, 8_000, 15_000, 30_000];

export interface UseBridgeSnapshotOptions {
  enabled?: boolean;
  /** Pill mode → poll on the slow (15 s) cadence. */
  slowMode?: boolean;
}

export interface UseBridgeSnapshot {
  snapshot: BridgeSnapshot | null;
  state: SnapshotState;
  error: string | null;
  confidence: SyncConfidence;
  lastUpdatedAt: number | null;
  refreshNow: () => void;
}

function isProviderError(e: unknown): e is ProviderError {
  return !!e && typeof e === "object" && "kind" in e && (e as { name?: string }).name === "ProviderError";
}

/**
 * Local-first now-playing guard. An OLDER backend now-playing must never replace
 * a newer one already on screen (backend lag / out-of-order data). Compares by
 * `started_at`; if the incoming track is strictly older, keep the current one
 * and take the rest of the snapshot. Updates the ref with whichever NP is shown.
 */
function guardNowPlaying(
  snap: BridgeSnapshot,
  lastNpRef: { current: { np: NowPlayingItem | null; at: number } }
): BridgeSnapshot {
  const incoming = snap.nowPlaying;
  const incomingAt = incoming?.startedAt ? Date.parse(incoming.startedAt) : NaN;
  const last = lastNpRef.current;

  // Keep the newer on-screen track if the incoming one is strictly older.
  if (
    last.np &&
    Number.isFinite(last.at) &&
    last.at > 0 &&
    Number.isFinite(incomingAt) &&
    incomingAt < last.at
  ) {
    return { ...snap, nowPlaying: last.np };
  }

  lastNpRef.current = {
    np: incoming,
    at: Number.isFinite(incomingAt) ? incomingAt : last.at,
  };
  return snap;
}

export function deriveConfidence(state: SnapshotState, snapshot: BridgeSnapshot | null): SyncConfidence {
  switch (state) {
    case "unauthorized":
      return { level: "red", label: "Pairing expired" };
    case "stale":
    case "error":
    case "unavailable":
      return { level: "orange", label: "Local only — reconnecting" };
    case "connecting":
      return { level: "gray", label: "Connecting…" };
    case "live":
    default:
      if (snapshot?.nowPlaying?.title) return { level: "green", label: "Synced" };
      return { level: "gray", label: "No active track" };
  }
}

export function useBridgeSnapshot(
  provider: BridgeDataProvider | null,
  options: UseBridgeSnapshotOptions = {}
): UseBridgeSnapshot {
  const { enabled = true, slowMode = false } = options;
  const [snapshot, setSnapshot] = useState<BridgeSnapshot | null>(null);
  const [state, setState] = useState<SnapshotState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  // Loop bookkeeping — refs so the single loop never restarts on re-render.
  const seqRef = useRef(0); // monotonic request id
  const appliedSeqRef = useRef(0); // newest seq already applied to state
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSnapshotRef = useRef(false);
  // The now-playing currently shown + its started_at (ms), for the local-first guard.
  const lastNpRef = useRef<{ np: NowPlayingItem | null; at: number }>({ np: null, at: 0 });
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const slowModeRef = useRef(slowMode);
  slowModeRef.current = slowMode;

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Perform exactly one fetch. `poll()` guards against overlap and schedules
  // the next run itself, so this is the only place timing is decided.
  const poll = useCallback(async () => {
    const p = providerRef.current;
    if (!p || !enabledRef.current) return;
    if (inFlightRef.current) return; // no overlap
    // Note: we do NOT skip based on visibility here — the immediate poll (mount,
    // Sync Now, reconnect, foreground) must always run. Pausing while hidden is
    // handled in scheduleNext(), which simply doesn't queue the next interval.

    inFlightRef.current = true;
    const mySeq = ++seqRef.current;

    try {
      const snap = await p.getSnapshot();
      // Discard if a newer request already resolved (out-of-order guard).
      if (mySeq < appliedSeqRef.current) return;
      appliedSeqRef.current = mySeq;

      // Local-first: never let an OLDER backend now-playing overwrite a newer
      // one already on screen. If the incoming track is older (by started_at),
      // keep the current now-playing but accept the rest of the snapshot.
      const guarded = guardNowPlaying(snap, lastNpRef);

      failuresRef.current = 0;
      hasSnapshotRef.current = true;
      setSnapshot(guarded);
      setState("live");
      setError(null);
      setLastUpdatedAt(Date.now());
    } catch (e) {
      if (mySeq < appliedSeqRef.current) return;
      appliedSeqRef.current = mySeq;

      failuresRef.current += 1;
      const kind = isProviderError(e) ? e.kind : "network";
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);

      if (kind === "unauthorized") {
        setState("unauthorized");
      } else if (kind === "unavailable") {
        setState(hasSnapshotRef.current ? "stale" : "unavailable");
      } else {
        setState(hasSnapshotRef.current ? "stale" : "error");
      }
    } finally {
      inFlightRef.current = false;
      scheduleNext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Schedule the next poll: cadence by visibility/mode, backoff on failures.
  const scheduleNext = useCallback(() => {
    clearTimer();
    if (!enabledRef.current || !providerRef.current) return;
    // Pause ENTIRELY while offline — the `online` handler triggers an immediate
    // refresh on reconnect.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;

    const fails = failuresRef.current;
    let delay: number;
    if (fails > 0) {
      delay = BACKOFF_MS[Math.min(fails - 1, BACKOFF_MS.length - 1)];
    } else {
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      // 4 s while visible & not pill; 15 s when hidden/minimised or in pill mode.
      delay = hidden || slowModeRef.current ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
    }
    timerRef.current = setTimeout(() => {
      void poll();
    }, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll]);

  // Manual/immediate refresh (Sync Now, reconnect, foreground, pairing).
  const refreshNow = useCallback(() => {
    failuresRef.current = 0; // reset backoff on an explicit refresh
    clearTimer();
    void poll();
  }, [poll]);

  // Start / restart the loop when the provider or enablement changes. This is
  // the ONLY effect that kicks the loop, so there is never a second loop.
  useEffect(() => {
    // New provider ⇒ fresh state and an immediate fetch.
    appliedSeqRef.current = 0;
    seqRef.current = 0;
    failuresRef.current = 0;
    hasSnapshotRef.current = false;
    inFlightRef.current = false;
    lastNpRef.current = { np: null, at: 0 };

    if (!provider || !enabled) {
      clearTimer();
      setState("connecting");
      return;
    }

    setState("connecting");
    void poll(); // immediate refresh after pairing / provider swap

    return () => {
      clearTimer();
      provider.dispose?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, enabled]);

  // Reconnect + foreground → immediate refresh. Offline → pause. Visibility
  // change → reschedule at the correct (fast/slow) cadence.
  useEffect(() => {
    const onOnline = () => refreshNow();
    const onOffline = () => clearTimer(); // pause entirely while offline
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshNow();
      else scheduleNext(); // recompute cadence (→ 15 s) while hidden
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshNow, scheduleNext]);

  return {
    snapshot,
    state,
    error,
    confidence: deriveConfidence(state, snapshot),
    lastUpdatedAt,
    refreshNow,
  };
}
