import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tauriConfRaw from "../../src-tauri/tauri.conf.json?raw";
import capabilitiesRaw from "../../src-tauri/capabilities/default.json?raw";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return unlisten;
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const { UPDATE_MANIFEST_URL, checkForUpdate, installUpdate, toUpdateFailure } = await import(
  "./updater"
);

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockReset();
  listeners.clear();
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updater configuration", () => {
  const conf = JSON.parse(tauriConfRaw);
  const updater = conf.plugins.updater;

  it("checks the latest published GitHub release, not a branch", () => {
    // /releases/latest/ only ever serves a published, non-pre-release release,
    // so ordinary pushes and pre-release tags can never reach installed apps.
    expect(updater.endpoints).toEqual([UPDATE_MANIFEST_URL]);
    expect(UPDATE_MANIFEST_URL).toMatch(
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/latest\.json$/
    );
  });

  it("pins a minisign public key for signature verification", () => {
    const decoded = atob(updater.pubkey);
    expect(decoded).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}\n/);
    expect(updater.dangerousInsecureTransportProtocol).toBeUndefined();
    expect(updater.dangerousAcceptInvalidCerts).toBeUndefined();
  });

  it("does not expose the JS updater API to the webview", () => {
    // Updates go through our Rust commands, which enforce the stable-only
    // policy; the plugin's JS API would allow e.g. `allowDowngrades`.
    const { permissions } = JSON.parse(capabilitiesRaw) as { permissions: string[] };
    expect(permissions.filter((p) => p.startsWith("updater:"))).toEqual([]);
    expect(permissions).toContain("process:allow-restart");
  });
});

describe("checkForUpdate", () => {
  it("reports an available update", async () => {
    const info = { version: "0.2.0", currentVersion: "0.1.0", body: "Notes" };
    invoke.mockResolvedValueOnce(info);
    await expect(checkForUpdate()).resolves.toEqual({ status: "available", info });
    expect(invoke).toHaveBeenCalledWith("check_for_update");
  });

  it("reports up to date with the running version", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(checkForUpdate()).resolves.toEqual({ status: "up-to-date", currentVersion: "0.1.0" });
  });

  it("returns typed errors instead of throwing", async () => {
    invoke.mockRejectedValueOnce({ kind: "no-release", message: "Could not fetch" });
    await expect(checkForUpdate()).resolves.toEqual({
      status: "error",
      error: { kind: "no-release", message: "Could not fetch" },
    });
  });

  it("never checks from a development build", async () => {
    vi.stubEnv("DEV", true);
    await expect(checkForUpdate()).resolves.toEqual({ status: "disabled" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("installUpdate", () => {
  it("forwards progress and install events, then cleans up listeners", async () => {
    const onProgress = vi.fn();
    const onInstalling = vi.fn();
    invoke.mockImplementationOnce(async () => {
      listeners.get("update://progress")?.({ payload: { downloaded: 10, total: 20 } });
      listeners.get("update://installing")?.({ payload: null });
    });

    await installUpdate({ onProgress, onInstalling });

    expect(invoke).toHaveBeenCalledWith("install_update");
    expect(onProgress).toHaveBeenCalledWith({ downloaded: 10, total: 20 });
    expect(onInstalling).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("rejects with a typed failure and still cleans up", async () => {
    invoke.mockRejectedValueOnce({ kind: "signature", message: "bad sig" });
    await expect(installUpdate()).rejects.toEqual({ kind: "signature", message: "bad sig" });
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});

describe("toUpdateFailure", () => {
  it("keeps known error kinds from Rust", () => {
    expect(toUpdateFailure({ kind: "permission", message: "denied" })).toEqual({
      kind: "permission",
      message: "denied",
    });
  });

  it("maps anything else to a generic failure", () => {
    expect(toUpdateFailure("IPC error")).toEqual({ kind: "failed", message: "IPC error" });
    expect(toUpdateFailure(new Error("boom"))).toEqual({ kind: "failed", message: "boom" });
    expect(toUpdateFailure({ kind: "made-up", message: "x" })).toEqual({ kind: "failed", message: "x" });
    expect(toUpdateFailure(null)).toEqual({ kind: "failed", message: "null" });
  });
});
