import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Where installed builds look for updates. Must match
 * plugins.updater.endpoints in src-tauri/tauri.conf.json (a test enforces it).
 * GitHub serves this file from the newest *published, non-pre-release*
 * release, so pushes to main — and pre-release tags — never reach DJs.
 */
export const UPDATE_MANIFEST_URL =
  "https://github.com/Mananssehh/decks-bridge/releases/latest/download/latest.json";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Release notes, shown as plain text. */
  body: string | null;
}

export interface UpdateProgress {
  /** Bytes downloaded so far (cumulative). */
  downloaded: number;
  /** Total size when the server reports it. */
  total: number | null;
}

/** Mirrors UpdateErrorKind in src-tauri/src/updater.rs. */
export type UpdateErrorKind =
  | "network"
  | "no-release"
  | "invalid-release"
  | "signature"
  | "permission"
  | "busy"
  | "failed";

export interface UpdateFailure {
  kind: UpdateErrorKind;
  /** Raw detail for logs/diagnostics — never shown to the DJ as-is. */
  message: string;
}

export type CheckResult =
  | { status: "available"; info: UpdateInfo }
  | { status: "up-to-date"; currentVersion: string }
  | { status: "disabled" }
  | { status: "error"; error: UpdateFailure };

export interface InstallHandlers {
  onProgress?: (progress: UpdateProgress) => void;
  /** Download finished and its signature verified; installing now. */
  onInstalling?: () => void;
}

const ERROR_KINDS: readonly UpdateErrorKind[] = [
  "network",
  "no-release",
  "invalid-release",
  "signature",
  "permission",
  "busy",
  "failed",
];

/**
 * Normalizes an invoke() rejection. Our commands reject with
 * `{ kind, message }`; IPC-level failures reject with a plain string.
 */
export function toUpdateFailure(err: unknown): UpdateFailure {
  if (err && typeof err === "object") {
    const { kind, message } = err as Record<string, unknown>;
    const text = typeof message === "string" ? message : "";
    if (typeof kind === "string" && (ERROR_KINDS as readonly string[]).includes(kind)) {
      return { kind: kind as UpdateErrorKind, message: text };
    }
    if (text) return { kind: "failed", message: text };
  }
  return { kind: "failed", message: String(err) };
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Checks the release manifest for a newer stable version. Never throws.
 *
 * Skipped in development (`tauri dev`): a dev build must never try to replace
 * itself with a release build.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  if (import.meta.env.DEV) return { status: "disabled" };

  try {
    const info = await invoke<UpdateInfo | null>("check_for_update");
    if (info) return { status: "available", info };
    return { status: "up-to-date", currentVersion: await getCurrentVersion() };
  } catch (err) {
    return { status: "error", error: toUpdateFailure(err) };
  }
}

/**
 * Downloads, verifies and installs the update found by the last check.
 * Rejects with an UpdateFailure. Call relaunchApp() once it resolves (macOS);
 * on Windows the installer closes and reopens the app itself.
 */
export async function installUpdate(handlers: InstallHandlers = {}): Promise<void> {
  const unlisteners = await Promise.all([
    listen<UpdateProgress>("update://progress", (e) => handlers.onProgress?.(e.payload)),
    listen("update://installing", () => handlers.onInstalling?.()),
  ]);
  try {
    await invoke("install_update");
  } catch (err) {
    throw toUpdateFailure(err);
  } finally {
    unlisteners.forEach((unlisten) => unlisten());
  }
}

/** Restarts the app so the installed update takes effect. */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}

/** The running app's version from Tauri metadata. */
export async function getCurrentVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}
