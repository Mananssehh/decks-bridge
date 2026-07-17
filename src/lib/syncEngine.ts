import type { Config } from "./store";
import type { DetectedTrack, NowPlayingSource } from "./playback";

/** Detection, send, and log are injectable so the engine can be exercised
 *  without the Tauri/browser runtime; production wires the real modules. */
export interface SyncDeps {
  detect: (source: NowPlayingSource) => Promise<DetectedTrack>;
  send: (
    config: Config,
    track: { title: string; artist: string; playback_app?: string }
  ) => Promise<{ ok: boolean; httpStatus: number }>;
  log: (line: string) => void;
}

// ── Timing ────────────────────────────────────────────────────────────────────
/** How often the selected source detector runs. */
export const POLL_MS = 3_000;
/** Re-send the current track at least this often (keeps backend state fresh and
 *  recovers a dropped update) even when the song has not changed. */
export const HEARTBEAT_MS = 30_000;
/** Keep showing the last track through brief detection gaps up to this long;
 *  after this, mark the source paused instead of showing a stale song forever. */
export const STALE_MS = 15_000;
/** Reconnect backoff schedule for the send path (ms), then repeats the last. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Normalize a title/artist for comparison: collapse whitespace, lowercase. */
export function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

export type SyncState =
  | "stopped" // manual mode / not paired
  | "searching" // running, no valid track yet
  | "active" // running, a track is current
  | "delayed" // detection failing but within the stale window (keep last track)
  | "paused" // no valid track past the stale timeout
  | "sending"; // mid-send

export interface SyncStatus {
  running: boolean;
  source: NowPlayingSource;
  state: SyncState;
  /** Latest raw detection (for the diagnostics panel / Now Playing card). */
  detected: DetectedTrack | null;
  lastCheckedAt: number | null;
  lastSentAt: number | null;
  lastSentTrack: { title: string; artist: string } | null;
  online: boolean;
}

interface LastTrack {
  normKey: string;
  title: string;
  artist: string;
  trackId: string | null;
  detectedAt: number;
  sentAt: number | null; // null = not yet delivered (send failed / pending)
}

type Reason = "new" | "retry" | "heartbeat" | "sync-now" | "reconnect";

/**
 * The single detection→send loop for Now Playing. Exactly one timer runs at a
 * time; detections never overlap (the next tick is scheduled only after the
 * current one completes), and a monotonic sequence id discards any late result.
 * Framework-agnostic so its behavior is easy to reason about and test.
 */
export class SyncEngine {
  private config: Config | null = null;
  private source: NowPlayingSource = "auto";
  private running = false;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private lastAppliedSeq = 0;
  private inFlight = false;
  private forceNext = false;

  private last: LastTrack | null = null;
  private lastValidAt = 0;
  private lastCheckedAt: number | null = null;
  private detectedRaw: DetectedTrack | null = null;
  private state: SyncState = "stopped";
  private online = typeof navigator !== "undefined" ? navigator.onLine : true;
  /** Consecutive send failures; indexes BACKOFF_MS. 0 = healthy, no backoff. */
  private backoffIdx = 0;
  /** Epoch ms before which no automatic send is attempted. 0 = send freely. */
  private nextSendAt = 0;

  onStatus: ((s: SyncStatus) => void) | null = null;
  onIngest: ((ok: boolean) => void) | null = null;

  private deps: SyncDeps;

  constructor(deps?: Partial<SyncDeps>) {
    this.deps = {
      detect:
        deps?.detect ??
        (async (source) => {
          const m = await import("./playback");
          return source === "auto"
            ? m.detectNowPlaying()
            : m.detectNowPlayingSource(source);
        }),
      send:
        deps?.send ??
        (async (config, track) => {
          const m = await import("./offlineQueue");
          return m.sendTrackResilient(config, track, "decks_bridge");
        }),
      log:
        deps?.log ??
        ((line) => {
          // eslint-disable-next-line no-console
          console.log(`[sync] ${line}`);
          void import("./log")
            .then((m) => m.logDiagnostic("sync", line))
            .catch(() => undefined);
        }),
    };
  }

