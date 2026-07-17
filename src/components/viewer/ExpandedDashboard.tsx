import type { BridgeSnapshot, ViewerMode, SyncConfidence, SyncLevel } from "../../lib/bridge/types";
import { timeAgo, durationSince, formatDurationSeconds, money } from "./format";
import { useHighValueTip } from "./useHighValueTip";
import { getTipThreshold } from "../../lib/viewerSettings";

interface Props {
  snapshot: BridgeSnapshot;
  nowTs: number;
  mode: ViewerMode;
  confidence: SyncConfidence;
  onSwitchMode: (m: ViewerMode) => void;
  onSyncNow: () => void;
  /** When set (main-window Console), a ⚙ opens Bridge settings. */
  onOpenSettings?: () => void;
}

const CONNECTION_BADGE: Record<
  BridgeSnapshot["connectionStatus"],
  { cls: string; label: string }
> = {
  connected: { cls: "ok", label: "Connected" },
  waiting_dj: { cls: "warn", label: "Waiting for DJ" },
  disconnected: { cls: "off", label: "Disconnected" },
};

/** Sync-confidence level → conn-pill colour class. */
const SYNC_CLS: Record<SyncLevel, string> = {
  green: "ok",
  orange: "warn",
  gray: "neutral",
  red: "off",
};

/** Decorative, ambient waveform — reads as "live audio", claims no position. */
function Waveform() {
  const bars = Array.from({ length: 40 });
  return (
    <div className="wave" aria-hidden>
      {bars.map((_, i) => (
        <span key={i} style={{ animationDelay: `${(i % 10) * 0.09}s` }} />
      ))}
    </div>
  );
}

