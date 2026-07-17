import { useEffect, useState, useCallback, useMemo } from "react";
import type { ViewerMode } from "../../lib/bridge/types";
import { loadConfig } from "../../lib/store";
import { createBridgeProvider } from "../../lib/bridge/factory";
import { useBridgeSnapshot } from "../../hooks/useBridgeSnapshot";
import { requestSwitch } from "../../lib/windows";
import ExpandedDashboard from "./ExpandedDashboard";
import MiniPlayer from "./MiniPlayer";
import FloatingPill from "./FloatingPill";
import ViewerFallback from "./ViewerFallback";
import "./viewer.css";

interface Props {
  mode: ViewerMode;
}

/**
 * Root of a viewer window. Creates the data provider from the stored pairing
 * config (mock in dev, live otherwise) and drives all three surfaces from the
 * single `useBridgeSnapshot` loop. It NEVER shows fake data in place of missing
 * live data — when live data is unavailable it renders an honest fallback.
 */
export default function ViewerRoot({ mode }: Props) {
  // Same-origin webviews share localStorage, so the paired config written by the
  // main window is readable here.
  const config = useMemo(() => loadConfig(), []);
  const provider = useMemo(() => createBridgeProvider(config), [config]);

  // Pill mode polls on the slow (15 s) cadence; expanded/mini on 4 s.
  const { snapshot, state, confidence, refreshNow } = useBridgeSnapshot(provider, {
    slowMode: mode === "pill",
  });
  const isMock = provider?.kind === "mock";
  const compact = mode !== "expanded";

  // Shared 1s ticker so relative times / durations stay live.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Pause ambient CSS animations while the window is hidden (perf beside DJ apps).
  useEffect(() => {
    const apply = () =>
      document.body.classList.toggle("vw-hidden", document.visibilityState === "hidden");
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => document.removeEventListener("visibilitychange", apply);
  }, []);

  // A viewer never closes/creates windows itself — it asks the main window to,
  // so the close→confirm→create order can complete in a context that stays alive.
  const onSwitchMode = useCallback(
    (to: ViewerMode) => {
      if (to === mode) return;
      requestSwitch(to).catch((e) => console.error("[viewer] switch request failed:", e));
    },
    [mode]
  );

  const badge = isMock ? (
    <div className={`mock-badge${compact ? " compact" : ""}`}>
      {compact ? "● MOCK" : "● Mock Data"}
    </div>
  ) : null;

  // No snapshot yet → honest connecting / unavailable / unpaired state.
  if (!snapshot) {
    return (
      <div className="viewer">
        {badge}
        <ViewerFallback
          mode={mode}
          state={state}
          paired={provider !== null}
          onExpand={() => onSwitchMode("expanded")}
          onRetry={refreshNow}
        />
      </div>
    );
  }

  return (
    <div className="viewer">
      {badge}
      {mode === "expanded" && (
        <ExpandedDashboard
          snapshot={snapshot}
          nowTs={nowTs}
          mode={mode}
          confidence={confidence}
          onSwitchMode={onSwitchMode}
          onSyncNow={refreshNow}
        />
      )}
      {mode === "mini" && (
        <MiniPlayer snapshot={snapshot} confidence={confidence} onSwitchMode={onSwitchMode} onSyncNow={refreshNow} />
      )}
      {mode === "pill" && (
        <FloatingPill snapshot={snapshot} confidence={confidence} onSwitchMode={onSwitchMode} />
      )}
    </div>
  );
}
