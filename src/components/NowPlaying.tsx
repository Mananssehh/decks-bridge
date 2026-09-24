import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  clearConfig,
  loadNowPlayingSource,
  saveNowPlayingSource,
  type Config,
} from "../lib/store";
import { sendTrackResilient, getQueueLength } from "../lib/offlineQueue";
import { type NowPlayingSource } from "../lib/playback";
import { appUpdater } from "../hooks/useAppUpdate";
import { logDiagnostic, getLogDir } from "../lib/log";
import { isWindows, saveSettings } from "../lib/platform";
import { resolveSourceLabel, isNoMetadataSource, getAppCompatibility } from "../lib/djSources";
import { friendlyDetectionMessage } from "../lib/errors";
import { useBridgeConnection } from "../hooks/useBridgeConnection";
import { useNowPlayingSync } from "../hooks/useNowPlayingSync";
import { useBridgeSnapshot } from "../hooks/useBridgeSnapshot";
import { createBridgeProvider } from "../lib/bridge/factory";
import type { BridgeSnapshot } from "../lib/bridge/types";
import { openViewer } from "../lib/windows";
import { POLL_MS } from "../lib/syncEngine";
import "./bridge.css";
import "./viewer/viewer.css";
import DiagnosticsPanel from "./DiagnosticsPanel";
import ExpandedDashboard from "./viewer/ExpandedDashboard";
import ViewerFallback from "./viewer/ViewerFallback";
import UpdateChecker from "./UpdateChecker";
import { isEnabled } from "@tauri-apps/plugin-autostart";

interface Props {
  config: Config;
  onReset: () => void;
  autoStart?: boolean;
  safeMode?: boolean;
}

interface Status {
  type: "success" | "error" | "info";
  message: string;
}

interface LastPost {
  url: string;
  httpStatus: number;
  body: string;
  sentAt: string;
  trackTitle: string;
}

