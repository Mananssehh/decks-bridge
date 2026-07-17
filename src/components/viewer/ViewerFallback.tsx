import type { ViewerMode, SnapshotState } from "../../lib/bridge/types";

interface Props {
  mode: ViewerMode;
  state: SnapshotState;
  paired: boolean;
  onExpand: () => void;
  onRetry: () => void;
}

/**
 * Honest placeholder shown when there is no snapshot to display. It NEVER shows
 * fabricated data — only real connection state. Sized down for the compact
 * surfaces so the mini/pill windows still read cleanly.
 */
export default function ViewerFallback({ mode, state, paired, onExpand, onRetry }: Props) {
  const { dot, title, detail, showRetry } = describe(state, paired);
  const compact = mode !== "expanded";

  if (mode === "pill") {
    return (
      <div className="pill" data-tauri-drag-region>
        <span className={`pulse-dot`} style={{ color: dot }} />
        <div className="pill-main">
          <div className="pill-title">{title}</div>
        </div>
        <div className="mini-ctl">
          <button title="Expand to console" onClick={onExpand}>⤢</button>
        </div>
      </div>
    );
  }

  if (mode === "mini") {
    return (
      <div className="mini" data-tauri-drag-region>
        <div className="mini-top">
          <span className="pulse-dot" style={{ color: dot, width: 10, height: 10 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="mini-title">{title}</div>
            <div className="mini-sub">{detail}</div>
          </div>
          <div className="mini-ctl">
            <button title="Expand to console" onClick={onExpand}>⤢</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fallback" style={{ padding: compact ? 20 : 60 }}>
      <span className="fallback-dot" style={{ background: dot }} />
      <div className="fallback-title">{title}</div>
      <div className="fallback-detail">{detail}</div>
      {showRetry && (
        <button className="fallback-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function describe(
  state: SnapshotState,
  paired: boolean
): { dot: string; title: string; detail: string; showRetry: boolean } {
  if (!paired) {
    return {
      dot: "#8a8a93",
      title: "Not paired",
      detail: "Open Decks Bridge and pair to an event to see live data.",
      showRetry: false,
    };
  }
  switch (state) {
    case "unauthorized":
      return {
        dot: "#ef6a6a",
        title: "Pairing expired",
        detail: "Re-pair in Decks Bridge to reconnect this event.",
        showRetry: true,
      };
    case "unavailable":
      return {
        dot: "#f5c451",
        title: "Live data unavailable",
        detail: "Waiting for the Decks event service. This will connect automatically.",
        showRetry: true,
      };
    case "error":
      return {
        dot: "#f5c451",
        title: "Reconnecting…",
        detail: "Couldn't reach Decks. Retrying automatically.",
        showRetry: true,
      };
    case "connecting":
    default:
      return {
        dot: "#8a8a93",
        title: "Connecting…",
        detail: "Loading your live event data.",
        showRetry: false,
      };
  }
}
