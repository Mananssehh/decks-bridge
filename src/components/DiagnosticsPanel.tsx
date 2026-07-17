import { useEffect, useState } from "react";
import type { Config } from "../lib/store";
import {
  formatDiagnosticsReport,
  gatherDiagnostics,
  type DiagnosticsSnapshot,
} from "../lib/diagnostics";
import type { ConnectionStatus } from "../lib/connection";
import { isWindows } from "../lib/platform";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import { saveSettings } from "../lib/platform";
import { logDiagnostic } from "../lib/log";
import { type DetectedTrack, runNowPlayingDiagnostic } from "../lib/playback";
import DjayTest from "./DjayTest";
import SeratoTest from "./SeratoTest";
import RekordboxTest from "./RekordboxTest";

interface Props {
  config: Config;
  connectionStatus: ConnectionStatus;
  supabaseLatencyMs: number | null;
  lastIngestAt: string | null;
  pollIntervalMs: number;
  autoDetect: boolean;
  sourceLabel: string;
  detected: DetectedTrack | null;
  logDir: string | null;
  startWithOs: boolean;
  onStartWithOsChange: (v: boolean) => void;
  onOpenUpdates: () => void;
  onReset: () => void;
}

export default function DiagnosticsPanel({
  config,
  connectionStatus,
  supabaseLatencyMs,
  lastIngestAt,
  pollIntervalMs,
  autoDetect,
  sourceLabel,
  detected,
  logDir,
  startWithOs,
  onStartWithOsChange,
  onOpenUpdates,
  onReset,
}: Props) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);

  useEffect(() => {
    gatherDiagnostics({
      config,
      connectionStatus,
      supabaseLatencyMs,
      lastIngestAt,
      pollIntervalMs,
      autoDetect,
      sourceLabel,
    }).then(setSnapshot);
  }, [
    config,
    connectionStatus,
    supabaseLatencyMs,
    lastIngestAt,
    pollIntervalMs,
    autoDetect,
    sourceLabel,
  ]);

  async function copyDiagnostics() {
    if (!snapshot) return;
    const text = formatDiagnosticsReport(snapshot);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      logDiagnostic("diagnostics", "copied to clipboard").catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  async function runProbe() {
    setProbing(true);
    setProbeResult(null);
    try {
      const report = await runNowPlayingDiagnostic();
      setProbeResult(report);
      logDiagnostic("diagnostics", "ran now-playing probe").catch(() => undefined);
    } finally {
      setProbing(false);
    }
  }


  return (
    <div
      className="diagnostics-panel"
      style={{
        marginTop: 8,
        padding: "12px 14px",
        borderRadius: 8,
        background: "rgba(0,0,0,0.25)",
        fontSize: 11,
        fontFamily: "monospace",
        color: "var(--text-muted)",
        lineHeight: 1.7,
      }}
    >
      <div style={{ marginBottom: 8, fontWeight: 700, color: "var(--text)" }}>
        Diagnostics
      </div>

      <div>version: {snapshot?.version ?? "…"}</div>
      <div>platform: {snapshot?.platform ?? "…"}</div>
      <div style={{ wordBreak: "break-all" }}>os: {snapshot?.osVersion ?? "…"}</div>
      <div>pair: {snapshot?.pairStatus ?? "…"}</div>
      <div>event: {snapshot?.eventName ?? config.eventName ?? "(none)"}</div>
      <div>connection: {connectionStatus}</div>
      <div>source: {sourceLabel}</div>
      <div>supabase latency: {supabaseLatencyMs ?? "—"} ms</div>
      <div>last ingest: {lastIngestAt ?? "—"}</div>
      <div>token: {snapshot?.tokenStatus ?? "…"}</div>
      <div style={{ wordBreak: "break-all" }}>update: {snapshot?.updateChannel ?? "…"}</div>
      <div style={{ wordBreak: "break-all" }}>logs: {logDir ?? snapshot?.logsFolder ?? "—"}</div>
      <div>offline queue: {snapshot?.offlineQueue ?? 0}</div>
      <div>poll interval: {pollIntervalMs} ms</div>

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Detection</div>
        <div>active source: {detected?.source ?? "—"}</div>
        <div>playback app: {detected?.playbackApp ?? "—"}</div>
        <div>title: {detected?.title ?? "—"}</div>
        <div>artist: {detected?.artist ?? "—"}</div>
        <div>album: {detected?.album ?? "—"}</div>
        <div>playing: {detected ? String(detected.isPlaying) : "—"}</div>
        {detected?.error && (
          <div style={{ wordBreak: "break-word", color: "#f59e0b" }}>
            why: {detected.error}
          </div>
        )}
        {detected?.diagnostics && (
          <div style={{ wordBreak: "break-all", marginTop: 4, opacity: 0.8 }}>
            trace: {detected.diagnostics}
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <DjayTest />
      </div>

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <SeratoTest />
      </div>

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <RekordboxTest />
      </div>

      <button
        type="button"
        onClick={copyDiagnostics}
        style={{
          marginTop: 10,
          width: "100%",
          background: "var(--surface2)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "6px 10px",
          color: "var(--text)",
          fontSize: 11,
          cursor: "pointer",
        }}
      >
        {copied ? "Copied!" : "Copy diagnostics"}
      </button>

      <button
        type="button"
        onClick={runProbe}
        disabled={probing}
        style={{
          marginTop: 6,
          width: "100%",
          background: "var(--surface2)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "6px 10px",
          color: "var(--text)",
          fontSize: 11,
          cursor: probing ? "default" : "pointer",
        }}
        title="Tests every detection method and saves raw output to ~/Desktop/decks-bridge-diagnostics.txt"
      >
        {probing ? "Running probe…" : "Run Now Playing probe → Desktop"}
      </button>

      {probeResult && (
        <pre
          style={{
            marginTop: 8,
            maxHeight: 220,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "rgba(0,0,0,0.35)",
            borderRadius: 6,
            padding: 8,
            fontSize: 10,
            lineHeight: 1.5,
          }}
        >
          {probeResult}
        </pre>
      )}

      {isWindows() && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            fontSize: 11,
          }}
        >
          <input
            type="checkbox"
            checked={startWithOs}
            onChange={async (e) => {
              const next = e.target.checked;
              try {
                if (next) await enable();
                else await disable();
                onStartWithOsChange(next);
                saveSettings({ startWithOs: next });
              } catch {
                /* ignore */
              }
            }}
          />
          Start with Windows
        </label>
      )}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <button type="button" onClick={onOpenUpdates} style={panelBtnStyle}>
          Check for updates
        </button>
        <button type="button" onClick={onReset} style={{ ...panelBtnStyle, marginTop: 6, color: "#ef4444" }}>
          Sign out / Re-pair
        </button>
      </div>
    </div>
  );
}

const panelBtnStyle: React.CSSProperties = {
  background: "none",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "5px 10px",
  color: "var(--text-muted)",
  fontSize: 11,
  cursor: "pointer",
  width: "100%",
  fontFamily: "monospace",
};