export default function NowPlaying({ config, onReset, autoStart = false, safeMode = false }: Props) {
  // Now Playing source: "auto" (priority pipeline) / a forced app / "manual".
  // Safe mode forces manual; otherwise honor the saved preference, but only
  // start detecting automatically when autoStart is set.
  const [source, setSourceState] = useState<NowPlayingSource>(() => {
    if (safeMode) return "manual";
    const saved = loadNowPlayingSource();
    if (!autoStart && saved === "auto") return "manual";
    return saved;
  });
  const autoDetect = source !== "manual";

  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [albumArt, setAlbumArt] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const lastSentRef = useRef<string>(""); // manual-mode dedupe only
  // Remember the last real detection source so the ON toggle can restore it.
  const lastActiveSourceRef = useRef<NowPlayingSource>(
    source !== "manual" ? source : "auto"
  );

  const setSource = useCallback((next: NowPlayingSource) => {
    lastSentRef.current = "";
    if (next !== "manual") lastActiveSourceRef.current = next;
    setSourceState(next);
    saveNowPlayingSource(next);
    setStatus(null);
  }, []);
  const [lastPost, setLastPost] = useState<LastPost | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagClicks, setDiagClicks] = useState(0);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [startWithOs, setStartWithOs] = useState(false);
  const [, setQueuedCount] = useState(0);
  const [showUpdatePanel, setShowUpdatePanel] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());

  // ── One sync engine drives detection + send; the connection layer handles
  //    health/reconnect. Refs break the mutual dependency between the two hooks.
  const recordIngestRef = useRef<(ok: boolean) => void>(() => {});
  const handleIngest = useCallback((ok: boolean) => recordIngestRef.current(ok), []);
  const { status: syncStatus, syncNow } = useNowPlayingSync({
    config,
    source,
    enabled: autoDetect,
    onIngest: handleIngest,
  });
  const detected = autoDetect ? syncStatus.detected : null;
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  const handleReconnect = useCallback(() => syncNowRef.current(), []);

  const {
    status: connectionStatus,
    authFailed,
    supabaseLatencyMs,
    lastIngestAt,
    recordIngest,
  } = useBridgeConnection(config, autoDetect, detected, handleReconnect);
  recordIngestRef.current = recordIngest;

  const manualMode = !autoDetect;
  const sourceLabel = resolveSourceLabel(detected, manualMode);
  const isActivePlaying = autoDetect && Boolean(detected?.isPlaying && detected?.title);

  // ── Live Event Console (Rec-A: the main window IS the console) ──────────────
  // Separate loop from the 3s detector: polls the authenticated backend snapshot
  // for trending / queue / tips / event info. Same provider the mini/pill use.
  const provider = useMemo(() => createBridgeProvider(config), [config]);
  const {
    snapshot: cloudSnapshot,
    state: snapshotState,
    confidence,
    refreshNow: refreshSnapshot,
  } = useBridgeSnapshot(provider);
  // "console" is the mission-control view; "settings" holds every Bridge control.
  const [view, setView] = useState<"console" | "settings">("console");

  // Local-first Now Playing: the local detector is the immediate source of truth,
  // so overlay the locally-detected track onto the cloud snapshot rather than
  // waiting a poll cycle for the backend to echo it back.
  const consoleSnapshot: BridgeSnapshot | null = useMemo(() => {
    if (!cloudSnapshot) return null;
    if (detected?.title) {
      return {
        ...cloudSnapshot,
        nowPlaying: {
          title: detected.title,
          artist: detected.artist ?? "",
          albumArt: detected.album ?? cloudSnapshot.nowPlaying?.albumArt,
          source: detected.playbackApp ?? "decks_bridge",
          startedAt: cloudSnapshot.nowPlaying?.startedAt,
        },
      };
    }
    return cloudSnapshot;
  }, [cloudSnapshot, detected?.title, detected?.artist]);

  const handleConsoleSwitch = useCallback((to: "expanded" | "mini" | "pill") => {
    openViewer(to).catch((e) => console.error("[console] switch failed:", e));
  }, []);

  const refreshQueueCount = useCallback(() => {
    setQueuedCount(getQueueLength());
  }, []);

  // Refresh the offline-queue count when a send may have changed it.
  useEffect(() => {
    refreshQueueCount();
  }, [syncStatus.lastSentAt, refreshQueueCount]);

  // 1-second ticker so relative times ("last sync", "checked …") stay live in
  // both the Console and Settings views.
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const handleRefreshSource = () => {
    setStatus(null);
    syncNow();
  };

  useEffect(() => {
    logDiagnostic("pairing", `session restored eventId=${config.eventId}`).catch(() => undefined);
    getLogDir().then(setLogDir).catch(() => undefined);
    refreshQueueCount();
    if (isWindows()) {
      isEnabled()
        .then((v) => {
          setStartWithOs(v);
          saveSettings({ startWithOs: v });
        })
        .catch(() => undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update checks run app-wide (App.tsx); this only tells the update alert
  // whether a track is live so it can warn before a restart.
  useEffect(() => {
    appUpdater.setPerforming(isActivePlaying);
  }, [isActivePlaying]);
  useEffect(() => () => appUpdater.setPerforming(false), []);

  // Surface the sync engine's current send result in the status line.
  const lastSyncState = syncStatus.state;
  useEffect(() => {
    if (!autoDetect) return;
    if (lastSyncState === "paused") {
      setStatus({ type: "info", message: "No track detected — Manual mode always works." });
    } else if (lastSyncState === "delayed") {
      setStatus({ type: "info", message: "Detection delayed — retrying automatically." });
    } else if (lastSyncState === "active" || lastSyncState === "sending") {
      // Clear transient warnings once detection is healthy again.
      setStatus((s) => (s && s.type === "info" ? null : s));
    }
  }, [lastSyncState, autoDetect]);

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    if (!title.trim() || !artist.trim()) {
      setStatus({ type: "error", message: "Title and artist are required." });
      return;
    }

    const key = `${title.trim()}||${artist.trim()}`;
    if (key === lastSentRef.current) {
      setStatus({ type: "info", message: "Already sent. Change the track to send again." });
      return;
    }

    setSending(true);
    const result = await sendTrackResilient(
      config,
      { title: title.trim(), artist: artist.trim(), album_art: albumArt.trim() },
      "decks_bridge"
    );
    setSending(false);
    refreshQueueCount();
    recordIngest(result.ok);

    setLastPost({
      url: result.requestUrl,
      httpStatus: result.httpStatus,
      body: result.responseBody,
      sentAt: new Date().toLocaleTimeString(),
      trackTitle: title.trim(),
    });
    if (result.ok) lastSentRef.current = key;
    setStatus({
      type: result.ok ? "success" : "error",
      message: result.message,
    });
  }

  function handleSignOut() {
    // Stop the detection loop immediately (manual mode disables the engine)
    setSourceState("manual");
    // Clear all stored auth/pairing data
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    clearConfig();
    // Navigate to pairing screen
    onReset();
  }

  const showDiagPanel = showDiagnostics || diagClicks >= 5;

  // Live relative-time labels for the status area.
  const ago = (ts: number | null): string => {
    if (!ts) return "—";
    const s = Math.max(0, Math.round((nowTs - ts) / 1000));
    if (s < 1) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s ago`;
  };
  const detectionActive =
    autoDetect && (syncStatus.state === "active" || syncStatus.state === "sending");
  const detectionLabel =
    !autoDetect
      ? "Off (Manual)"
      : syncStatus.state === "paused"
        ? "No track — retrying"
        : syncStatus.state === "delayed"
          ? "Delayed — retrying automatically"
          : syncStatus.state === "searching"
            ? "Searching…"
            : "Active";

  // Friendly, non-developer guidance for the selected automatic source:
  // "rekordbox needs Accessibility", "Serato isn't running", etc. Falls back to
  // a humanised detector message — never a raw error string.
  const sourceGuidance: string | null = (() => {
    if (!autoDetect || !detected) return null;
    if (isNoMetadataSource(detected)) {
      const compat = getAppCompatibility(detected);
      return compat?.note ?? friendlyDetectionMessage(detected.error) ?? null;
    }
    if (detected.error) return friendlyDetectionMessage(detected.error) ?? null;
    if (syncStatus.state === "paused" && !detected.title) {
      return "No track detected yet. Load and play a track in your DJ app — Manual Mode always works.";
    }
    return null;
  })();

  const SOURCES: { value: NowPlayingSource; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "djay", label: "djay Pro" },
    { value: "serato", label: "Serato" },
    { value: "rekordbox", label: "rekordbox" },
    { value: "apple_music", label: "Apple Music" },
    { value: "spotify", label: "Spotify" },
    { value: "manual", label: "Manual" },
  ];

  // ── Presentation ────────────────────────────────────────────────────────────
  // Mirrors the Live Event Console's language (bridge.css + styles/tokens.css).
  // Behavior is untouched: every handler/flag above is used exactly as before.


  // ── SETTINGS view — every Bridge control lives here (⚙ from the Console) ────
  if (view === "settings") {
    const detStatusColor = detectionActive ? "var(--green)" : "var(--gold)";
    return (
      <div className="bridge">
        <div className="bridge-inner">
          <header className="bx-header">
            <div className="bx-brand">
              <button className="bx-icon-btn" title="Back to Console" onClick={() => setView("console")}>‹</button>
              <div style={{ minWidth: 0 }}>
                <div className="bx-brand-name" onClick={() => setDiagClicks((n) => n + 1)}>Settings</div>
                <div className="bx-brand-sub">Decks Bridge · {config.eventName ?? "paired event"}</div>
              </div>
            </div>
            <div className="bx-header-right">
              <button className="bx-btn-ghost" onClick={() => setView("console")}>Done</button>
            </div>
          </header>

          {safeMode && (
            <div className="bx-note warn">Safe mode — auto-detect paused after a previous issue. Turn it on when ready.</div>
          )}
          {authFailed && (
            <div className="bx-note error">Your Bridge session expired. Sign out and pair again when you're ready.</div>
          )}

          {/* Source & detection */}
          <section className="bx-panel">
            <div className="bx-panel-title">
              <span>Now Playing Source</span>
              <button
                type="button"
                className={`bx-pill ${autoDetect ? "ok" : "neutral"}`}
                style={{ cursor: "pointer" }}
                title={autoDetect ? "Turn detection off (Manual mode)" : "Turn detection back on"}
                onClick={() => setSource(autoDetect ? "manual" : lastActiveSourceRef.current)}
              >
                <span className="bx-dot" />{autoDetect ? "ON" : "OFF"}
              </button>
            </div>
            <div className="bx-help" style={{ marginTop: 4 }}>Choose how Bridge detects your now-playing track.</div>

            <div className="bx-seg" style={{ marginTop: 12 }}>
              {SOURCES.map((s) => (
                <button key={s.value} type="button"
                        className={`bx-seg-btn${source === s.value ? " active" : ""}`}
                        onClick={() => setSource(s.value)} title={s.label}>
                  {s.label}
                </button>
              ))}
            </div>

            {autoDetect && (
              <div style={{ marginTop: 12 }}>
                <div className="bx-kv"><span>Detection</span><b style={{ color: detStatusColor }}>{detectionLabel}</b></div>
                <div className="bx-kv"><span>Source</span><b>{sourceLabel}</b></div>
                <div className="bx-kv"><span>Last checked</span><b>{ago(syncStatus.lastCheckedAt)}</b></div>
                <div className="bx-kv">
                  <span>Last update sent</span>
                  <b>{ago(syncStatus.lastSentAt)}{syncStatus.lastSentTrack ? ` · ${syncStatus.lastSentTrack.title}` : ""}</b>
                </div>
                {sourceGuidance && (
                  <div className="bx-note warn" style={{ marginTop: 12 }}>{sourceGuidance}</div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button type="button" className="bx-btn-ghost" onClick={handleRefreshSource}>Sync Now</button>
                  <button type="button" className="bx-btn-ghost" onClick={() => setShowDiagnostics(true)}>Test detection</button>
                </div>
              </div>
            )}
          </section>

          {/* Manual entry */}
          {!autoDetect && (
            <section className="bx-panel">
              <div className="bx-panel-title"><span>Manual entry</span></div>
              <form onSubmit={handleSendTest} style={{ marginTop: 12 }}>
                <div className="bx-field">
                  <label className="bx-label" htmlFor="title">Track title</label>
                  <input id="title" className="bx-input" type="text" placeholder="Track name"
                         value={title} onChange={(e) => setTitle(e.target.value)} spellCheck={false} />
                </div>
                <div className="bx-field">
                  <label className="bx-label" htmlFor="artist">Artist</label>
                  <input id="artist" className="bx-input" type="text" placeholder="Artist name"
                         value={artist} onChange={(e) => setArtist(e.target.value)} spellCheck={false} />
                </div>
                <div className="bx-field">
                  <label className="bx-label" htmlFor="albumArt">Artwork URL</label>
                  <input id="albumArt" className="bx-input" type="text" placeholder="https://… (optional)"
                         value={albumArt} onChange={(e) => setAlbumArt(e.target.value)} spellCheck={false} />
                  <div className="bx-help">Optional — shown on your event's Now Playing.</div>
                </div>
                <button type="submit" className="bx-btn-primary block" disabled={sending}>
                  {sending ? "Updating…" : "Update Now Playing"}
                </button>
              </form>
            </section>
          )}

          {status && (
            <div className={`bx-note ${status.type === "info" ? "info" : status.type === "error" ? "error" : "success"}`}>
              {status.message}
            </div>
          )}

          {/* Update panel — the update alert itself is app-wide (App.tsx) */}
          {showUpdatePanel && (
            <section className="bx-panel">
              <UpdateChecker onDismiss={() => setShowUpdatePanel(false)} />
            </section>
          )}

          {/* Diagnostics */}
          <section className="bx-panel">
            <div className="bx-panel-title">
              <span>Diagnostics</span>
              <button type="button" className="bx-textlink" onClick={() => setShowDiagnostics((v) => !v)}>
                {showDiagPanel ? "Hide" : "Show"}
              </button>
            </div>
            {showDiagPanel && (
              <div style={{ marginTop: 12 }}>
                <DiagnosticsPanel config={config} connectionStatus={connectionStatus}
                  supabaseLatencyMs={supabaseLatencyMs} lastIngestAt={lastIngestAt} pollIntervalMs={POLL_MS}
                  autoDetect={autoDetect} sourceLabel={sourceLabel} detected={detected} logDir={logDir}
                  startWithOs={startWithOs} onStartWithOsChange={setStartWithOs}
                  onOpenUpdates={() => {
                    setShowUpdatePanel(true);
                    void appUpdater.checkNow({ manual: true });
                  }} onReset={handleSignOut} />
                {lastPost && (
                  <div className="bx-help" style={{ marginTop: 8, fontFamily: "var(--font-mono)" }}>
                    Last send: {lastPost.sentAt} · {lastPost.trackTitle} · HTTP {lastPost.httpStatus || "queued"}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* About / sign out */}
          <div className="bx-footer">
            <span>Decks Bridge · detecting every {Math.round(POLL_MS / 1000)}s</span>
            <button type="button" className="bx-textlink" style={{ color: "var(--red)" }} onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── CONSOLE view — the main window IS the Live Event Console ────────────────
  return (
    <div className="viewer">
      {consoleSnapshot ? (
        <ExpandedDashboard
          snapshot={consoleSnapshot}
          nowTs={nowTs}
          mode="expanded"
          confidence={confidence}
          onSwitchMode={handleConsoleSwitch}
          onSyncNow={refreshSnapshot}
          onOpenSettings={() => setView("settings")}
        />
      ) : (
        <ViewerFallback
          mode="expanded"
          state={snapshotState}
          paired
          onExpand={refreshSnapshot}
          onRetry={refreshSnapshot}
        />
      )}
    </div>
  );
}
