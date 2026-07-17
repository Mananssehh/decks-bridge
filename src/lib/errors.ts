/** Map raw errors to DJ-friendly copy — never show stack traces in the UI. */

export function friendlyNetworkError(raw?: string): string {
  if (!raw) return "Unable to connect. Retrying…";
  const lower = raw.toLowerCase();
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("failed to fetch")) {
    return "Unable to connect. Retrying…";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Connection timed out. Retrying…";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized")) {
    return "Your Bridge session expired. Re-pair from your event dashboard.";
  }
  if (lower.includes("404")) {
    return "Unable to reach Decks. Retrying…";
  }
  return "Something went wrong. Retrying…";
}

export function friendlyIngestError(httpStatus: number, body: string): string {
  if (httpStatus === 0) return "Offline — track saved and will upload when you're back online.";
  if (httpStatus === 401 || httpStatus === 403) {
    return "Bridge session expired. Use Reconfigure to pair again.";
  }
  if (httpStatus >= 500) return "Decks is temporarily unavailable. Retrying…";
  return friendlyNetworkError(body);
}

export function friendlyDetectionMessage(error: string | null): string | null {
  if (!error) return null;
  const lower = error.toLowerCase();
  if (lower.includes("requires macos") || lower.includes("not supported on this platform")) {
    return "Automatic detection isn't available here. Use Manual mode below.";
  }
  // Automation-permission errors carry actionable System Settings steps — show verbatim.
  if (lower.includes("needs permission") || lower.includes("automation")) {
    return error;
  }
  if (lower.includes("djay") && lower.includes("metadata")) {
    return "djay isn't sharing track info yet. Start playback or switch to Manual mode.";
  }
  return "Couldn't read Now Playing. Try Manual mode if this keeps happening.";
}

export function friendlyUpdateError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("network") || lower.includes("fetch")) {
    return "Couldn't download the update. Check your connection and try again.";
  }
  return "Update installation failed. Try again after your set.";
}

export function friendlyPairError(raw: string): string {
  if (!raw) return "Unable to pair. Check your code and try again.";
  const lower = raw.toLowerCase();
  if (lower.includes("network") || lower.includes("connection")) {
    return "Unable to connect. Check your internet and try again.";
  }
  return raw;
}
