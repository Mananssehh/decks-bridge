import { getCurrentVersion, UPDATE_MANIFEST_URL } from "./updater";
import { getLogDir } from "./log";
import { configDebug, type Config } from "./store";
import { getQueueLength } from "./offlineQueue";
import { isMacOs, isWindows } from "./platform";
import type { ConnectionStatus } from "./connection";

export interface DiagnosticsSnapshot {
  version: string;
  platform: string;
  osVersion: string;
  pairStatus: string;
  eventId: string;
  eventName: string;
  connectionStatus: ConnectionStatus;
  supabaseLatencyMs: number | null;
  lastIngestAt: string | null;
  tokenStatus: string;
  updateChannel: string;
  logsFolder: string | null;
  offlineQueue: number;
  pollIntervalMs: number;
  autoDetect: boolean;
  sourceLabel: string;
}

export async function gatherDiagnostics(opts: {
  config: Config;
  connectionStatus: ConnectionStatus;
  supabaseLatencyMs: number | null;
  lastIngestAt: string | null;
  pollIntervalMs: number;
  autoDetect: boolean;
  sourceLabel: string;
}): Promise<DiagnosticsSnapshot> {
  const version = await getCurrentVersion();
  const logsFolder = await getLogDir().catch(() => null);
  const dbg = configDebug(opts.config);

  let platform = "Unknown";
  if (isMacOs()) platform = "macOS";
  else if (isWindows()) platform = "Windows";

  return {
    version,
    platform,
    osVersion: navigator.userAgent,
    pairStatus: dbg.hasToken ? "paired" : "missing token",
    eventId: dbg.eventId,
    eventName: dbg.eventName ?? "(none)",
    connectionStatus: opts.connectionStatus,
    supabaseLatencyMs: opts.supabaseLatencyMs,
    lastIngestAt: opts.lastIngestAt,
    tokenStatus: dbg.hasToken ? "present" : "missing",
    updateChannel: UPDATE_MANIFEST_URL,
    logsFolder,
    offlineQueue: getQueueLength(),
    pollIntervalMs: opts.pollIntervalMs,
    autoDetect: opts.autoDetect,
    sourceLabel: opts.sourceLabel,
  };
}

export function formatDiagnosticsReport(d: DiagnosticsSnapshot): string {
  return [
    "Decks Bridge Diagnostics",
    "========================",
    `Version: ${d.version}`,
    `Platform: ${d.platform}`,
    `OS: ${d.osVersion}`,
    `Pair status: ${d.pairStatus}`,
    `Event ID: ${d.eventId}`,
    `Event name: ${d.eventName}`,
    `Connection: ${d.connectionStatus}`,
    `Current source: ${d.sourceLabel}`,
    `Supabase latency: ${d.supabaseLatencyMs ?? "—"} ms`,
    `Last ingest: ${d.lastIngestAt ?? "—"}`,
    `Token: ${d.tokenStatus}`,
    `Update channel: ${d.updateChannel}`,
    `Logs folder: ${d.logsFolder ?? "—"}`,
    `Offline queue: ${d.offlineQueue}`,
    `Poll interval: ${d.pollIntervalMs} ms`,
    `Auto detect: ${d.autoDetect ? "on" : "off"}`,
  ].join("\n");
}
