// Regression tests for the offline queue.
//
// The queue is the DJ's set history while the venue wifi is down, so anything
// that silently drops entries is data loss the DJ cannot recover. These tests
// pin the exact failure that shipped: a mid-flush network error discarded every
// track queued after the failing one.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Stubs ────────────────────────────────────────────────────────────────────
// The queue module only touches localStorage, ./api (send) and ./log (diag).

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal("navigator", { onLine: true });

const sendMock = vi.fn();
vi.mock("./api", () => ({ sendNowPlaying: (...a: unknown[]) => sendMock(...a) }));
vi.mock("./log", () => ({ logDiagnostic: () => Promise.resolve() }));
vi.mock("./errors", () => ({ friendlyIngestError: (s: number) => `err ${s}` }));

const { enqueueTrack, flushOfflineQueue, getQueueLength } = await import("./offlineQueue");

const CONFIG = { url: "https://x.test/ingest", token: "t", eventId: "e" };
const ok = () => ({ ok: true, httpStatus: 200, message: "", requestUrl: "", responseBody: "" });
const fail = (httpStatus: number) => ({
  ok: false,
  httpStatus,
  message: "",
  requestUrl: "",
  responseBody: "",
});

const titles = () =>
  JSON.parse(store.get("decks_bridge_offline_queue") ?? "[]").map(
    (q: { track: { title: string } }) => q.track.title
  );

beforeEach(() => {
  store.clear();
  sendMock.mockReset();
});

describe("flushOfflineQueue", () => {
  it("keeps every untried track when the network drops mid-flush", async () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });
    enqueueTrack({ title: "C", artist: "x" });

    // A sends, B hits a network error (httpStatus 0), C is never attempted.
    sendMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail(0));

    const sent = await flushOfflineQueue(CONFIG);

    expect(sent).toBe(1);
    // The shipped bug pushed only B and dropped C entirely.
    expect(titles()).toEqual(["B", "C"]);
  });

  it("keeps the untried remainder when auth is rejected mid-flush", async () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });
    enqueueTrack({ title: "C", artist: "x" });

    sendMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail(401));

    await flushOfflineQueue(CONFIG);
    expect(titles()).toEqual(["B", "C"]);
  });

  it("skips a track the server rejects but continues the rest", async () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });

    // A is rejected 422 (kept for later), B succeeds.
    sendMock.mockResolvedValueOnce(fail(422)).mockResolvedValueOnce(ok());

    const sent = await flushOfflineQueue(CONFIG);
    expect(sent).toBe(1);
    expect(titles()).toEqual(["A"]);
  });

  it("empties the queue when everything sends", async () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });
    sendMock.mockResolvedValue(ok());

    expect(await flushOfflineQueue(CONFIG)).toBe(2);
    expect(getQueueLength()).toBe(0);
  });
});

describe("enqueueTrack", () => {
  it("does not spam duplicates from the repeating detector tick", () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "A", artist: "x" });
    expect(titles()).toEqual(["A"]);
  });

  it("preserves a genuine replay later in the set", () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });
    enqueueTrack({ title: "A", artist: "x" }); // DJ plays A again
    // Whole-queue dedupe used to drop this, leaving the event on the wrong track.
    expect(titles()).toEqual(["A", "B", "A"]);
  });

  it("survives storage being full instead of throwing", () => {
    enqueueTrack({ title: "A", artist: "x" });
    enqueueTrack({ title: "B", artist: "x" });

    const real = store.set.bind(store);
    let calls = 0;
    vi.spyOn(store, "set").mockImplementation((k, v) => {
      // Fail the first write (quota), allow the shed-oldest retry.
      if (calls++ === 0) throw new DOMException("quota", "QuotaExceededError");
      return real(k, v);
    });

    expect(() => enqueueTrack({ title: "C", artist: "x" })).not.toThrow();
    vi.restoreAllMocks();
  });
});
