import type { Config } from "./store";
import type { DetectedTrack } from "./playback";

export type ConnectionStatus = "connected" | "waiting_dj" | "disconnected";

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number;
  authFailed: boolean;
}

const INGEST_FALLBACK =
  "https://rwdgnapajxcxktmewlxb.supabase.co/functions/v1/now-playing-ingest";

export async function pingSupabase(config: Config): Promise<PingResult> {
  const url =
    config.url && config.url.startsWith("https://") ? config.url : INGEST_FALLBACK;

  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": config.token,
      },
      body: JSON.stringify({
        type: "bridge_connected",
        event_id: config.eventId,
        source: "bridge",
        connected_at: new Date().toISOString(),
      }),
    });
    const latencyMs = Math.round(performance.now() - started);
    return {
      ok: res.ok,
      latencyMs,
      httpStatus: res.status,
      authFailed: res.status === 401 || res.status === 403,
    };
  } catch {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      httpStatus: 0,
      authFailed: false,
    };
  }
}

export function deriveConnectionStatus(opts: {
  online: boolean;
  supabaseOk: boolean;
  authFailed: boolean;
  autoDetect: boolean;
  detected: DetectedTrack | null;
  lastIngestOk: boolean;
}): { status: ConnectionStatus; message: string } {
  const { online, supabaseOk, authFailed, autoDetect, detected, lastIngestOk } = opts;

  if (!online) {
    return { status: "disconnected", message: "No internet — detecting locally, uploads queued." };
  }
  if (authFailed) {
    return { status: "disconnected", message: "Session expired — re-pair when ready." };
  }
  if (!supabaseOk) {
    return { status: "disconnected", message: "Unable to connect. Retrying…" };
  }

  if (autoDetect) {
    const hasTrack = Boolean(detected?.title && detected.isPlaying);
    if (!hasTrack && !lastIngestOk) {
      return { status: "waiting_dj", message: "No track detected" };
    }
    return { status: "connected", message: "Connected to Decks" };
  }

  // Manual mode: the link to Decks is healthy, but nothing is being detected or
  // sent automatically. Saying "Connected to Decks" here would imply the set is
  // being tracked when it is not — report the reachable-but-idle state honestly.
  return { status: "waiting_dj", message: "Manual mode — tracks are not sent automatically" };
}
