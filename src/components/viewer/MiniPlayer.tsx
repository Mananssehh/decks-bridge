import type { BridgeSnapshot, ViewerMode, SyncConfidence, SyncLevel } from "../../lib/bridge/types";
import { money } from "./format";

interface Props {
  snapshot: BridgeSnapshot;
  confidence: SyncConfidence;
  onSwitchMode: (m: ViewerMode) => void;
  onSyncNow: () => void;
}

const DOT_COLOR: Record<SyncLevel, string> = {
  green: "#22c55e",
  orange: "#f5c451",
  gray: "#8a8a93",
  red: "#ef6a6a",
};

export default function MiniPlayer({ snapshot, confidence, onSwitchMode, onSyncNow }: Props) {
  const np = snapshot.nowPlaying;
  const topTrending = snapshot.trending[0];

  return (
    // The whole surface is a drag handle for this frameless window; buttons opt out.
    <div className="mini" data-tauri-drag-region>
      <div className="mini-top">
        <div className="mini-art">♪</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mini-title">{np?.title ?? "No track"}</div>
          <div className="mini-sub">
            <span
              className="pulse-dot"
              style={{ color: DOT_COLOR[confidence.level], width: 7, height: 7, marginRight: 6 }}
            />
            {np?.artist ? `${np.artist}${np.source ? ` · ${np.source}` : ""}` : confidence.label}
          </div>
        </div>
        <div className="mini-ctl">
          <button title="Sync now" onClick={onSyncNow}>⟳</button>
          <button title="Expand to console" onClick={() => onSwitchMode("expanded")}>⤢</button>
          <button title="Shrink to pill" onClick={() => onSwitchMode("pill")}>▁</button>
        </div>
      </div>
      <div className="mini-foot">
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
          {topTrending ? `🔥 ${topTrending.title}` : "No trending yet"}
        </span>
        <span className="tip-amt" style={{ fontSize: 12 }}>
          {money(snapshot.tipTotals.total, snapshot.tipTotals.currency)}
        </span>
      </div>
    </div>
  );
}