  // ── Configuration & lifecycle ─────────────────────────────────────────────
  configure(config: Config, source: NowPlayingSource): void {
    const configChanged =
      !this.config ||
      this.config.eventId !== config.eventId ||
      this.config.token !== config.token ||
      this.config.url !== config.url;
    const sourceChanged = this.source !== source;
    this.config = config;
    if (sourceChanged) {
      this.source = source;
      // A new source starts fresh so its first track is always sent.
      this.resetTrackState();
      this.log(`[source] switched to ${source}`);
    }
    if ((configChanged || sourceChanged) && this.running) {
      // Re-arm the loop immediately under the new settings.
      this.scheduleTick(0);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clearBackoff();
    this.online = typeof navigator !== "undefined" ? navigator.onLine : true;
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
    this.log(`[loop] started (source=${this.source}, every ${POLL_MS / 1000}s)`);
    this.state = "searching";
    this.scheduleTick(0);
    this.emit();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.state = "stopped";
    this.log("[loop] stopped");
    this.emit();
  }

  dispose(): void {
    this.stop();
    this.onStatus = null;
    this.onIngest = null;
  }

  /** Force an immediate detect + send of the current track (manual "Sync Now",
   *  or an automatic resync after reconnect). Never needed in normal operation. */
  syncNow(reason: "manual" | "reconnect" = "manual"): void {
    if (!this.running) return;
    this.log(`[sync-now] requested (${reason})`);
    this.forceNext = true;
    this.scheduleTick(0);
  }

  private resetTrackState(): void {
    this.last = null;
    this.lastValidAt = 0;
    this.detectedRaw = null;
  }

  /** Clear the send backoff. Both fields must move together: leaving nextSendAt
   *  set after a reset would keep holding sends off despite a healthy link. */
  private clearBackoff(): void {
    this.backoffIdx = 0;
    this.nextSendAt = 0;
  }

  // ── Network transitions ───────────────────────────────────────────────────
  private handleOnline = (): void => {
    this.online = true;
    this.clearBackoff();
    this.log("[net] back online — resyncing latest track");
    this.emit();
    this.syncNow("reconnect");
  };

  private handleOffline = (): void => {
    this.online = false;
    this.log("[net] offline — detecting locally, sends will queue");
    this.emit();
  };

  /** Called by the connection layer when a Supabase ping recovers. */
  notifyReconnected(): void {
    this.clearBackoff();
    if (this.running) this.syncNow("reconnect");
  }

  // ── The loop ──────────────────────────────────────────────────────────────
  private scheduleTick(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.config) return;
    if (this.inFlight) return; // never overlap detections
    this.inFlight = true;
    const force = this.forceNext;
    this.forceNext = false;
    const mySeq = ++this.seq;

    let track: DetectedTrack;
    try {
      track = await this.deps.detect(this.source);
    } catch (err) {
      track = {
        title: null,
        artist: null,
        album: null,
        isPlaying: false,
        source: null,
        playbackApp: null,
        error: String(err),
        diagnostics: null,
      };
    }

    // Sequence protection: if a newer detection already completed, discard this
    // (stale) result so an old poll can never overwrite a newer one.
    if (mySeq < this.lastAppliedSeq) {
      this.log(`[discard] stale detect #${mySeq} (newer #${this.lastAppliedSeq} already applied)`);
      this.inFlight = false;
      this.afterTick();
      return;
    }
    this.lastAppliedSeq = mySeq;
    this.lastCheckedAt = Date.now();
    this.detectedRaw = track;

    try {
      await this.process(track, mySeq, force);
    } finally {
      this.inFlight = false;
      this.afterTick();
    }
  }

  private afterTick(): void {
    if (!this.running) return;
    // If a forced sync arrived mid-tick, honor it now; else normal cadence.
    this.scheduleTick(this.forceNext ? 0 : POLL_MS);
    this.emit();
  }

