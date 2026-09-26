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

/**
 * Strip secrets from a pairing response before it can reach a console, the
 * on-disk diagnostic log, or the debug panel.
 *
 * The bridge-pair success body carries `ingest_token` — the DJ's long-lived
 * credential for their event. It was previously logged verbatim, so anyone
 * with the log had the token.
 */
export function redactBody(body: string): string {
  if (!body) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return body;
    const o = parsed as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (/token|secret|password|key|authorization/i.test(k)) o[k] = "(redacted)";
    }
    return JSON.stringify(o);
  } catch {
    // Not JSON — most likely an HTML error page. Truncate rather than echo an
    // unbounded body we haven't inspected.
    return body.length > 200 ? `${body.slice(0, 200)}…(truncated)` : body;
  }
}

/** A pairing code is a single-use credential; never write it out in full. */
function redactCode(code: string): string {
  return `${"•".repeat(Math.max(0, code.length - 2))}${code.slice(-2)}`;
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
  const { logDiagnostic } = await import("./log");
  // The code is a single-use credential and logDiagnostic writes to a file on
  // disk that support may be sent — never record it in full.
  await logDiagnostic("pairing", `bridge-pair POST code=${redactCode(code)}`);

  try {
    const res = await fetch(PAIR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    status = res.status;
    bodyText = await res.text().catch(() => "");

    console.log("[bridge-pair] ←", status, redactBody(bodyText));

    // debug is surfaced to the UI/console, so it must never carry the token or
    // the raw code — the success body contains ingest_token.
    const debug: PairDebug = {
      url: PAIR_URL,
      codeSent: redactCode(code),
      payload: redactBody(payload),
      status,
      body: redactBody(bodyText),
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
      console.error("[bridge-pair] JSON parse failed on 200 body:", redactBody(bodyText));
      return { ok: false, error: "Unexpected server response. Try again.", debug };
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
    const debug: PairDebug = {
      url: PAIR_URL,
      codeSent: redactCode(code),
      payload: redactBody(payload),
      status,
      body: redactBody(bodyText),
    };
    return { ok: false, error: mapError(0, ""), debug };
  }
}
