import { invoke } from "@tauri-apps/api/core";

export interface DetectedTrack {
  title: string | null;
  artist: string | null;
  album: string | null;
  isPlaying: boolean;
  /** Detection path used: "media_remote" | "applescript" | "none". */
  source: string | null;
  /** Human-readable name of the app currently playing, e.g. "djay Pro", "Spotify". */
  playbackApp: string | null;
  error: string | null;
  /** Raw diagnostic string from Rust — shown in the Bridge debug panel. */
  diagnostics: string | null;
}

export async function detectNowPlaying(): Promise<DetectedTrack> {
  try {
    const raw = await invoke<DetectedTrack>("get_now_playing");
    return raw;
  } catch (err) {
    return {
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
}

/** User-selectable Now Playing source. "auto" runs the full priority pipeline;
 *  a specific source is forced (no silent fallback); "manual" disables detection. */
export type NowPlayingSource =
  | "auto"
  | "djay"
  | "serato"
  | "rekordbox"
  | "apple_music"
  | "spotify"
  | "manual";

/**
 * Detection honoring the user's chosen source. Pass "auto" for the priority
 * pipeline, or a specific source to force it (returns a "forced_no_track"
 * warning instead of falling back when that app has no track). "manual" should
 * be handled by the caller (no polling) — it maps to auto here as a safety net.
 */
export async function detectNowPlayingSource(source: NowPlayingSource): Promise<DetectedTrack> {
  try {
    const arg = source === "manual" ? "auto" : source;
    return await invoke<DetectedTrack>("get_now_playing_source", { source: arg });
  } catch (err) {
    return {
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
}

/**
 * Runs the full multi-method Now Playing diagnostic probe. Writes the raw report
 * to the app log dir. Returns the raw text so the UI can display it.
 */
export async function runNowPlayingDiagnostic(): Promise<string> {
  try {
    return await invoke<string>("debug_now_playing");
  } catch (err) {
    return `Diagnostic failed: ${String(err)}`;
  }
}

export interface DjayCheckResult {
  accessibilityTrusted: boolean;
  djayRunning: boolean;
  pids: number[];
  title: string | null;
  artist: string | null;
  source: string;
  appPath: string;
  expectedPath: string;
  correctLocation: boolean;
  /** "detected" | "not_trusted" | "djay_not_running" | "djay_no_track" | "wrong_location" | "unsupported" */
  status: string;
  report: string;
}

/**
 * One-click djay Pro detection check (same logic as `--check-djay`). Runs under
 * the app's real identity; writes the report to the app log dir (no Desktop TCC
 * issue). Returns structured results for the Diagnostics UI.
 */
export async function checkDjay(): Promise<DjayCheckResult> {
  return await invoke<DjayCheckResult>("check_djay");
}

export interface SeratoCheckResult {
  seratoFound: boolean;
  edition: string;
  bundleId: string;
  pid: number | null;
  appPath: string;
  accessibilityTrusted: boolean;
  mediaRemoteResult: string;
  axElementCount: number;
  readableText: boolean;
  dbPath: string;
  dbReadable: boolean;
  latestHistoryId: number | null;
  deck: string | null;
  isPlaying: boolean;
  title: string | null;
  artist: string | null;
  /** Detection method, e.g. "SQLite History". */
  method: string;
  /** "detected" | "serato_not_running" | "not_exposed" | "unsupported" */
  status: string;
  verdict: string;
  report: string;
}

/**
 * Diagnostic-only Serato check. Serato is NOT a supported source — this reports
 * honestly whether Serato exposes track metadata (it does not, via MediaRemote
 * or Accessibility). Writes the report to the app log dir.
 */
export async function checkSerato(): Promise<SeratoCheckResult> {
  return await invoke<SeratoCheckResult>("check_serato");
}

export interface RekordboxCheckResult {
  rekordboxRunning: boolean;
  bundleId: string;
  pid: number | null;
  appPath: string;
  version: string;
  accessibilityTrusted: boolean;
  mediaRemoteResult: string;
  axElementCount: number;
  dbPath: string;
  dbReadable: boolean;
  dbEncrypted: boolean;
  title: string | null;
  artist: string | null;
  method: string;
  /** "detected" | "rekordbox_not_running" | "not_readable" | "unsupported" */
  status: string;
  verdict: string;
  report: string;
}

/**
 * Diagnostic-only rekordbox check. rekordbox is NOT a supported source — it
 * doesn't publish Now Playing, exposes no Accessibility text, and stores its
 * library/history in an encrypted database. Reports honestly why.
 */
export async function checkRekordbox(): Promise<RekordboxCheckResult> {
  return await invoke<RekordboxCheckResult>("check_rekordbox");
}
