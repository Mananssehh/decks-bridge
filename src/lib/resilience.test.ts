// Field-condition tests: the things that actually happen to a DJ mid-set.
//
// Internet drops, laptop sleeps, the backend rate-limits, storage fills up,
// the token expires, the set runs eight hours. Each of these is cheap to
// simulate and expensive to discover in production.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine, POLL_MS, HEARTBEAT_MS } from "./syncEngine";
import type { DetectedTrack } from "./playback";

const CONFIG = { url: "https://x.test/ingest", token: "t", eventId: "e" };

const track = (title: string): DetectedTrack => ({
  title,
  artist: "A",
  album: null,
  isPlaying: true,
  source: "test",
  playbackApp: "test",
  error: null,
  diagnostics: null,
});

const NOTHING: DetectedTrack = {
  title: null,
  artist: null,
  album: null,
  isPlaying: false,
  source: null,
  playbackApp: null,
  error: null,
  diagnostics: null,
};

let engine: SyncEngine | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.useRealTimers();
});

describe("field conditions", () => {
  it("keeps detecting when the detector throws (DJ app crashed / permission revoked)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 });
    let calls = 0;
    engine = new SyncEngine({
      detect: async () => {
        calls++;
        throw new Error("osascript died");
      },
      send: send as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();

    // A throwing detector must not kill the loop — it has to keep polling so
    // detection recovers by itself when the DJ app comes back.
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(calls).toBeGreaterThan(3);
  });

  it("recovers automatically when the DJ app comes back", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 });
    let fail = true;
    engine = new SyncEngine({
      detect: async () => {
        if (fail) throw new Error("gone");
        return track("Back");
      },
      send: send as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(send).not.toHaveBeenCalled();

    fail = false; // DJ app relaunched
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(send).toHaveBeenCalled();
  });

  it("does not resend the same track forever (steady state is quiet)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 });
    engine = new SyncEngine({
      detect: async () => track("Same"),
      send: send as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();

    // Across 25s the track is unchanged: exactly one send, no chatter.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(send).toHaveBeenCalledTimes(1);

    // The heartbeat keeps backend state fresh without a change.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("survives an eight-hour set without unbounded work per tick", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 });
    let n = 0;
    engine = new SyncEngine({
      detect: async () => track(`Track ${Math.floor(n++ / 100)}`),
      send: send as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();

    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    // Sends are driven by track CHANGES + heartbeat, not by uptime: an
    // 8h set must not produce one send per poll (9,600).
    expect(send.mock.calls.length).toBeLessThan(2_000);
  });

  it("stops cleanly on dispose — no timer survives to fire later", async () => {
    const detect = vi.fn().mockResolvedValue(track("X"));
    engine = new SyncEngine({
      detect,
      send: (async () => ({ ok: true, httpStatus: 200 })) as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    engine.dispose();
    const after = detect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(detect.mock.calls.length).toBe(after); // loop is truly dead
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks the source paused rather than showing a stale song forever", async () => {
    let has = true;
    const statuses: string[] = [];
    engine = new SyncEngine({
      detect: async () => (has ? track("Playing") : NOTHING),
      send: (async () => ({ ok: true, httpStatus: 200 })) as never,
      log: () => {},
    });
    engine.onStatus = (s) => statuses.push(s.state);
    engine.configure(CONFIG, "auto");
    engine.start();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    has = false; // DJ stopped / app closed
    await vi.advanceTimersByTimeAsync(20_000); // past STALE_MS
    expect(statuses).toContain("paused");
  });

  it("does not send a track with no artist (incomplete metadata)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, httpStatus: 200 });
    engine = new SyncEngine({
      detect: async () => ({ ...track("T"), artist: null }),
      send: send as never,
      log: () => {},
    });
    engine.configure(CONFIG, "auto");
    engine.start();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });
});
