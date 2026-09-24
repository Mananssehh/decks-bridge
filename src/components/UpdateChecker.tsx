import { appUpdater, useAppUpdate } from "../hooks/useAppUpdate";
import { friendlyUpdateError } from "../lib/errors";

interface Props {
  onDismiss?: () => void;
}

/**
 * Settings → Updates: manual "Check for updates" plus the last check's result.
 * Uses the same controller as the update alert, so a manual check and a
 * background check can never run side by side.
 */
export default function UpdateChecker({ onDismiss }: Props) {
  const { check, update, alertVisible } = useAppUpdate();
  const checking = check.status === "checking";

  let status: string;
  switch (check.status) {
    case "checking":
      status = "Checking for updates…";
      break;
    case "up-to-date":
      status = `You're up to date${check.currentVersion ? ` (version ${check.currentVersion})` : ""}.`;
      break;
    case "available":
      status = update ? `Decks Bridge ${update.version} is available.` : "An update is available.";
      break;
    case "error":
      status = friendlyUpdateError(check.error?.kind ?? "failed", "check");
      break;
    case "disabled":
      status = "Update checks are off in development builds.";
      break;
    case "idle":
      status = "Decks Bridge checks for updates when it opens and every few hours.";
      break;
  }

  return (
    <div>
      <div className="bx-panel-title">
        <span>Updates</span>
        {onDismiss && (
          <button type="button" className="bx-textlink" onClick={onDismiss}>
            Close
          </button>
        )}
      </div>
      <div
        className={`bx-note ${check.status === "error" ? "error" : check.status === "up-to-date" ? "success" : "info"}`}
        style={{ marginTop: 12 }}
        aria-live="polite"
      >
        {status}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          className="bx-btn-ghost"
          disabled={checking}
          onClick={() => void appUpdater.checkNow({ manual: true })}
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {update && !alertVisible && (
          <button type="button" className="bx-btn-primary" onClick={() => appUpdater.showAlert()}>
            View update
          </button>
        )}
      </div>
    </div>
  );
}
