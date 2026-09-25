import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdateController, type UpdateControllerDeps } from "./updateController";
import {
  UPDATE_CHECK_INITIAL_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_RETRY_MS,
  UPDATE_REMINDER_KEY,
  UPDATE_REMIND_LATER_MS,
} from "./updatePolicy";
import type { CheckResult, InstallHandlers, UpdateFailure } from "./updater";

const available = (version: string, body: string | null = "Bug fixes."): CheckResult => ({
  status: "available",
  info: { version, currentVersion: "0.1.0", body },
});
const upToDate: CheckResult = { status: "up-to-date", currentVersion: "0.1.0" };
const failure = (kind: UpdateFailure["kind"]): UpdateFailure => ({ kind, message: `${kind} detail` });

/** A promise the test resolves or rejects by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(storage = new Map<string, string>()) {
  const check = vi.fn<() => Promise<CheckResult>>().mockResolvedValue(upToDate);
  const install = vi.fn<(handlers: InstallHandlers) => Promise<void>>().mockResolvedValue();
  const relaunch = vi.fn<() => Promise<void>>().mockResolvedValue();
  const log = vi.fn<(message: string) => void>();
  const deps: UpdateControllerDeps = {
    check,
    install,
    relaunch,
    log,
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const controller = createUpdateController(deps);
  return { controller, check, install, relaunch, log, storage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T20:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduling", () => {
  it("checks shortly after launch, then periodically while open", async () => {
    const { controller, check } = setup();
    controller.start();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("retries sooner after a failed background check", async () => {
    const { controller, check } = setup();
    check.mockResolvedValueOnce({ status: "error", error: failure("network") });
    controller.start();

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_RETRY_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("start() is idempotent and stop() cancels pending checks", async () => {
    const { controller, check } = setup();
    controller.start();
    controller.start();
    controller.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(check).not.toHaveBeenCalled();
  });

  it("stops checking in development builds", async () => {
    const { controller, check } = setup();
    check.mockResolvedValue({ status: "disabled" });
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS + UPDATE_CHECK_INTERVAL_MS * 3);
    expect(check).toHaveBeenCalledTimes(1);
    expect(controller.getState().check.status).toBe("disabled");
    expect(controller.getState().alertVisible).toBe(false);
  });
});

describe("update available", () => {
  it("shows the alert with the version and release notes", async () => {
    const { controller, check } = setup();
    check.mockResolvedValue(available("0.2.0", "- Faster djay detection"));
    await controller.checkNow();

    const state = controller.getState();
    expect(state.alertVisible).toBe(true);
    expect(state.update).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      body: "- Faster djay detection",
    });
    expect(state.check.status).toBe("available");
  });

  it("keeps the open alert as-is when later checks find the same version", async () => {
    const { controller, check } = setup();
    check.mockResolvedValue(available("0.2.0"));

    await controller.checkNow();
    await controller.checkNow();
    expect(controller.getState().alertVisible).toBe(true);
    expect(controller.getState().update?.version).toBe("0.2.0");
    expect(controller.getState().install.status).toBe("idle");
  });

  it("does not show anything when up to date", async () => {
    const { controller } = setup();
    await controller.checkNow();
    expect(controller.getState().alertVisible).toBe(false);
    expect(controller.getState().update).toBeNull();
    expect(controller.getState().check).toMatchObject({ status: "up-to-date", currentVersion: "0.1.0" });
  });

  it("hides a stale alert when the release is gone", async () => {
    const { controller, check } = setup();
    check.mockResolvedValueOnce(available("0.2.0")).mockResolvedValueOnce(upToDate);
    await controller.checkNow();
    await controller.checkNow();
    expect(controller.getState().alertVisible).toBe(false);
    expect(controller.getState().update).toBeNull();
  });

  it("keeps an update found earlier when a later check fails", async () => {
    const { controller, check } = setup();
    check
      .mockResolvedValueOnce(available("0.2.0"))
      .mockResolvedValueOnce({ status: "error", error: failure("network") });
    await controller.checkNow();
    await controller.checkNow();

    const state = controller.getState();
    expect(state.alertVisible).toBe(true);
    expect(state.update?.version).toBe("0.2.0");
    expect(state.check.error?.kind).toBe("network");
  });

  it("keeps background check failures out of the alert", async () => {
    const { controller, check, log } = setup();
    check.mockResolvedValue({ status: "error", error: failure("no-release") });
    await controller.checkNow();

    expect(controller.getState().alertVisible).toBe(false);
    expect(controller.getState().check).toMatchObject({ status: "error", error: { kind: "no-release" } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no-release"));
  });

  it("treats a check that throws like a failed check", async () => {
    const { controller, check } = setup();
    check.mockRejectedValue(new Error("boom"));
    await controller.checkNow();
    expect(controller.getState().check).toMatchObject({ status: "error", error: { kind: "failed" } });
  });
});

describe("Remind Me Later", () => {
  it("hides the alert and does not show the same version again until the reminder is due", async () => {
    const { controller, check, storage } = setup();
    check.mockResolvedValue(available("0.2.0"));
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS);
    expect(controller.getState().alertVisible).toBe(true);

    controller.remindLater();
    expect(controller.getState().alertVisible).toBe(false);
    expect(JSON.parse(storage.get(UPDATE_REMINDER_KEY)!)).toMatchObject({ version: "0.2.0" });

    // Periodic checks keep running but stay quiet for the snoozed version…
    const checksBefore = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 5);
    expect(check.mock.calls.length).toBeGreaterThan(checksBefore);
    expect(controller.getState().alertVisible).toBe(false);

    // …until the reminder is due, when the next check shows it again.
    await vi.advanceTimersByTimeAsync(UPDATE_REMIND_LATER_MS);
    expect(controller.getState().alertVisible).toBe(true);
  });

  it("is remembered across app restarts", async () => {
    const storage = new Map<string, string>();
    const first = setup(storage);
    first.check.mockResolvedValue(available("0.2.0"));
    await first.controller.checkNow();
    first.controller.remindLater();

    const second = setup(storage);
    second.check.mockResolvedValue(available("0.2.0"));
    await second.controller.checkNow();
    expect(second.controller.getState().alertVisible).toBe(false);
    expect(second.controller.getState().update?.version).toBe("0.2.0");
  });

  it("does not hide a newer release", async () => {
    const { controller, check } = setup();
    check.mockResolvedValueOnce(available("0.2.0")).mockResolvedValueOnce(available("0.3.0"));
    await controller.checkNow();
    controller.remindLater();

    await controller.checkNow();
    expect(controller.getState().alertVisible).toBe(true);
    expect(controller.getState().update?.version).toBe("0.3.0");
  });

  it("is overridden by a manual check", async () => {
    const { controller, check } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();
    controller.remindLater();

    await controller.checkNow({ manual: true });
    expect(controller.getState().alertVisible).toBe(true);
  });

  it("honors a manual check requested while a background check is running", async () => {
    const { controller, check } = setup();
    check.mockResolvedValueOnce(available("0.2.0"));
    await controller.checkNow();
    controller.remindLater();

    const pending = deferred<CheckResult>();
    check.mockReturnValueOnce(pending.promise);
    const background = controller.checkNow();
    const manual = controller.checkNow({ manual: true });
    expect(check).toHaveBeenCalledTimes(2); // joined the running check

    pending.resolve(available("0.2.0"));
    await Promise.all([background, manual]);
    expect(controller.getState().alertVisible).toBe(true);
  });

  it("can re-open a snoozed alert from Settings", async () => {
    const { controller, check } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();
    controller.remindLater();

    controller.showAlert();
    expect(controller.getState().alertVisible).toBe(true);
  });

  it("survives storage that throws", async () => {
    const fail = () => {
      throw new Error("storage unavailable");
    };
    const controller = createUpdateController({
      check: vi.fn<() => Promise<CheckResult>>().mockResolvedValue(available("0.2.0")),
      install: vi.fn(),
      relaunch: vi.fn(),
      log: vi.fn(),
      storage: { getItem: fail, setItem: fail, removeItem: fail },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });

    await controller.checkNow();
    expect(controller.getState().alertVisible).toBe(true);
    expect(() => controller.remindLater()).not.toThrow();
    expect(controller.getState().alertVisible).toBe(false);
  });
});

describe("Update Now", () => {
  it("downloads, installs and restarts, reporting progress", async () => {
    const { controller, check, install, relaunch, storage } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();
    controller.remindLater();
    await controller.checkNow({ manual: true });

    const seen: string[] = [];
    controller.subscribe(() => {
      const { status, progress } = controller.getState().install;
      seen.push(progress ? `${status}:${progress.downloaded}` : status);
    });
    install.mockImplementation(async ({ onProgress, onInstalling }) => {
      onProgress?.({ downloaded: 50, total: 100 });
      onProgress?.({ downloaded: 100, total: 100 });
      onInstalling?.();
    });

    await controller.updateNow();

    expect(seen).toEqual([
      "downloading",
      "downloading:50",
      "downloading:100",
      "installing:100",
      "restarting",
    ]);
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(storage.has(UPDATE_REMINDER_KEY)).toBe(false);
  });

  it("shows install errors in the alert and allows a retry", async () => {
    const { controller, check, install, relaunch } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();

    install.mockRejectedValueOnce(failure("signature"));
    await controller.updateNow();

    let state = controller.getState();
    expect(state.install).toMatchObject({ status: "error", error: { kind: "signature" } });
    expect(state.alertVisible).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();

    await controller.updateNow();
    state = controller.getState();
    expect(install).toHaveBeenCalledTimes(2);
    expect(state.install.status).toBe("restarting");
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("clears an install error when a newer version replaces the failed one", async () => {
    const { controller, check, install } = setup();
    check.mockResolvedValueOnce(available("0.2.0")).mockResolvedValueOnce(available("0.2.0"));
    await controller.checkNow();
    install.mockRejectedValueOnce(failure("network"));
    await controller.updateNow();

    await controller.checkNow(); // same version: the error stays visible
    expect(controller.getState().install.status).toBe("error");

    check.mockResolvedValueOnce(available("0.3.0"));
    await controller.checkNow();
    expect(controller.getState().update?.version).toBe("0.3.0");
    expect(controller.getState().install).toEqual({ status: "idle", progress: null, error: null });
  });

  it("normalizes unexpected install errors", async () => {
    const { controller, check, install } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();
    install.mockRejectedValueOnce("IPC went away");
    await controller.updateNow();
    expect(controller.getState().install.error).toEqual({ kind: "failed", message: "IPC went away" });
  });

  it("reports a failed restart and can retry it", async () => {
    const { controller, check, relaunch } = setup();
    check.mockResolvedValue(available("0.2.0"));
    await controller.checkNow();
    relaunch.mockRejectedValueOnce(new Error("not allowed"));

    await controller.updateNow();
    expect(controller.getState().install.status).toBe("restart-failed");

    await controller.restartNow();
    expect(relaunch).toHaveBeenCalledTimes(2);
    expect(controller.getState().install.status).toBe("restarting");
  });

  it("ignores repeat clicks, Remind Me Later and checks while installing", async () => {
    const { controller, check, install } = setup();
    check.mockResolvedValue(available("0.2.0"));
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS);
    expect(check).toHaveBeenCalledTimes(1);

    const pending = deferred();
    install.mockReturnValueOnce(pending.promise);
    const first = controller.updateNow();
    void controller.updateNow();
    controller.remindLater();
    await controller.checkNow({ manual: true });
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);

    expect(install).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(controller.getState().alertVisible).toBe(true);
    expect(controller.getState().install.status).toBe("downloading");

    pending.resolve();
    await first;
    expect(controller.getState().install.status).toBe("restarting");
  });

  it("resumes background checks after a failed install", async () => {
    const { controller, check, install } = setup();
    check.mockResolvedValue(available("0.2.0"));
    controller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INITIAL_DELAY_MS);

    install.mockRejectedValueOnce(failure("network"));
    await controller.updateNow();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no update is known", async () => {
    const { controller, install } = setup();
    await controller.updateNow();
    expect(install).not.toHaveBeenCalled();
  });
});

describe("performing flag", () => {
  it("tracks whether a track is live", () => {
    const { controller } = setup();
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.setPerforming(true);
    controller.setPerforming(true);
    expect(controller.getState().performing).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    controller.setPerforming(false);
    expect(controller.getState().performing).toBe(false);
  });
});
