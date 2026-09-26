// Migration + backwards-compatibility tests for the stored pairing.
//
// The contract these pin down: an existing DJ upgrading to a new build must
// NEVER be asked to pair again unless their credentials are genuinely
// unrecoverable. The previous loadConfig() deleted the whole config on any
// shape mismatch, which meant the first added field would have silently
// un-paired every installed user.

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { loadConfig, saveConfig, CONFIG_VERSION, INGEST_FALLBACK } = await import("./store");

const KEY = "decks_bridge_config";
const QUARANTINE = "decks_bridge_config_unreadable";

/** Exactly what builds up to and including 0.1.0 wrote: no version field. */
const V0_CONFIG = {
  url: "https://real.supabase.co/functions/v1/now-playing-ingest",
  token: "tok_live_abc123",
  eventId: "evt_789",
  eventName: "Friday Residency",
};

beforeEach(() => store.clear());

describe("upgrade from v0 (unversioned) config", () => {
  it("keeps an existing pairing intact — no re-pair", () => {
    store.set(KEY, JSON.stringify(V0_CONFIG));

    const cfg = loadConfig();

    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe("tok_live_abc123");
    expect(cfg!.eventId).toBe("evt_789");
    expect(cfg!.eventName).toBe("Friday Residency");
    expect(cfg!.url).toBe(V0_CONFIG.url);
  });

  it("stamps the version so the migration runs once, not every launch", () => {
    store.set(KEY, JSON.stringify(V0_CONFIG));
    loadConfig();

    const persisted = JSON.parse(store.get(KEY)!);
    expect(persisted.version).toBe(CONFIG_VERSION);
    expect(persisted.token).toBe("tok_live_abc123");
  });

  it("does not quarantine a healthy v0 config", () => {
    store.set(KEY, JSON.stringify(V0_CONFIG));
    loadConfig();
    expect(store.has(QUARANTINE)).toBe(false);
  });
});

describe("repair instead of forcing a re-pair", () => {
  it("recovers a config whose url is missing", () => {
    // url is reconstructible: every send site already falls back to the
    // default endpoint, so this must never cost the DJ their pairing.
    store.set(KEY, JSON.stringify({ token: "t", eventId: "e" }));

    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.url).toBe(INGEST_FALLBACK);
    expect(cfg!.token).toBe("t");
  });

  it("recovers a config whose url is non-https junk", () => {
    store.set(KEY, JSON.stringify({ url: "notaurl", token: "t", eventId: "e" }));
    expect(loadConfig()!.url).toBe(INGEST_FALLBACK);
  });

  it("drops a malformed eventName without losing the pairing", () => {
    store.set(KEY, JSON.stringify({ ...V0_CONFIG, eventName: { bad: true } }));

    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.token).toBe("tok_live_abc123");
    expect(cfg!.eventName).toBeUndefined();
  });

  it("tolerates unknown future fields rather than rejecting the config", () => {
    store.set(KEY, JSON.stringify({ ...V0_CONFIG, somethingNew: 42 }));
    expect(loadConfig()!.token).toBe("tok_live_abc123");
  });
});

describe("unrecoverable configs", () => {
  it("quarantines rather than destroys when credentials are missing", () => {
    const bad = JSON.stringify({ url: "https://x.test/i" }); // no token/eventId
    store.set(KEY, bad);

    expect(loadConfig()).toBeNull();
    // The old code called removeItem and the data was gone forever.
    expect(store.get(QUARANTINE)).toBe(bad);
    expect(store.has(KEY)).toBe(false);
  });

  it("quarantines unparseable JSON instead of deleting it", () => {
    store.set(KEY, "{not json");
    expect(loadConfig()).toBeNull();
    expect(store.get(QUARANTINE)).toBe("{not json");
  });

  it("returns null cleanly when nothing is stored", () => {
    expect(loadConfig()).toBeNull();
  });
});

describe("round trip", () => {
  it("saves and reloads a config unchanged", () => {
    saveConfig({ url: "https://a.test/i", token: "t", eventId: "e", eventName: "N" });
    const cfg = loadConfig();
    expect(cfg).toEqual({ url: "https://a.test/i", token: "t", eventId: "e", eventName: "N" });
  });

  it("does not leak the internal version field to callers", () => {
    saveConfig({ url: "https://a.test/i", token: "t", eventId: "e" });
    expect(loadConfig()).not.toHaveProperty("version");
  });
});
