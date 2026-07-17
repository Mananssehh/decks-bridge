import { type Config } from "./store";

const INGEST_FALLBACK =
  "https://rwdgnapajxcxktmewlxb.supabase.co/functions/v1/now-playing-ingest";

export async function sendHeartbeat(config: Config): Promise<void> {
  const url =
    config.url && config.url.startsWith("https://") ? config.url : INGEST_FALLBACK;

  const body = JSON.stringify({
    type: "bridge_connected",
    event_id: config.eventId,
    source: "bridge",
    connected_at: new Date().toISOString(),
  });

  console.log("[heartbeat] POST", url, body);
  const { logDiagnostic } = await import("./log");
  await logDiagnostic("supabase", `heartbeat POST ${new URL(url).host}`);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": config.token,
      },
      body,
    });
    console.log("[heartbeat] ←", res.status);
  } catch (err) {
    console.warn("[heartbeat] failed (non-fatal):", err);
  }
}

export interface TrackPayload {
  title: string;
  artist: string;
  album_art?: string;
  playback_app?: string;
}

export interface SendResult {
  ok: boolean;
  message: string;
  /** Exact URL that was POSTed to. */
  requestUrl: string;
  /** HTTP status code (0 = network failure). */
  httpStatus: number;
  /** Raw response body text. */
  responseBody: string;
}

export async function sendNowPlaying(
  config: Config,
  track: TrackPayload,
  source = "decks_bridge"
): Promise<SendResult> {
  const url =
    config.url && config.url.startsWith("https://") ? config.url : INGEST_FALLBACK;

  const body: Record<string, string> = {
    title: track.title,
    artist: track.artist,
    event_id: config.eventId,
    source,
    status: "playing",
  };
  if (track.album_art && track.album_art.trim()) body.album_art = track.album_art.trim();
  if (track.playback_app && track.playback_app.trim()) body.playback_app = track.playback_app.trim();

  const payloadJson = JSON.stringify(body);

  console.group("[ingest] POST");
  console.log("url    :", url);
  console.log("token  :", config.token ? "(present, redacted)" : "(missing)");
  console.log("payload:", payloadJson);
  console.groupEnd();

  let httpStatus = 0;
  let responseBody = "";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": config.token,
      },
      body: payloadJson,
    });

    httpStatus = res.status;
    responseBody = await res.text().catch(() => "");

    console.log(`[ingest] ← ${httpStatus}`, responseBody);
    const { logDiagnostic } = await import("./log");
    await logDiagnostic(
      "metadata",
      `ingest ${track.title} status=${httpStatus} ok=${res.ok}`
    );

    if (!res.ok) {
      return {
        ok: false,
        message: `HTTP ${httpStatus}${responseBody ? `: ${responseBody}` : ""}`,
        requestUrl: url,
        httpStatus,
        responseBody,
      };
    }

    return { ok: true, message: "Track sent.", requestUrl: url, httpStatus, responseBody };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[ingest] fetch error:", msg);
    return {
      ok: false,
      message: `Network error: ${msg}`,
      requestUrl: url,
      httpStatus: 0,
      responseBody: msg,
    };
  }
}
