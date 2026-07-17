// ── Decks Bridge — live event snapshot data model ────────────────────────────
//
// This is the single shape every viewer surface (expanded / mini / pill) renders
// from, regardless of where the data comes from. In Phase 1 it is filled by a
// hardcoded placeholder; in Phase 2 by a `BridgeDataProvider`
// (MockBridgeProvider in dev, LiveBridgeProvider against the real endpoint).
//
// SECURITY: this model deliberately excludes anything sensitive — no Stripe
// keys, webhook secrets, service-role credentials, full payment IDs, or private
// guest data. Only the fields the UI actually needs live here. Keep it that way.

/** Lifecycle of a guest song request as it moves through the DJ's queue. */
export type RequestStatus =
  | "pending"
  | "approved"
  | "playing"
  | "played"
  | "rejected";

/** Health of the data provider feeding the viewer (Phase 2+). */
export type ProviderConnectionState =
  | "connecting"
  | "live"
  | "stale"
  | "error"
  | "unauthorized";

/** Event-level connection state as reported by the backend snapshot. */
export type EventConnectionStatus = "connected" | "waiting_dj" | "disconnected";

export interface NowPlayingItem {
  title: string;
  artist: string;
  albumArt?: string;
  /** Detected DJ app / source, e.g. "djay Pro", "Serato DJ Pro", "rekordbox". */
  source?: string;
  /** ISO 8601 — when this track started (optional). */
  startedAt?: string;
  /** Linked request id, if this track corresponds to a guest request. */
  requestId?: string;
  /** Playback status string from the backend (optional). */
  status?: string;
}

/** A row of the live queue / trending — mirrors the backend request rows. */
export interface QueueItem {
  id: string;
  title: string;
  artist: string;
  votes: number;
  status: RequestStatus;
  /** ISO 8601. */
  requestedAt: string;
  /** Display-only requester name if the event exposes one (optional). */
  requesterName?: string;
  albumArt?: string;
  /** How many times this song was requested. */
  requestCount?: number;
  /** Total tips attributed to this song, in major currency units. */
  tipTotal?: number;
  /** Backend-assigned position in the queue. */
  queuePosition?: number;
}

export interface TrendingSong {
  id: string;
  title: string;
  artist: string;
  votes: number;
  /** 1-based rank, optional (UI can derive from array order). */
  rank?: number;
  albumArt?: string;
  requestCount?: number;
  tipTotal?: number;
  queuePosition?: number;
  requestStatus?: RequestStatus;
}

export interface Tip {
  id: string;
  /** Amount in major currency units (e.g. dollars, not cents). */
  amount: number;
  /** Net amount after fees, in major currency units (optional). */
  netAmount?: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Optional tipper display name / nickname (never PII beyond a chosen handle). */
  displayName?: string;
  /** Optional short message shown with the tip. */
  message?: string;
  /** Song this tip was attached to, if any. */
  songTitle?: string;
  songArtist?: string;
  /** Payment status string from the backend (e.g. "succeeded", "pending"). */
  paymentStatus?: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface TipTotals {
  /** Total tipped (settled), in major currency units. */
  total: number;
  /** Pending (not-yet-settled) tips, in major currency units. */
  pending?: number;
  /** Number of tips. */
  count: number;
  /** ISO 4217 currency code. */
  currency: string;
}

export interface BridgeSnapshot {
  eventName: string;
  connectionStatus: EventConnectionStatus;
  nowPlaying: NowPlayingItem | null;
  queue: QueueItem[];
  trending: TrendingSong[];
  tips: Tip[];
  tipTotals: TipTotals;
  /** Aggregate count of guests currently connected (optional). */
  guestsOnline?: number;
  /** ISO 8601 — when the event started; drives the Event Duration timer. */
  eventStartedAt?: string;
  /** Event details from the backend. */
  venue?: string;
  djName?: string;
  eventStatus?: string;
  roomCode?: string;
  /** Precomputed event duration in seconds (preferred over eventStartedAt). */
  eventDurationSeconds?: number;
  /** Bridge-side context from the backend. */
  bridgeLastSeen?: string;
  bridgeLastSync?: string;
  bridgeSourceType?: string;
  /** ISO 8601 — when this snapshot was produced by the source. */
  updatedAt: string;
  /**
   * Dev-only marker. Set exclusively by MockBridgeProvider so the UI can render
   * a "MOCK DATA" badge. It is NEVER present on live data and MUST NOT be
   * relied on for anything other than the dev badge.
   */
  __mock?: true;
}

/** The three viewer window surfaces. */
export type ViewerMode = "expanded" | "mini" | "pill";

/** Health of the snapshot polling loop, surfaced by `useBridgeSnapshot`. */
export type SnapshotState =
  | "connecting" // first fetch in flight, no snapshot yet
  | "live" // last fetch succeeded
  | "stale" // a fetch failed but we still have a prior snapshot
  | "unavailable" // endpoint not deployed / 404
  | "error" // failed with no snapshot to show
  | "unauthorized"; // pairing token rejected

/** Simple confidence indicator for the UI (not a diagnostics panel). */
export type SyncLevel = "green" | "orange" | "gray" | "red";
export interface SyncConfidence {
  level: SyncLevel;
  label: string;
}
