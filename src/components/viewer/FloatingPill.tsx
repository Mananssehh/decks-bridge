import type { BridgeSnapshot, ViewerMode, SyncConfidence, SyncLevel } from "../../lib/bridge/types";

interface Props {
  snapshot: BridgeSnapshot;
  confidence: SyncConfidence;
  onSwitchMode: (m: ViewerMode) => void;
}

const DOT_COLOR: Record<SyncLevel, string> = {
  green: "#22c55e",
  orange: "#f5c451",
  gray: "#8a8a93",
  red: "#ef6a6a",
};

export default function FloatingPill({ snapshot, confidence, onSwitchMode }: Props) {
  const np = snapshot.nowPlaying;
  const label = np?.title ?? "Decks Live";

  return (
    // Frameless always-on-top pill; the body drags, buttons opt out.
    <div className="pill" data-tauri-drag-region>
      <span
        className="pulse-dot"
        style={{ color: DOT_COLOR[confidence.level], width: 9, height: 9, flexShrink: 0 }}
        title={confidence.label}
      />
      <div className="pill-main">
        <div className="pill-title">{label}</div>
        {np?.artist && <div className="pill-sub">{np.artist}</div>}
      </div>
      <div className="mini-ctl">
        <button title="Expand to console" onClick={() => onSwitchMode("expanded")}>⤢</button>
      </div>
    </div>
  );
}