  private async process(track: DetectedTrack, seq: number, force: boolean): Promise<void> {
    const usable = Boolean(track.title && track.artist);

    if (!usable) {
      this.log(`[detect #${seq}] ${track.source ?? this.source}: (no track)`);
      const sinceValid = this.lastValidAt ? Date.now() - this.lastValidAt : Infinity;
      if (this.last && sinceValid < STALE_MS) {
        // 1–2 brief failures: keep the last track, just flag it.
        this.state = "delayed";
      } else {
        if (this.last) {
          this.log(`[stale] no valid track for ${Math.round(STALE_MS / 1000)}s — pausing source`);
        }
        this.last = null; // stop re-sending a stale song
        // Paused once we've ever had a track this session; only "searching"
        // before the very first detection (or right after a source switch).
        this.state = this.lastValidAt > 0 ? "paused" : "searching";
      }
      return;
    }

    const title = track.title!.trim();
    const artist = track.artist!.trim();
    const normKey = `${normalize(title)} || ${normalize(artist)}`;
    this.lastValidAt = Date.now();

    const changed = !this.last || this.last.normKey !== normKey;
    const prevUnsent = !!this.last && this.last.normKey === normKey && this.last.sentAt === null;
    const heartbeatDue =
      !!this.last &&
      this.last.normKey === normKey &&
      this.last.sentAt !== null &&
      Date.now() - this.last.sentAt >= HEARTBEAT_MS;

    if (changed) {
      this.log(`[detect #${seq}] ${track.source ?? this.source}: "${title}" / "${artist}"`);
      if (this.last) this.log(`[compare] changed from "${this.last.title}" / "${this.last.artist}"`);
      else this.log(`[compare] first track this session`);
      this.last = {
        normKey,
        title,
        artist,
        trackId: null,
        detectedAt: Date.now(),
        sentAt: null,
      };
      await this.maybeSend(track, title, artist, "new", force);
    } else if (force) {
      this.log(`[sync-now] resending "${title}" / "${artist}"`);
      // A DJ pressing Sync Now is an explicit instruction — bypass the backoff.
      await this.maybeSend(track, title, artist, "sync-now", true);
    } else if (prevUnsent) {
      this.log(`[retry] previous send did not confirm — resending "${title}"`);
      await this.maybeSend(track, title, artist, "retry", false);
    } else if (heartbeatDue) {
      this.log(`[heartbeat] 30s resync "${title}" / "${artist}"`);
      await this.maybeSend(track, title, artist, "heartbeat", false);
    } else {
      this.log(`[skip] duplicate "${title}" / "${artist}"`);
      this.state = "active";
    }
  }

  /**
   * Send unless the failure backoff is still holding us off.
   *
   * Detection keeps running at POLL_MS so the UI stays live and local-only
   * state is accurate; it is only the network send that backs off. Skipping
   * leaves `sentAt` null, so the existing prevUnsent path retries the track as
   * soon as the window expires — nothing is lost by waiting.
   */
  private async maybeSend(
    track: DetectedTrack,
    title: string,
    artist: string,
    reason: Reason,
    bypassBackoff: boolean
  ): Promise<void> {
    if (!bypassBackoff && this.nextSendAt > 0 && Date.now() < this.nextSendAt) {
      const waitS = Math.ceil((this.nextSendAt - Date.now()) / 1000);
      this.log(
        `[backoff] holding ${reason} send ~${waitS}s (${this.backoffIdx} consecutive failure(s))`
      );
      return;
    }
    await this.send(track, title, artist, reason);
  }

  private async send(track: DetectedTrack, title: string, artist: string, reason: Reason): Promise<void> {
    if (!this.config) return;
    this.state = "sending";
    this.emit();
    const result = await this.deps.send(this.config, {
      title,
      artist,
      ...(track.playbackApp ? { playback_app: track.playbackApp } : {}),
    });
    const normKey = `${normalize(title)} || ${normalize(artist)}`;
    if (result.ok) {
      if (this.last && this.last.normKey === normKey) this.last.sentAt = Date.now();
      this.clearBackoff();
      this.log(`[send] success (${reason})`);
    } else {
      // Leave sentAt = null so the next tick retries (prevUnsent path), and
      // hold that retry off for the next backoff step. Without this the loop
      // retried every POLL_MS (3s) forever: with thousands of DJs running
      // Bridge, a backend blip would become a sustained 3s-interval stampede
      // from every client at once, exactly when it can least take the load.
      const delay = BACKOFF_MS[Math.min(this.backoffIdx, BACKOFF_MS.length - 1)];
      this.backoffIdx += 1;
      this.nextSendAt = Date.now() + delay;
      this.log(
        `[send] failed (${reason}) status=${result.httpStatus} — retrying in ${delay / 1000}s`
      );
    }
    this.onIngest?.(result.ok);
    this.state = "active";
  }

  // ── Status / logging ──────────────────────────────────────────────────────
  private emit(): void {
    this.onStatus?.({
      running: this.running,
      source: this.source,
      state: this.state,
      detected: this.detectedRaw,
      lastCheckedAt: this.lastCheckedAt,
      lastSentAt: this.last?.sentAt ?? this.lastSentAtMemo,
      lastSentTrack: this.last && this.last.sentAt ? { title: this.last.title, artist: this.last.artist } : this.lastSentTrackMemo,
      online: this.online,
    });
  }

  // Remember the last successful send across track changes for the UI.
  private lastSentAtMemo: number | null = null;
  private lastSentTrackMemo: { title: string; artist: string } | null = null;

  private log(line: string): void {
    this.deps.log(line);
    if (line.startsWith("[send] success")) {
      this.lastSentAtMemo = Date.now();
      if (this.last) this.lastSentTrackMemo = { title: this.last.title, artist: this.last.artist };
    }
  }
}