export default function ExpandedDashboard({
  snapshot,
  nowTs,
  mode,
  confidence,
  onSwitchMode,
  onSyncNow,
  onOpenSettings,
}: Props) {
  const np = snapshot.nowPlaying;
  const conn = CONNECTION_BADGE[snapshot.connectionStatus];
  const { hotTipIds, latestBoost, dismissBoost } = useHighValueTip(
    snapshot.tips,
    getTipThreshold()
  );

  // Render the backend's queue order (queue_position) — do not re-sort.
  const liveQueue = snapshot.queue
    .filter((q) => q.status !== "played" && q.status !== "rejected")
    .slice(0, 6);
  const queueCount = snapshot.queue.filter(
    (q) => q.status === "pending" || q.status === "approved"
  ).length;
  const threshold = getTipThreshold();
  const eventMeta = [snapshot.venue, snapshot.djName ? `DJ ${snapshot.djName}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="console">
      {/* Transient high-value tip alert (no sound). */}
      {latestBoost && (
        <div className="boost-toast" role="status" onClick={dismissBoost}>
          <span className="boost-amt">{money(latestBoost.amount, latestBoost.currency)}</span>
          <div className="boost-body">
            <div className="boost-title">Big tip{latestBoost.displayName ? ` from ${latestBoost.displayName}` : ""}!</div>
            {latestBoost.message && <div className="boost-msg">“{latestBoost.message}”</div>}
          </div>
        </div>
      )}

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">
              {snapshot.eventName}
              {snapshot.eventStatus && (
                <span className={`status-chip ${snapshot.eventStatus.toLowerCase()}`}>
                  {snapshot.eventStatus}
                </span>
              )}
            </div>
            <div className="brand-sub">{eventMeta || "Decks Bridge"}</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="mode-switch" role="tablist" aria-label="Viewer mode">
            {(["expanded", "mini", "pill"] as ViewerMode[]).map((m) => (
              <button
                key={m}
                className={`mode-btn${m === mode ? " active" : ""}`}
                onClick={() => onSwitchMode(m)}
              >
                {m === "expanded" ? "Console" : m === "mini" ? "Mini" : "Pill"}
              </button>
            ))}
          </div>
          <button className="icon-btn" title="Sync now" onClick={onSyncNow}>⟳</button>
          {onOpenSettings && (
            <button className="icon-btn" title="Settings" onClick={onOpenSettings}>⚙</button>
          )}
          <span className={`conn-pill ${SYNC_CLS[confidence.level]}`} title="Sync status">
            <span className="pulse-dot" />
            {confidence.label}
          </span>
        </div>
      </header>

      {/* ── Now Playing hero ─────────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-art">
          {np?.albumArt ? <img src={np.albumArt} alt="" /> : <span>♪</span>}
        </div>
        <div className="hero-info">
          <div className="hero-eyebrow">
            Now Playing{np?.source ? ` · ${np.source}` : ""}
          </div>
          <div className="hero-title">{np?.title ?? "Waiting for the next track"}</div>
          <div className="hero-artist">{np?.artist ?? "—"}</div>
          <Waveform />
        </div>
        <div className="hero-stats">
          <div className="hstat">
            <div className="hstat-num">{snapshot.guestsOnline ?? "—"}</div>
            <div className="hstat-label">Guests</div>
          </div>
          <div className="hstat">
            <div className="hstat-num gold">
              {money(snapshot.tipTotals.total, snapshot.tipTotals.currency)}
            </div>
            <div className="hstat-label">Tips</div>
          </div>
          <div className="hstat">
            <div className="hstat-num">{queueCount}</div>
            <div className="hstat-label">Queue</div>
          </div>
        </div>
      </section>

      {/* ── Mission-control grid ─────────────────────────────────────────── */}
      <section className="grid2">
        {/* Row 1 · left */}
        <div className="panel">
          <div className="panel-label">🔥 Trending</div>
          {snapshot.trending.length === 0 ? (
            <div className="empty">No votes yet.</div>
          ) : (
            snapshot.trending.slice(0, 5).map((t, i) => (
              <div className="row" key={t.id}>
                <div className={`rank${i === 0 ? " top" : ""}`}>{t.rank ?? i + 1}</div>
                <div className="row-main">
                  <div className="row-title">{t.title}</div>
                  <div className="row-sub">
                    {t.artist}
                    {t.tipTotal ? ` · ${money(t.tipTotal, snapshot.tipTotals.currency)} tipped` : ""}
                    {t.queuePosition ? ` · #${t.queuePosition}` : ""}
                  </div>
                </div>
                <span className="votes">▲ {t.votes}</span>
              </div>
            ))
          )}
        </div>

        {/* Row 1 · right */}
        <div className="panel">
          <div className="panel-label">🎚️ Live Queue</div>
          {liveQueue.length === 0 ? (
            <div className="empty">No open requests.</div>
          ) : (
            liveQueue.map((q) => (
              <div className="row" key={q.id}>
                <span className="votes lead">▲ {q.votes}</span>
                <div className="row-main">
                  <div className="row-title">{q.title}</div>
                  <div className="row-sub">
                    {q.artist}
                    {q.requestCount ? ` · ×${q.requestCount}` : ""}
                    {q.tipTotal ? ` · ${money(q.tipTotal, snapshot.tipTotals.currency)}` : ""}
                    {` · ${timeAgo(q.requestedAt, nowTs)}`}
                  </div>
                </div>
                <span className={`pill-status ${q.status}`}>{q.status}</span>
              </div>
            ))
          )}
        </div>

        {/* Row 2 · left */}
        <div className="panel">
          <div className="panel-label">
            💸 Recent Tips
            {snapshot.tipTotals.pending ? (
              <span className="label-meta">{money(snapshot.tipTotals.pending, snapshot.tipTotals.currency)} pending</span>
            ) : null}
          </div>
          {snapshot.tips.length === 0 ? (
            <div className="empty">No tips yet.</div>
          ) : (
            snapshot.tips.slice(0, 5).map((tip) => {
              const big = tip.amount >= threshold;
              const isNew = hotTipIds.has(tip.id);
              const subParts = [
                tip.songTitle ? `♫ ${tip.songTitle}` : null,
                tip.message ? `“${tip.message}”` : null,
                tip.paymentStatus && tip.paymentStatus !== "succeeded" ? tip.paymentStatus : null,
              ].filter(Boolean);
              return (
                <div className={`row${isNew ? " boost" : ""}${big ? " big-tip" : ""}`} key={tip.id}>
                  <div className="row-main">
                    <div className="row-title">
                      {tip.displayName ?? "Anonymous"}
                      {isNew && <span className="boost-tag">BOOST</span>}
                    </div>
                    {subParts.length > 0 && <div className="row-sub">{subParts.join(" · ")}</div>}
                  </div>
                  <span className="row-time">{timeAgo(tip.createdAt, nowTs)}</span>
                  <span className="tip-amt">{money(tip.amount, tip.currency)}</span>
                </div>
              );
            })
          )}
        </div>

        {/* Row 2 · right */}
        <div className="panel">
          <div className="panel-label">📡 Bridge Status</div>
          <div className="stat-row">
            <span className="stat-key">Source</span>
            <span className="stat-val">{np?.source ?? snapshot.bridgeSourceType ?? "—"}</span>
          </div>
          <div className="stat-row">
            <span className="stat-key">Connection</span>
            <span className={`badge ${conn.cls}`}>
              <span className="pulse-dot" /> {conn.label}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-key">Bridge last seen</span>
            <span className="stat-val">
              {snapshot.bridgeLastSeen ? timeAgo(snapshot.bridgeLastSeen, nowTs) : "—"}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-key">Last sync</span>
            <span className="stat-val">
              {timeAgo(snapshot.bridgeLastSync ?? snapshot.updatedAt, nowTs)}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-key">Event duration</span>
            <span className="stat-val">
              {snapshot.eventDurationSeconds != null
                ? formatDurationSeconds(snapshot.eventDurationSeconds)
                : durationSince(snapshot.eventStartedAt, nowTs)}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
