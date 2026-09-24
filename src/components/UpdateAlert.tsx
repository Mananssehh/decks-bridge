import { appUpdater, useAppUpdate } from "../hooks/useAppUpdate";
import { friendlyUpdateError } from "../lib/errors";
import { isWindows } from "../lib/platform";
import { formatReleaseNotes } from "../lib/releaseNotes";
import "./update-alert.css";

/**
 * "Update available" alert for the main window. Shown when a background check
 * finds a newer stable release (unless the DJ snoozed that version) or after a
 * manual "Check for updates". Rendered in App.tsx for every main-window screen.
 */
export default function UpdateAlert() {
  const { update, alertVisible, install, performing } = useAppUpdate();
  if (!alertVisible || !update) return null;

  const onWindows = isWindows();
  const { progress } = install;
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  let body: React.ReactNode;
  let actions: React.ReactNode = null;

  switch (install.status) {
    case "idle":
      body = (
        <>
          {performing && (
            <p className="ua-note warn">
              A track is playing: Now Playing sync pauses for a moment while the app restarts.
            </p>
          )}
          <p className="ua-note">
            {onWindows
              ? "The installer closes and reopens Decks Bridge."
              : "Decks Bridge restarts to finish updating."}{" "}
            Your pairing and settings are kept.
          </p>
        </>
      );
      actions = (
        <>
          <button type="button" className="ua-btn primary" onClick={() => void appUpdater.updateNow()}>
            Update Now
          </button>
          <button type="button" className="ua-btn secondary" onClick={() => appUpdater.remindLater()}>
            Remind Me Later
          </button>
        </>
      );
      break;

    case "downloading":
      body = (
        <div>
          <div className="ua-status">Downloading update…{pct !== null ? ` ${pct}%` : ""}</div>
          <div
            className="ua-progress"
            role="progressbar"
            aria-label="Download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span style={{ width: pct !== null ? `${pct}%` : "30%" }} />
          </div>
        </div>
      );
      break;

    case "installing":
      body = (
        <>
          <div className="ua-status">Installing…</div>
          <p className="ua-note">
            {onWindows
              ? "Decks Bridge will close while the installer runs, then reopen."
              : "macOS may ask for your password to replace the app."}
          </p>
        </>
      );
      break;

    case "restarting":
      body = <div className="ua-status">Restarting Decks Bridge…</div>;
      break;

    case "error":
      body = (
        <p className="ua-note error">
          {friendlyUpdateError(install.error?.kind ?? "failed", "install")}
        </p>
      );
      actions = (
        <>
          <button type="button" className="ua-btn primary" onClick={() => void appUpdater.updateNow()}>
            Try Again
          </button>
          <button type="button" className="ua-btn secondary" onClick={() => appUpdater.remindLater()}>
            Remind Me Later
          </button>
        </>
      );
      break;

    case "restart-failed":
      body = (
        <p className="ua-note">
          The update is installed. Restart Decks Bridge to finish — quit it and open it again if
          this button doesn't work.
        </p>
      );
      actions = (
        <>
          <button type="button" className="ua-btn primary" onClick={() => void appUpdater.restartNow()}>
            Restart Now
          </button>
          <button type="button" className="ua-btn secondary" onClick={() => appUpdater.remindLater()}>
            Later
          </button>
        </>
      );
      break;
  }

  const installed = install.status === "restarting" || install.status === "restart-failed";

  return (
    <section className="ua-card" role="region" aria-label="Decks Bridge update" aria-live="polite">
      <div>
        <div className="ua-eyebrow">{installed ? "Update installed" : "Update available"}</div>
        <h2 className="ua-title">Decks Bridge {update.version}</h2>
        <p className="ua-sub">You have version {update.currentVersion}.</p>
      </div>

      {update.body && (
        <div className="ua-notes-block">
          <div className="ua-notes-label">What's new</div>
          <div className="ua-notes" tabIndex={0}>
            {formatReleaseNotes(update.body)}
          </div>
        </div>
      )}

      {body}
      {actions && <div className="ua-actions">{actions}</div>}
    </section>
  );
}
