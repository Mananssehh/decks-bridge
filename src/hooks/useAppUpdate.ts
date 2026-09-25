import { useSyncExternalStore } from "react";
import { createUpdateController, type UpdateState } from "../lib/updateController";
import { checkForUpdate, installUpdate, relaunchApp } from "../lib/updater";
import { logDiagnostic } from "../lib/log";

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The app-wide update controller. Only the main window starts it (App.tsx), so
 * viewer windows never run their own update checks.
 */
export const appUpdater = createUpdateController({
  check: checkForUpdate,
  install: installUpdate,
  relaunch: relaunchApp,
  storage: browserStorage(),
  now: () => Date.now(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle as number),
  log: (message) => void logDiagnostic("update", message),
});

export function useAppUpdate(): UpdateState {
  return useSyncExternalStore(appUpdater.subscribe, appUpdater.getState);
}
