import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../lib/store";
import {
  deriveConnectionStatus,
  pingSupabase,
  type ConnectionStatus,
} from "../lib/connection";
import { flushOfflineQueue } from "../lib/offlineQueue";
import { logDiagnostic } from "../lib/log";
import type { DetectedTrack } from "../lib/playback";

/** Ping cadence when healthy. */
const HEARTBEAT_MS = 30_000;
/** Reconnect backoff when the connection is down: 1s, 2s, 5s, 10s, then 30s. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface BridgeConnectionState {
  status: ConnectionStatus;
  message: string;
  online: boolean;
  supabaseLatencyMs: number | null;
  lastIngestAt: string | null;
  authFailed: boolean;
  recordIngest: (ok: boolean) => void;
  retryNow: () => void;
}

export function useBridgeConnection(
  config: Config,
  autoDetect: boolean,
  detected: DetectedTrack | null,
  /** Fired when the connection recovers after being down — used to resend the
   *  latest detected track immediately (no re-pairing needed). */
  onReconnect?: () => void
): BridgeConnectionState {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [supabaseOk, setSupabaseOk] = useState(true);
  const [authFailed, setAuthFailed] = useState(false);
  const [supabaseLatencyMs, setSupabaseLatencyMs] = useState<number | null>(null);
  const [lastIngestAt, setLastIngestAt] = useState<string | null>(null);
  const lastIngestOkRef = useRef(false);
  const [lastIngestOk, setLastIngestOk] = useState(false);
  const failStreakRef = useRef(0);
  const wasDownRef = useRef(false);
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  // Returns true if the connection is currently healthy.
  const heartbeat = useCallback(async (): Promise<boolean> => {
    const ping = await pingSupabase(config);
    setSupabaseLatencyMs(ping.latencyMs);

    if (ping.authFailed) {
      // Invalid token — only case that needs re-pairing.
      setAuthFailed(true);
      setSupabaseOk(false);
      failStreakRef.current = Math.max(failStreakRef.current, 1);
      wasDownRef.current = true;
      logDiagnostic("supabase", `auth failed status=${ping.httpStatus}`).catch(() => undefined);
      return false;
    }

    if (ping.ok) {
      const recovered = wasDownRef.current;
      setSupabaseOk(true);
      setAuthFailed(false);
      failStreakRef.current = 0;
      wasDownRef.current = false;
      await flushOfflineQueue(config);
      if (recovered) {
        // Restore the paired event with the latest track immediately.
        logDiagnostic("supabase", "reconnected — resyncing latest track").catch(() => undefined);
        onReconnectRef.current?.();
      }
      return true;
    }

    failStreakRef.current += 1;
    setSupabaseOk(failStreakRef.current < 3);
    wasDownRef.current = true;
    logDiagnostic(
      "supabase",
      `ping failed status=${ping.httpStatus} streak=${failStreakRef.current}`
    ).catch(() => undefined);
    return false;
  }, [config]);

  const retryNow = useCallback(() => {
    failStreakRef.current = 0;
    heartbeat();
  }, [heartbeat]);

  const recordIngest = useCallback((ok: boolean) => {
    lastIngestOkRef.current = ok;
    setLastIngestOk(ok);
    if (ok) setLastIngestAt(new Date().toISOString());
  }, []);

  // Self-scheduling ping: 30s when healthy, exponential backoff when down.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const ok = await heartbeat();
      if (cancelled) return;
      const delay = ok
        ? HEARTBEAT_MS
        : BACKOFF_MS[Math.min(failStreakRef.current - 1, BACKOFF_MS.length - 1)] ?? HEARTBEAT_MS;
      timer = setTimeout(run, delay);
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [heartbeat]);

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      heartbeat();
    };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible") heartbeat();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [heartbeat]);

  const { status, message } = deriveConnectionStatus({
    online,
    supabaseOk,
    authFailed,
    autoDetect,
    detected,
    lastIngestOk: lastIngestOk || lastIngestOkRef.current,
  });

  return {
    status,
    message,
    online,
    supabaseLatencyMs,
    lastIngestAt,
    authFailed,
    recordIngest,
    retryNow,
  };
}
