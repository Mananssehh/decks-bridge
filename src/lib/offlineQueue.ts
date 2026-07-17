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
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-MAX_QUEUE)));
}

export function getQueueLength(): number {
  return readQueue().length;
}

export function enqueueTrack(track: TrackPayload, source = "decks_bridge"): void {
  const queue = readQueue();
  const key = `${track.title}||${track.artist}`;
  if (queue.some((q) => `${q.track.title}||${q.track.artist}` === key)) return;

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

  for (const item of queue) {
    const result = await sendNowPlaying(config, item.track, item.source);
    if (result.ok) {
      sent++;
    } else if (result.httpStatus === 0) {
      remaining.push(item);
      break;
    } else if (result.httpStatus === 401 || result.httpStatus === 403) {
      remaining.push(...queue.slice(queue.indexOf(item)));
      break;
    } else {
      remaining.push(item);
    }
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
