import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body: string | null;
  date: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export type CheckResult =
  | { status: "available"; info: UpdateInfo }
  | { status: "up-to-date"; currentVersion: string }
  | { status: "error"; message: string };

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Check the update manifest endpoint for a newer version.
 * Never throws — returns a typed result instead.
 *
 * In development (Vite dev server) the check is skipped because the
 * release endpoint doesn't exist yet — no false errors shown to DJs.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  // Skip in dev — the placeholder endpoint will always 404.
  if (import.meta.env.DEV) {
    const current = await getCurrentVersion();
    console.log("[updater] dev mode — skipping update check");
    return { status: "up-to-date", currentVersion: current };
  }

  try {
    const info = await invoke<UpdateInfo | null>("check_for_update");
    if (info) {
      console.log(
        `[updater] update available: ${info.currentVersion} → ${info.version}`
      );
      return { status: "available", info };
    }
    const current = await getCurrentVersion();
    console.log(`[updater] up-to-date (${current})`);
    return { status: "up-to-date", currentVersion: current };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Translate the Tauri updater's generic fetch error into something actionable.
    const isEndpointError =
      raw.toLowerCase().includes("fetch") ||
      raw.toLowerCase().includes("json") ||
      raw.toLowerCase().includes("network") ||
      raw.toLowerCase().includes("remote");
    const msg = isEndpointError
      ? "Couldn't reach the update server. Check your internet connection and try again."
      : raw;
    console.warn("[updater] check failed:", raw);
    return { status: "error", message: msg };
  }
}

/**
 * Download and install the pending update, reporting byte progress.
 * Call relaunchApp() after this resolves to apply the update.
 */
export async function installUpdate(
  onProgress?: (progress: UpdateProgress) => void
): Promise<void> {
  // Listen for progress events emitted by the Rust side.
  const unlisten = onProgress
    ? await listen<UpdateProgress>("update://progress", (event) => {
        onProgress(event.payload);
      })
    : null;

  try {
    await invoke("install_update");
  } finally {
    unlisten?.();
  }
}

/**
 * Relaunch the app to apply an installed update.
 */
export async function relaunchApp(): Promise<void> {
  console.log("[updater] relaunching…");
  await relaunch();
}

/**
 * Return the current app version from Tauri metadata.
 */
export async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}
