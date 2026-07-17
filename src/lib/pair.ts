import { INGEST_FALLBACK, type Config } from "./store";

const PAIR_URL =
  "https://rwdgnapajxcxktmewlxb.supabase.co/functions/v1/bridge-pair";

export interface PairResult {
  ok: boolean;
  config?: Config;
  error?: string;
  debug?: PairDebug;
}

export interface PairDebug {
  url: string;
  codeSent: string;
  payload: string;
  status: number;
  body: string;
}

function mapError(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("expired")) return "This pairing code has expired. Generate a new one from your event dashboard.";
  if (lower.includes("claimed") || lower.includes("already")) return "This code has already been used by another device.";
  if (lower.includes("invalid") || lower.includes("not found") || status === 404) return "Invalid pairing code. Double-check and try again.";
  if (status === 0) return "Network error. Check your internet connection and try again.";
  return body || `Connection failed (${status}).`;
}

export async function pairWithCode(code: string): Promise<PairResult> {
  let status = 0;
  let bodyText = "";
  const payload = JSON.stringify({ code });

  console.log("[bridge-pair] →", PAIR_URL);
  console.log("[bridge-pair] code:", code, "| payload:", payload);
  const { logDiagnostic } = await import("./log");
  await logDiagnostic("pairing", `bridge-pair POST code=${code}`);

  try {
    const res = await fetch(PAIR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    status = res.status;
    bodyText = await res.text().catch(() => "");

    console.log("[bridge-pair] ←", status, bodyText);

    const debug: PairDebug = {
      url: PAIR_URL,
      codeSent: code,
      payload,
      status,
      body: bodyText,
    };

    if (!res.ok) {
      let parsed: Record<string, string> = {};
      try { parsed = JSON.parse(bodyText); } catch { /* leave empty */ }
      const msg = parsed.error ?? parsed.message ?? bodyText;
      return { ok: false, error: mapError(status, msg), debug };
    }

    let data: Record<string, string>;
    try {
      data = JSON.parse(bodyText) as Record<string, string>;
    } catch {
      console.error("[bridge-pair] JSON parse failed on 200 body:", bodyText);
      return { ok: false, error: "Unexpected server response. Try again.", debug: { url: PAIR_URL, codeSent: code, payload, status, body: bodyText } };
    }

    // Normalise the ingest URL: use whatever the server returns if it looks like
    // a complete HTTPS URL, otherwise fall back to the known-good endpoint.
    const rawUrl = data.endpoint_url ?? "";
    const ingestUrl = rawUrl.startsWith("https://") ? rawUrl : INGEST_FALLBACK;

    console.log("[bridge-pair] endpoint_url from server:", rawUrl || "(missing)");
    console.log("[bridge-pair] ingest URL resolved to:", ingestUrl);

    const config: Config = {
      url: ingestUrl,
      token: data.ingest_token,
      eventId: data.event_id,
      ...(data.event_name ? { eventName: data.event_name } : {}),
    };

    return { ok: true, config, debug };
  } catch (err) {
    console.error("[bridge-pair] fetch error:", err);
    const debug: PairDebug = { url: PAIR_URL, codeSent: code, payload, status, body: bodyText };
    return { ok: false, error: mapError(0, ""), debug };
  }
}
