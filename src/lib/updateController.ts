// Update flow shared by the update alert and the Settings "Updates" panel:
// launch + periodic background checks, "Update Now" and "Remind Me Later".
//
// Framework-free, with all I/O injected (Tauri calls, storage, clock, timers)
// so tests can drive every transition directly. The app-wide instance lives in
// hooks/useAppUpdate.ts and is started by the main window only.

import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_REMINDER_KEY,
  createReminder,
  parseReminder,
  shouldShowUpdateAlert,
  type UpdateReminder,
} from "./updatePolicy";
import {
  toUpdateFailure,
  type CheckResult,
  type InstallHandlers,
  type UpdateFailure,
  type UpdateInfo,
  type UpdateProgress,
} from "./updater";

export type CheckStatus = "idle" | "checking" | "up-to-date" | "available" | "error" | "disabled";

export type InstallStatus =
  | "idle"
  | "downloading"
  | "installing"
  | "restarting"
  | "error"
  | "restart-failed";

export interface UpdateState {
  /** Newest stable update found, or null when up to date / not checked yet. */
  update: UpdateInfo | null;
  /** The update alert is on screen. */
  alertVisible: boolean;
  check: {
    status: CheckStatus;
    /** When the last check finished (epoch ms). */
    finishedAt: number | null;
    /** The last (or running) check was a manual "Check for updates". */
    manual: boolean;
    error: UpdateFailure | null;
    currentVersion: string | null;
  };
  install: {
    status: InstallStatus;
    progress: UpdateProgress | null;
    error: UpdateFailure | null;
  };
  /** A track is playing; the alert warns that updating restarts the app. */
  performing: boolean;
}

export interface UpdateControllerDeps {
  check: () => Promise<CheckResult>;
  install: (handlers: InstallHandlers) => Promise<void>;
  relaunch: () => Promise<void>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log: (message: string) => void;
}

export interface UpdateController {
  getState(): UpdateState;
  subscribe(listener: () => void): () => void;
  /** Schedules the launch check and the periodic checks after it. */
  start(): void;
  stop(): void;
  /** A manual check always shows an available update, even a snoozed one. */
  checkNow(opts?: { manual?: boolean }): Promise<void>;
  updateNow(): Promise<void>;
  remindLater(): void;
  /** Retries the restart after an installed update. */
  restartNow(): Promise<void>;
  /** Re-opens the alert for the update already found (Settings panel). */
  showAlert(): void;
  setPerforming(performing: boolean): void;
}

const INSTALL_BUSY: readonly InstallStatus[] = ["downloading", "installing", "restarting"];

