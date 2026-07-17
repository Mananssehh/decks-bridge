// ── LiveBridgeProvider — authenticated, read-only snapshot fetch ─────────────
//
// Talks to the DEPLOYED `bridge-event-snapshot` Edge Function. It authenticates
// with the EXISTING paired ingest token via `Authorization: Bearer <token>`
// (no new secret; no Supabase anon/service-role, Stripe, or webhook keys).
// One read-only request per `getSnapshot()`; the loop + backoff live in the hook.
//
// SECURITY: the token is sent only in the Authorization header and is NEVER
// logged or echoed anywhere in this module.

import type { Config } from "../store";
import type {
  BridgeSnapshot,
  EventConnectionStatus,
  RequestStatus,
  Tip,
} from "./types";
import { type BridgeDataProvider, ProviderError } from "./provider";

/**
 * Resolve the snapshot endpoint. Order:
 *   1. explicit `VITE_SNAPSHOT_URL` override,
 *   2. `<ref>.functions.supabase.co/functions/v1/bridge-event-snapshot`
 *      where `<ref>` is derived from the paired ingest URL (same project),
 *   3. same-host swap of the ingest URL as a last resort.
 */
export function resolveSnapshotUrl(config: Config): string | null {
  const override = (import.meta.env.VITE_SNAPSHOT_URL as string | undefined)?.trim();
  if (override && override.startsWith("https://")) return override;

  if (config.url && config.url.startsWith("https://")) {
    try {
      const host = new URL(config.url).host; // e.g. rwdgnapajxcxktmewlxb.supabase.co
      const ref = host.split(".")[0];
      if (ref) {
        return `https://${ref}.functions.supabase.co/functions/v1/bridge-event-snapshot`;
      }
    } catch {
      /* fall through */
    }
    if (config.url.includes("/functions/v1/")) {
      return config.url.replace(/\/functions\/v1\/[^/?#]+/, "/functions/v1/bridge-event-snapshot");
    }
  }
  return null;
}

const REQUEST_TIMEOUT_MS = 8_000;

export class LiveBridgeProvider implements BridgeDataProvider {
  readonly kind = "live" as const;
  private readonly config: Config;
  private readonly url: string | null;

  constructor(config: Config) {
    this.config = config;
    this.url = resolveSnapshotUrl(config);
  }

  async getSnapshot(): Promise<BridgeSnapshot> {
    if (!this.url) {
      throw new ProviderError("unavailable", "Snapshot endpoint could not be resolved.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Existing paired ingest token — Authorization header only, never logged.
          Authorization: `Bearer ${this.config.token}`,
        },
        // Body carries nothing sensitive; the event is resolved from the token.
        body: "{}",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError("network", `Network error: ${msg}`);
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("unauthorized", "Pairing token rejected.", res.status);
    }
    if (res.status === 404 || res.status === 501) {
      throw new ProviderError("unavailable", "Snapshot endpoint not available.", res.status);
    }
    if (res.status >= 500) {
      throw new ProviderError("server", `Server error (${res.status}).`, res.status);
    }
    if (!res.ok) {
      throw new ProviderError("bad_response", `Unexpected status ${res.status}.`, res.status);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new ProviderError("bad_response", "Snapshot response was not valid JSON.");
    }

    try {
      return mapSnapshot(raw, this.config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ProviderError("bad_response", `Snapshot shape invalid: ${msg}`);
    }
  }
}

// ── Defensive mapping: BridgeEventSnapshotResponse → BridgeSnapshot ──────────
// Coerces types, tolerates nulls + unknown extra fields, converts cents→dollars,
// and PRESERVES the backend's trending order (never re-sorts). Reads only the
// whitelisted UI fields — any secret-looking field is ignored by omission.

function mapSnapshot(raw: unknown, config: Config): BridgeSnapshot {
  const o = asObject(raw);
  const event = asObject(o.event);
  const np = o.now_playing == null ? null : asObject(o.now_playing);
  const tips = asObject(o.tips);
  const bridge = asObject(o.bridge);

  const currency = (str(tips.currency) || "USD").toUpperCase();

  return {
    eventName: str(event.name) || config.eventName || "Live Event",
    venue: optStr(event.venue),
    djName: optStr(event.dj_name),
    eventStatus: optStr(event.status),
    roomCode: optStr(event.room_code),
    guestsOnline: event.guests_online == null ? undefined : num(event.guests_online),
    eventDurationSeconds:
      event.event_duration_seconds == null ? undefined : num(event.event_duration_seconds),
    eventStartedAt: optStr(event.created_at),
    connectionStatus: deriveConn(bridge, event),

    nowPlaying:
      np && (np.title || np.artist)
        ? {
            title: str(np.title),
            artist: str(np.artist),
            albumArt: optStr(np.artwork),
            source: optStr(np.source),
            startedAt: optStr(np.started_at),
            requestId: optStr(np.request_id),
            status: optStr(np.status),
          }
        : null,

    // Live queue — PRESERVE server order (queue_position), do not re-sort.
    queue: arr(o.queue).map((q) => mapRequestRow(q)),
    // Trending — PRESERVE server order exactly as computed by the backend.
    trending: arr(o.trending).map((t, i) => ({
      ...mapRequestRow(t),
      rank: i + 1,
      requestStatus: mapRequestRow(t).status,
    })),

    tips: arr(tips.recent).map((t, idx) => mapTip(t, idx, currency)),
    tipTotals: {
      total: cents(tips.total_cents),
      pending: cents(tips.pending_cents),
      count: arr(tips.recent).length,
      currency,
    },

    bridgeLastSeen: optStr(bridge.last_seen),
    bridgeLastSync: optStr(bridge.last_sync),
    bridgeSourceType: optStr(bridge.source_type),

    updatedAt: new Date().toISOString(),
    // __mock intentionally never set — live data is never marked mock.
  };
}

function mapRequestRow(v: unknown) {
  const i = asObject(v);
  return {
    id: str(i.request_id) || str(i.song_id) || cryptoId(),
    title: str(i.title),
    artist: str(i.artist),
    albumArt: optStr(i.artwork),
    votes: num(i.vote_count),
    requestCount: i.request_count == null ? undefined : num(i.request_count),
    tipTotal: i.tip_total_cents == null ? undefined : cents(i.tip_total_cents),
    queuePosition: i.queue_position == null ? undefined : num(i.queue_position),
    status: asRequestStatus(i.request_status),
    requestedAt: str(i.created_at),
  };
}

function mapTip(v: unknown, idx: number, fallbackCurrency: string): Tip {
  const i = asObject(v);
  return {
    id: `${str(i.created_at)}-${idx}`,
    amount: cents(i.amount_cents),
    netAmount: i.net_amount_cents == null ? undefined : cents(i.net_amount_cents),
    currency: (str(i.currency) || fallbackCurrency).toUpperCase(),
    displayName: optStr(i.guest_nickname),
    songTitle: optStr(i.song_title),
    songArtist: optStr(i.artist),
    paymentStatus: optStr(i.payment_status),
    createdAt: str(i.created_at),
  };
}

/** Event connection derived from bridge pairing + last_seen freshness. */
function deriveConn(bridge: Record<string, unknown>, event: Record<string, unknown>): EventConnectionStatus {
  if (bridge.paired === false) return "disconnected";
  const lastSeen = optStr(bridge.last_seen);
  if (lastSeen) {
    const age = Date.now() - Date.parse(lastSeen);
    if (Number.isFinite(age) && age < 90_000) return "connected";
  }
  // Paired but no fresh heartbeat yet → waiting on the DJ's Bridge to send.
  return event.status === "ended" ? "disconnected" : "waiting_dj";
}

// ── coercion helpers ─────────────────────────────────────────────────────────
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}
/** cents → dollars (major units), rounded to 2dp. */
function cents(v: unknown): number {
  return Math.round(num(v)) / 100;
}
function asRequestStatus(v: unknown): RequestStatus {
  return v === "pending" || v === "approved" || v === "playing" || v === "played" || v === "rejected"
    ? v
    : "pending";
}
let idCounter = 0;
function cryptoId(): string {
  return `row-${Date.now()}-${idCounter++}`;
}
