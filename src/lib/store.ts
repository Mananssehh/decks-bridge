const CONFIG_KEY = "decks_bridge_config";

export interface Config {
  url: string;
  token: string;
  eventId: string;
  eventName?: string;
}

function isValidConfig(v: unknown): v is Config {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.url === "string" && c.url.length > 0 &&
    typeof c.token === "string" && c.token.length > 0 &&
    typeof c.eventId === "string" && c.eventId.length > 0
  );
}

export function saveConfig(config: Config): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    console.log("[store] config saved — eventId:", config.eventId);
  } catch (err) {
    console.error("[store] saveConfig failed:", err);
  }
}

export function loadConfig(): Config | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) {
      console.log("[store] no saved config");
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!isValidConfig(parsed)) {
      console.warn("[store] saved config failed shape validation — clearing", parsed);
      localStorage.removeItem(CONFIG_KEY);
      return null;
    }
    console.log("[store] config loaded — eventId:", parsed.eventId, "eventName:", parsed.eventName ?? "(none)");
    return parsed;
  } catch (err) {
    console.error("[store] loadConfig error — clearing corrupt data:", err);
    try { localStorage.removeItem(CONFIG_KEY); } catch { /* ignore */ }
    return null;
  }
}

export function clearConfig(): void {
  try {
    localStorage.removeItem(CONFIG_KEY);
    console.log("[store] config cleared");
  } catch (err) {
    console.error("[store] clearConfig failed:", err);
  }
}

/** Nuke all app state and hard-reload. Used by the reset button. */
export function resetAndReload(): void {
  console.log("[store] resetAndReload — clearing localStorage");
  try { localStorage.clear(); } catch { /* ignore */ }
  window.location.reload();
}

export interface ConfigDebug {
  eventId: string;
  eventName: string | undefined;
  endpointHost: string;
  hasToken: boolean;
}

export function configDebug(config: Config): ConfigDebug {
  let endpointHost = "(fallback)";
  try {
    if (config.url && config.url.startsWith("https://")) {
      endpointHost = new URL(config.url).host;
    }
  } catch {
    endpointHost = "(invalid url)";
  }
  return {
    eventId: config.eventId,
    eventName: config.eventName,
    endpointHost,
    hasToken: Boolean(config.token && config.token.length > 0),
  };
}

// ── Now Playing source preference ─────────────────────────────────────────────

import type { NowPlayingSource } from "./playback";

const SOURCE_KEY = "decks_bridge_now_playing_source";

const VALID_SOURCES: NowPlayingSource[] = [
  "auto", "djay", "serato", "rekordbox", "apple_music", "spotify", "manual",
];

export function loadNowPlayingSource(): NowPlayingSource {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (raw && (VALID_SOURCES as string[]).includes(raw)) {
      return raw as NowPlayingSource;
    }
  } catch { /* ignore */ }
  return "auto";
}

export function saveNowPlayingSource(source: NowPlayingSource): void {
  try {
    localStorage.setItem(SOURCE_KEY, source);
  } catch { /* ignore */ }
}
