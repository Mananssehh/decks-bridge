const SETTINGS_KEY = "decks_bridge_settings";

export interface AppSettings {
  startWithOs?: boolean;
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as AppSettings;
  } catch {
    return {};
  }
}

export function saveSettings(settings: AppSettings): void {
  // Guarded like loadSettings: this is called from a .then() during mount, so
  // a full-disk / disabled-storage throw would surface as an unhandled
  // rejection. A settings write failing is never worth breaking startup over.
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn("[platform] saveSettings failed (non-fatal):", err);
  }
}

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
}

export function isMacOs(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Mac OS");
}

export function nowPlayingHelpText(): string {
  if (isWindows()) {
    return "No track detected. Start playback in Spotify, Apple Music, Serato DJ Pro, Rekordbox, VirtualDJ, or any app that appears in Windows media controls.";
  }
  return "No track detected. Start playback in Apple Music, Spotify, Serato DJ Pro, Rekordbox, VirtualDJ, djay Pro, or any app that appears in your Mac's Now Playing controls.";
}

export function supportedDjAppsLine(): string {
  return "Serato DJ Pro · Rekordbox · VirtualDJ · djay Pro · Engine DJ · Spotify";
}
