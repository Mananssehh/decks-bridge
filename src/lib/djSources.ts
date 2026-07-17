import type { DetectedTrack } from "./playback";

/** Apps Bridge can detect and report metadata for. */
export const SUPPORTED_DJ_APPS = [
  "Serato DJ Pro",
  "Rekordbox",
  "VirtualDJ",
  "djay Pro",
  "Engine DJ",
  "Spotify",
  "Apple Music",
] as const;

/** Sources that mean "app detected but can't get metadata — suggest Manual Mode". */
const NO_METADATA_SOURCES = new Set([
  "djay_no_metadata",
  "djay_needs_accessibility",
  "serato_no_metadata",
  "serato_no_track",
  "rekordbox_no_track",
  "virtualdj_no_metadata",
  "forced_no_track",
]);

const APP_ALIASES: Record<string, string> = {
  serato: "Serato DJ Pro",
  "serato dj": "Serato DJ Pro",
  "serato dj pro": "Serato DJ Pro",
  rekordbox: "Rekordbox",
  virtualdj: "VirtualDJ",
  "virtual dj": "VirtualDJ",
  djay: "djay Pro",
  "djay pro": "djay Pro",
  "djay pro ai": "djay Pro",
  "engine dj": "Engine DJ",
  enginedj: "Engine DJ",
  spotify: "Spotify",
  music: "Apple Music",
  "apple music": "Apple Music",
};

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/\.exe$/i, "").trim();
}

/** Human-readable source label for status bar and Now Playing card. */
export function resolveSourceLabel(
  detected: DetectedTrack | null,
  manualMode: boolean
): string {
  if (manualMode) return "Manual";
  if (!detected) return "Scanning…";

  // Permission-blocked sources still name the real active app
  if (detected.source === "apple_music_permission") return "Apple Music";
  if (detected.source === "spotify_permission")      return "Spotify";

  // Serato DJ Pro via SQLite history (a real, working source)
  if (detected.source === "serato_pro_sqlite")     return "Serato DJ Pro";
  // rekordbox via Accessibility deck text (a real, working source)
  if (detected.source === "rekordbox_ax")          return "rekordbox";

  // Source-specific labels for "no metadata" states
  if (detected.source === "serato_no_metadata")    return "Serato DJ Pro";
  if (detected.source === "serato_no_track")       return "Serato DJ Pro";
  if (detected.source === "rekordbox_no_track")    return "rekordbox";
  if (detected.source === "virtualdj_no_metadata") return "VirtualDJ";
  // Forced source selected but that app has no track yet — name the app.
  if (detected.source === "forced_no_track" && detected.playbackApp) return detected.playbackApp;
  if (detected.source === "djay_no_metadata")      return "djay Pro";
  if (detected.source === "djay_needs_accessibility") return "djay Pro";
  if (detected.source === "none")                  return "None";

  // If we have a playback app name, map it to a friendly label
  const app = detected.playbackApp?.trim();
  if (app) {
    const key = normalizeKey(app);
    for (const [alias, label] of Object.entries(APP_ALIASES)) {
      if (key.includes(alias)) return label;
    }
    return app;
  }

  // Source path fallbacks
  if (detected.source === "smtc")              return "System Now Playing";
  if (detected.source === "media_remote")      return "System Now Playing";
  if (detected.source === "applescript_music") return "Apple Music";
  if (detected.source === "applescript_spotify") return "Spotify";
  if (detected.source === "applescript_djay")  return "djay Pro";

  return "Scanning…";
}

export type AppSupport = "full" | "partial" | "unavailable";

export interface AppCompatibility {
  app: string;
  support: AppSupport;
  note: string;
}

/** Returns compatibility info when a detected app can't provide metadata. */
export function getAppCompatibility(
  detected: DetectedTrack | null
): AppCompatibility | null {
  if (!detected?.source) return null;

  if (detected.source === "djay_needs_accessibility") {
    return {
      app: "djay Pro",
      support: "partial",
      note: detected.error ??
        "djay Pro is detected, but macOS doesn't expose its track info to apps. Grant Decks Bridge Accessibility permission (System Settings → Privacy & Security → Accessibility), then click Refresh. Or use Manual Mode.",
    };
  }
  if (detected.source === "djay_no_metadata") {
    return {
      app: detected.playbackApp ?? "djay Pro",
      support: "partial",
      note: detected.error ??
        "djay Pro is open but no track is readable yet. Load a track into a deck and make sure the djay window is visible, then click Refresh.",
    };
  }
  if (detected.source === "serato_no_track") {
    return {
      app: "Serato DJ Pro",
      support: "partial",
      note: detected.error ??
        "Serato DJ Pro is open but no deck is playing. Load and play a track — Decks Bridge reads it from Serato's history.",
    };
  }
  if (detected.source === "serato_no_metadata") {
    return {
      app: "Serato DJ Pro",
      support: "unavailable",
      note: "Serato DJ Pro does not publish track metadata to macOS Now Playing. Use Manual Mode, or enable a supported metadata output plugin.",
    };
  }
  if (detected.source === "rekordbox_no_track") {
    return {
      app: "rekordbox",
      support: "partial",
      note: detected.error ??
        "rekordbox is open but no track is readable yet. Load and play a track on a deck — Decks Bridge reads it from rekordbox's deck display.",
    };
  }
  if (detected.source === "virtualdj_no_metadata") {
    return {
      app: "VirtualDJ",
      support: "unavailable",
      note: "VirtualDJ does not publish track metadata to macOS Now Playing. Use Manual Mode to send tracks to Decks.",
    };
  }
  if (detected.source === "forced_no_track") {
    return {
      app: detected.playbackApp ?? "Selected source",
      support: "partial",
      note: detected.error ??
        "The source you selected has no track playing yet. Play a track there, or switch the source back to Auto.",
    };
  }

  return null;
}

export function detectionUnavailable(track: DetectedTrack): boolean {
  if (!track.error) return false;
  const lower = track.error.toLowerCase();
  return (
    lower.includes("requires macos") ||
    lower.includes("not supported on this platform") ||
    lower.includes("could not access windows media")
  );
}

export function isNoMetadataSource(track: DetectedTrack | null): boolean {
  return Boolean(track?.source && NO_METADATA_SOURCES.has(track.source));
}

export function shouldSuggestManualFallback(
  track: DetectedTrack | null,
  consecutiveEmptyPolls: number
): boolean {
  if (!track) return false;
  if (detectionUnavailable(track)) return true;
  if (isNoMetadataSource(track)) return true;
  if (track.source === "none" && consecutiveEmptyPolls >= 6) return true;
  if (track.error && consecutiveEmptyPolls >= 3) return true;
  return false;
}
