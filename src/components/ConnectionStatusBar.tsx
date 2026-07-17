import type { ConnectionStatus } from "../lib/connection";
import { resolveSourceLabel } from "../lib/djSources";
import type { DetectedTrack } from "../lib/playback";
import { getQueueLength } from "../lib/offlineQueue";

interface Props {
  status: ConnectionStatus;
  message: string;
  eventName?: string;
  detected: DetectedTrack | null;
  manualMode: boolean;
  queuedCount?: number;
}

const STATUS_META: Record<
  ConnectionStatus,
  { emoji: string; color: string; label: string }
> = {
  connected: { emoji: "🟢", color: "var(--success)", label: "Connected" },
  waiting_dj: { emoji: "🟡", color: "#f59e0b", label: "No track detected" },
  disconnected: { emoji: "🔴", color: "var(--error)", label: "Disconnected" },
};

export default function ConnectionStatusBar({
  status,
  message,
  eventName,
  detected,
  manualMode,
  queuedCount = getQueueLength(),
}: Props) {
  const meta = STATUS_META[status];
  const source = resolveSourceLabel(detected, manualMode);
  // In manual mode nothing is being detected, so the generic "No track detected"
  // headline would misdescribe the state. Everything else uses the status label.
  const label = manualMode && status === "waiting_dj" ? "Manual mode" : meta.label;

  return (
    <div
      className="card connection-bar"
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: meta.color }}>
          {meta.emoji} {label}
        </span>
        {queuedCount > 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {queuedCount} queued
          </span>
        )}
      </div>

      <div style={{ color: "var(--text-muted)", lineHeight: 1.5 }}>
        {eventName ? (
          <>
            Event:{" "}
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{eventName}</span>
            {" · "}
          </>
        ) : null}
        {message}
      </div>

      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: "1px solid var(--border)",
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>Current source</span>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{source}</span>
      </div>
    </div>
  );
}
