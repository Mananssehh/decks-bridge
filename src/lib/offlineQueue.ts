import type { Config } from "./store";
import type { TrackPayload, SendResult } from "./api";
import { sendNowPlaying } from "./api";
import { logDiagnostic } from "./log";
import { friendlyIngestError } from "./errors";

const QUEUE_KEY = "decks_bridge_offline_queue";
const MAX_QUEUE = 200;

export interface QueuedTrack {
  id: string;
  queuedAt: string;
  track: TrackPayload;
  source: string;
}

function readQueue(): QueuedTrack[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedTrack[]): void {
  const capped = items.slice(-MAX_QUEUE);
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(capped));
  } catch (err) {
    // Storage full or disabled. Throwing here would escape through the sync
    // engine's send path as an unhandled rejection, so shed the oldest half and
    // retry once instead. Losing the oldest entries beats losing the queue —
    // and during a live set the newest tracks are the ones that still matter.
    try {
      const half = capped.slice(Math.floor(capped.length / 2));
      localStorage.setItem(QUEUE_KEY, JSON.stringify(half));
      void logDiagnostic(
        "offline",
        `queue storage full — dropped ${capped.length - half.length} oldest entries`
      ).catch(() => undefined);
    } catch {
      void logDiagnostic("offline", `queue storage unavailable: ${String(err)}`).catch(
        () => undefined
      );
    }
  }
}

export function getQueueLength(): number {
  return readQueue().length;
}

export function enqueueTrack(track: TrackPayload, source = "decks_bridge"): void {
  const queue = readQueue();
  const key = `${track.title}||${track.artist}`;

  // Dedupe against the MOST RECENT entry only. The 3s detector re-offers the
  // same track every tick while offline, which must not spam the queue — but a
  // DJ genuinely replaying a track later in the set is real history. Comparing
  // against the whole queue silently dropped those replays and left the event
  // showing the wrong final track once the queue flushed.
  const last = queue[queue.length - 1];
  if (last && `${last.track.title}||${last.track.artist}` === key) return;

  queue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: new Date().toISOString(),
    track,
    source,
  });
  writeQueue(queue);
  logDiagnostic("offline", `queued ${track.title} (queue=${queue.length})`).catch(() => undefined);
}

export async function flushOfflineQueue(config: Config): Promise<number> {
  if (!navigator.onLine) return 0;

  const queue = readQueue();
  if (queue.length === 0) return 0;

  const remaining: QueuedTrack[] = [];
  let sent = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const result = await sendNowPlaying(config, item.track, item.source);

    if (result.ok) {
      sent++;
      continue;
    }

    // Network down or auth rejected: stop flushing and KEEP this item plus
    // everything after it. Retrying the rest now would fail the same way, and
    // dropping them would silently destroy the DJ's set history — the whole
    // reason the queue exists. queue.slice(i) is the untried remainder.
    if (result.httpStatus === 0 || result.httpStatus === 401 || result.httpStatus === 403) {
      remaining.push(...queue.slice(i));
      break;
    }

    // Any other error (4xx/5xx on this specific track): keep it for a later
    // attempt but carry on — the next track may well succeed.
    remaining.push(item);
  }

  writeQueue(remaining);
  if (sent > 0) {
    logDiagnostic("offline", `flushed ${sent} queued track(s)`).catch(() => undefined);
  }
  return sent;
}

/** Send to Decks, queue locally when offline or unreachable. */
export async function sendTrackResilient(
  config: Config,
  track: TrackPayload,
  source = "decks_bridge"
): Promise<SendResult> {
  if (!navigator.onLine) {
    enqueueTrack(track, source);
    return {
      ok: true,
      message: "Offline — track saved. Will upload when you're back online.",
      requestUrl: config.url,
      httpStatus: 0,
      responseBody: "queued",
    };
  }

  const result = await sendNowPlaying(config, track, source);
  if (result.ok) {
    return { ...result, message: "Track sent to Decks." };
  }

  if (result.httpStatus === 0) {
    enqueueTrack(track, source);
    return {
      ok: true,
      message: "Unable to connect. Track queued — retrying automatically.",
      requestUrl: result.requestUrl,
      httpStatus: 0,
      responseBody: "queued",
    };
  }

  return {
    ...result,
    message: friendlyIngestError(result.httpStatus, result.responseBody),
  };
}
