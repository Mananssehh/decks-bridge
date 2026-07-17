const CONFIG_KEY = "decks_bridge_config";
/** Where an unreadable config is parked instead of being destroyed. */
const CONFIG_QUARANTINE_KEY = "decks_bridge_config_unreadable";

/**
 * Default ingest endpoint, used whenever a config has no usable `url`.
 *
 * Single definition on purpose: this was previously copy-pasted into api.ts,
 * connection.ts and pair.ts, so a future endpoint change had three places to
 * miss. Everything now imports it from here, next to the config it belongs to.
 */
export const INGEST_FALLBACK =
  "https://rwdgnapajxcxktmewlxb.supabase.co/functions/v1/now-playing-ingest";

/** Current on-disk config schema. Bump when the stored shape changes, and add
 *  a step to migrateConfig() — never widen the validator and drop old data. */
export const CONFIG_VERSION = 1;

export interface Config {
  url: string;
  token: string;
  eventId: string;
  eventName?: string;
}

/** The persisted envelope: a Config plus the schema version it was written at. */
interface StoredConfig extends Config {
  version: number;
}

/**
 * The only fields a pairing genuinely cannot be reconstructed without.
 *
 * `url` is deliberately NOT required: every send site already falls back to
 * INGEST_FALLBACK when it is missing, so a config without one is repairable
 * rather than fatal. Treating it as required is what made a recoverable config
 * look corrupt and forced DJs to pair again for no reason.
 */
function hasCredentials(c: Record<string, unknown>): boolean {
  return (
    typeof c.token === "string" && c.token.length > 0 &&
    typeof c.eventId === "string" && c.eventId.length > 0
  );
}

/**
 * Bring any previously-stored config up to CONFIG_VERSION.
 *
 * Returns null ONLY when the credentials are unrecoverable — that is the sole
 * case where a DJ has to pair again. Anything else is repaired in place.
 */
function migrateConfig(raw: unknown): StoredConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const c = { ...(raw as Record<string, unknown>) };

  // v0 = the unversioned config written by every build up to and including
  // 0.1.0. Field names are unchanged, so upgrading is a re-stamp: existing
  // pairings carry straight over and nobody is asked to pair again.
  const from = typeof c.version === "number" ? c.version : 0;

  if (!hasCredentials(c)) return null; // genuinely unrecoverable

  // Repair a missing/!https url rather than discarding the pairing over it.
  if (typeof c.url !== "string" || !c.url.startsWith("https://")) {
    c.url = INGEST_FALLBACK;
  }
  // Drop an eventName that is not a string rather than failing the whole config.
  if (c.eventName !== undefined && typeof c.eventName !== "string") {
    delete c.eventName;
  }

  c.version = CONFIG_VERSION;
  if (from !== CONFIG_VERSION) {
    console.log(`[store] migrated config v${from} → v${CONFIG_VERSION}`);
  }
  return c as unknown as StoredConfig;
}

export function saveConfig(config: Config): void {
  try {
    const stored: StoredConfig = { ...config, version: CONFIG_VERSION };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(stored));
    console.log("[store] config saved — eventId:", config.eventId);
  } catch (err) {
    console.error("[store] saveConfig failed:", err);
  }
}

export function loadConfig(): Config | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CONFIG_KEY);
  } catch (err) {
    console.error("[store] localStorage unavailable:", err);
    return null;
  }
  if (!raw) {
    console.log("[store] no saved config");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    quarantine(raw, "not valid JSON");
    return null;
  }

  const migrated = migrateConfig(parsed);
  if (!migrated) {
    // Credentials missing — the one case a re-pair is unavoidable. Park the
    // original rather than deleting it: it is the DJ's token, it may be
    // recoverable by support, and destroying it buys us nothing.
    quarantine(raw, "no usable credentials");
    return null;
  }

  // Persist the migrated shape so the upgrade happens once, not every launch.
  try {
    if (JSON.stringify(migrated) !== raw) {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(migrated));
    }
  } catch {
    /* non-fatal: we still return a usable config for this session */
  }

  console.log(
    "[store] config loaded — eventId:", migrated.eventId,
    "eventName:", migrated.eventName ?? "(none)"
  );
  const { version: _version, ...config } = migrated;
  return config;
}

/** Park an unusable config instead of destroying it. */
function quarantine(raw: string, reason: string): void {
  console.warn(`[store] config unreadable (${reason}) — quarantined, not deleted`);
  try {
    localStorage.setItem(CONFIG_QUARANTINE_KEY, raw);
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* ignore */
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
