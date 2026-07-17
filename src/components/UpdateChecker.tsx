import { useState, useCallback, useEffect } from "react";
import {
  checkForUpdate,
  installUpdate,
  relaunchApp,
  type CheckResult,
  type UpdateProgress,
} from "../lib/updater";
import { friendlyUpdateError } from "../lib/errors";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; result: CheckResult }
  | { kind: "downloading"; progress: UpdateProgress | null }
  | { kind: "ready-to-relaunch" }
  | { kind: "install-error"; message: string }
  | { kind: "deferred" };

interface Props {
  showButton?: boolean;
  onDismiss?: () => void;
  /** True while a track is actively playing — avoid forced installs. */
  isPerforming?: boolean;
  /** External signal to install after the set ends. */
  installWhenIdle?: boolean;
  onDeferred?: () => void;
  onClearDefer?: () => void;
}

export default function UpdateChecker({
  showButton = true,
  onDismiss,
  isPerforming = false,
  installWhenIdle = false,
  onDeferred,
  onClearDefer,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const handleCheck = useCallback(async () => {
    setPhase({ kind: "checking" });
    const result = await checkForUpdate();
    setPhase({ kind: "result", result });
  }, []);

  const handleInstall = useCallback(async () => {
    if (isPerforming) {
      setPhase({ kind: "deferred" });
      onDeferred?.();
      return;
    }
    setPhase({ kind: "downloading", progress: null });
    try {
      await installUpdate((progress) => {
        setPhase({ kind: "downloading", progress });
      });
      onClearDefer?.();
      setPhase({ kind: "ready-to-relaunch" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase({ kind: "install-error", message: friendlyUpdateError(msg) });
    }
  }, [isPerforming, onDeferred, onClearDefer]);

  const handleInstallNowDespitePerforming = useCallback(async () => {
    setPhase({ kind: "downloading", progress: null });
    try {
      await installUpdate((progress) => {
        setPhase({ kind: "downloading", progress });
      });
      onClearDefer?.();
      setPhase({ kind: "ready-to-relaunch" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase({ kind: "install-error", message: friendlyUpdateError(msg) });
    }
  }, [onClearDefer]);

  const handleDefer = useCallback(() => {
    setPhase({ kind: "deferred" });
    onDeferred?.();
  }, [onDeferred]);

  const handleRelaunch = useCallback(async () => {
    await relaunchApp();
  }, []);

  // Install automatically once the DJ set ends (track stops).
  useEffect(() => {
    if (!installWhenIdle || isPerforming) return;
    if (phase.kind !== "deferred") return;
    void handleInstallNowDespitePerforming();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installWhenIdle, isPerforming]);

  const banner = renderBanner(
    phase,
    isPerforming,
    handleInstall,
    handleInstallNowDespitePerforming,
    handleDefer,
    handleRelaunch,
    onDismiss
  );

  return (
    <div>
      {showButton && phase.kind === "idle" && (
        <button type="button" onClick={handleCheck} style={outlineBtnStyle}>
          Check for updates
        </button>
      )}

      {phase.kind === "checking" && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "6px 0" }}>
          Checking for updates…
        </p>
      )}

      {banner}
    </div>
  );
}

function renderBanner(
  phase: Phase,
  isPerforming: boolean,
  onInstall: () => void,
  onInstallNow: () => void,
  onDefer: () => void,
  onRelaunch: () => void,
  onDismiss?: () => void
) {
  if (phase.kind === "deferred") {
    return (
      <div style={bannerBox("rgba(108,99,255,0.1)", "rgba(108,99,255,0.3)")}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)", marginBottom: 6 }}>
          New version available
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
          {isPerforming
            ? "Update will install automatically when this track stops."
            : "Ready to install — your set looks finished."}
        </p>
        {!isPerforming && (
          <button type="button" onClick={onInstallNow} style={primaryBtnStyle}>
            Download & install now
          </button>
        )}
        {onDismiss && (
          <button type="button" onClick={onDismiss} style={{ ...ghostBtnStyle, marginTop: 8 }}>
            Later
          </button>
        )}
      </div>
    );
  }

  if (phase.kind === "result") {
    const { result } = phase;

    if (result.status === "up-to-date") {
      return (
        <div style={bannerBox("rgba(34,197,94,0.08)", "rgba(34,197,94,0.2)")}>
          <span style={{ fontSize: 12, color: "var(--success)" }}>
            You're up to date
            {result.currentVersion !== "unknown" ? ` (v${result.currentVersion})` : ""}
          </span>
          {onDismiss && (
            <button type="button" onClick={onDismiss} style={ghostBtnStyle}>
              ✕
            </button>
          )}
        </div>
      );
    }

    if (result.status === "error") {
      return (
        <div style={bannerBox("rgba(239,68,68,0.08)", "rgba(239,68,68,0.2)")}>
          <span style={{ fontSize: 12, color: "var(--error)" }}>
            {result.message}
          </span>
          {onDismiss && (
            <button type="button" onClick={onDismiss} style={ghostBtnStyle}>
              ✕
            </button>
          )}
        </div>
      );
    }

    if (result.status === "available") {
      const { info } = result;
      return (
        <div style={bannerBox("rgba(108,99,255,0.1)", "rgba(108,99,255,0.3)")}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)", marginBottom: 4 }}>
            New version available — v{info.version}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
            Current: v{info.currentVersion}
          </div>

          {info.body && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                lineHeight: 1.6,
                marginBottom: 12,
                maxHeight: 100,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {info.body}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {isPerforming ? (
              <>
                <button type="button" onClick={onDefer} style={primaryBtnStyle}>
                  Install after this set
                </button>
                <button type="button" onClick={onInstallNow} style={outlineBtnStyle}>
                  Install now anyway
                </button>
              </>
            ) : (
              <button type="button" onClick={onInstall} style={primaryBtnStyle}>
                Download & install
              </button>
            )}
            {onDismiss && (
              <button type="button" onClick={onDismiss} style={ghostBtnStyle}>
                Later
              </button>
            )}
          </div>
        </div>
      );
    }
  }

  if (phase.kind === "downloading") {
    const { progress } = phase;
    const pct =
      progress && progress.total
        ? Math.round((progress.downloaded / progress.total) * 100)
        : null;

    return (
      <div style={bannerBox("rgba(108,99,255,0.08)", "rgba(108,99,255,0.2)")}>
        <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 8, fontWeight: 600 }}>
          Downloading update…{pct !== null ? ` ${pct}%` : ""}
        </div>
        <div style={{ height: 4, borderRadius: 2, background: "rgba(108,99,255,0.2)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              borderRadius: 2,
              background: "var(--accent)",
              width: pct !== null ? `${pct}%` : "30%",
              transition: "width 0.3s ease",
            }}
          />
        </div>
      </div>
    );
  }

  if (phase.kind === "ready-to-relaunch") {
    return (
      <div style={bannerBox("rgba(34,197,94,0.08)", "rgba(34,197,94,0.25)")}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--success)", marginBottom: 6 }}>
          Update ready
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
          Restart when your set is done. Pairing is saved — you won't need a new code.
        </p>
        <button type="button" onClick={onRelaunch} style={successBtnStyle}>
          Restart now
        </button>
      </div>
    );
  }

  if (phase.kind === "install-error") {
    return (
      <div style={bannerBox("rgba(239,68,68,0.08)", "rgba(239,68,68,0.2)")}>
        <span style={{ fontSize: 12, color: "var(--error)" }}>{phase.message}</span>
      </div>
    );
  }

  return null;
}

function bannerBox(bg: string, border: string): React.CSSProperties {
  return {
    padding: "14px 16px",
    borderRadius: 10,
    background: bg,
    border: `1px solid ${border}`,
    display: "flex",
    flexDirection: "column",
  };
}

const primaryBtnStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px",
  borderRadius: 8,
  background: "var(--accent)",
  color: "#fff",
  border: "none",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const successBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: "var(--success)",
};

const outlineBtnStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px",
  borderRadius: 8,
  background: "none",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  fontSize: 13,
  cursor: "pointer",
};

const ghostBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
  padding: "4px 0",
  alignSelf: "flex-start",
};