const IDLE_INSTALL: UpdateState["install"] = { status: "idle", progress: null, error: null };

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  let state: UpdateState = {
    update: null,
    alertVisible: false,
    check: { status: "idle", finishedAt: null, manual: false, error: null, currentVersion: null },
    install: IDLE_INSTALL,
    performing: false,
  };
  const listeners = new Set<() => void>();
  let started = false;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let manualQueued = false;

  function setState(next: Partial<UpdateState>): void {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  }

  const installBusy = () => INSTALL_BUSY.includes(state.install.status);

  function cancelTimer(): void {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  }

  function scheduleCheck(delayMs: number): void {
    cancelTimer();
    if (!started) return;
    timer = deps.setTimer(() => {
      timer = null;
      void checkNow();
    }, delayMs);
  }

  // Storage can throw (quota, disabled storage); a lost reminder only means
  // the alert may show again, so never let it break the update flow.
  function readReminder(): UpdateReminder | null {
    try {
      return parseReminder(deps.storage?.getItem(UPDATE_REMINDER_KEY) ?? null);
    } catch {
      return null;
    }
  }

  function writeReminder(reminder: UpdateReminder): void {
    try {
      deps.storage?.setItem(UPDATE_REMINDER_KEY, JSON.stringify(reminder));
    } catch {
      /* see readReminder */
    }
  }

  function clearReminder(): void {
    try {
      deps.storage?.removeItem(UPDATE_REMINDER_KEY);
    } catch {
      /* see readReminder */
    }
  }

  async function runCheck(manual: boolean): Promise<void> {
    setState({ check: { ...state.check, status: "checking", manual, error: null } });

    let result: CheckResult;
    try {
      result = await deps.check();
    } catch (err) {
      result = { status: "error", error: toUpdateFailure(err) };
    }
    // A manual request made while this check was running is answered by it.
    const effectiveManual = manual || manualQueued;
    manualQueued = false;
    const finishedAt = deps.now();
    const check = { ...state.check, finishedAt, manual: effectiveManual, error: null };

    // "Update Now" was pressed while this check ran; the install owns the
    // alert now, so only record the check outcome.
    if (installBusy()) {
      setState({
        check:
          result.status === "error"
            ? { ...check, status: "error", error: result.error }
            : { ...check, status: result.status === "available" ? "available" : "idle" },
      });
      return;
    }

    switch (result.status) {
      case "available": {
        const { info } = result;
        const show = shouldShowUpdateAlert({
          version: info.version,
          reminder: readReminder(),
          now: finishedAt,
          manual: effectiveManual,
        });
        deps.log(
          `update ${info.version} available (installed ${info.currentVersion})` +
            (show ? "" : "; snoozed by Remind Me Later")
        );
        const newVersion = state.update?.version !== info.version;
        setState({
          update: info,
          // Never re-open an alert the DJ is not looking at unless allowed, and
          // never stack a second one: it is a single flag.
          alertVisible: state.alertVisible || show,
          // A failed attempt at an older version says nothing about this one.
          install: newVersion && state.install.status === "error" ? IDLE_INSTALL : state.install,
          check: { ...check, status: "available", currentVersion: info.currentVersion },
        });
        break;
      }
      case "up-to-date":
        setState({
          update: null,
          alertVisible: false,
          install: IDLE_INSTALL,
          check: { ...check, status: "up-to-date", currentVersion: result.currentVersion },
        });
        break;
      case "disabled":
        setState({ check: { ...check, status: "disabled" } });
        return; // development build: no periodic checks
      case "error":
        // Background failures stay quiet (logged only). An update found by an
        // earlier check stays available.
        deps.log(`update check failed (${result.error.kind}): ${result.error.message}`);
        setState({ check: { ...check, status: "error", error: result.error } });
        break;
    }

    scheduleCheck(result.status === "error" ? UPDATE_CHECK_RETRY_MS : UPDATE_CHECK_INTERVAL_MS);
  }

  function checkNow(opts: { manual?: boolean } = {}): Promise<void> {
    const manual = opts.manual ?? false;
    if (installBusy()) return Promise.resolve();
    if (inFlight) {
      if (manual) manualQueued = true;
      return inFlight;
    }
    inFlight = runCheck(manual).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function updateNow(): Promise<void> {
    const target = state.update;
    if (!target || installBusy()) return;

    cancelTimer(); // no background checks while installing
    deps.log(`installing update ${target.version}`);
    setState({ alertVisible: true, install: { status: "downloading", progress: null, error: null } });

    try {
      await deps.install({
        onProgress: (progress) => {
          if (state.install.status === "downloading") {
            setState({ install: { ...state.install, progress } });
          }
        },
        onInstalling: () => {
          setState({ install: { status: "installing", progress: state.install.progress, error: null } });
        },
      });
    } catch (err) {
      const error = toUpdateFailure(err);
      deps.log(`update ${target.version} failed (${error.kind}): ${error.message}`);
      setState({ install: { status: "error", progress: null, error } });
      scheduleCheck(UPDATE_CHECK_INTERVAL_MS);
      return;
    }

    clearReminder();
    deps.log(`update ${target.version} installed; restarting`);
    await restartNow();
  }

  async function restartNow(): Promise<void> {
    setState({ install: { status: "restarting", progress: null, error: null } });
    try {
      await deps.relaunch();
    } catch (err) {
      const error = toUpdateFailure(err);
      deps.log(`restart after update failed: ${error.message}`);
      setState({ install: { status: "restart-failed", progress: null, error } });
    }
  }

  function remindLater(): void {
    if (installBusy()) return;
    const target = state.update;
    if (target && state.install.status !== "restart-failed") {
      writeReminder(createReminder(target.version, deps.now()));
      deps.log(`update ${target.version} snoozed`);
    }
    setState({ alertVisible: false, install: IDLE_INSTALL });
  }

  function showAlert(): void {
    if (state.update && !state.alertVisible) setState({ alertVisible: true });
  }

  function setPerforming(performing: boolean): void {
    if (state.performing !== performing) setState({ performing });
  }

  function start(): void {
    if (started) return;
    started = true;
    scheduleCheck(UPDATE_CHECK_INITIAL_DELAY_MS);
  }

  function stop(): void {
    started = false;
    cancelTimer();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
    checkNow,
    updateNow,
    remindLater,
    restartNow,
    showAlert,
    setPerforming,
  };
}
