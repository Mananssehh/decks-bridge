// Regression tests for the SyncEngine send-failure backoff.
//
// BACKOFF_MS shipped as dead code: backoffIdx was incremented and reset
// diligently but the schedule was never read, so a failing backend was retried
// every POLL_MS (3s) forever. With thousands of DJs running Bridge that turns a
// backend blip into a sustained stampede from every client at once.
//
// The engine takes injectable deps precisely so it can be driven without the
// Tauri/browser runtime — these tests use that seam.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { SyncEngine, BACKOFF_MS, POLL_MS } from "./syncEngine";
import type { DetectedTrack } from "./playback";

const CONFIG = { url: "https://x.test/ingest", token: "t", eventId: "e" };

const TRACK: DetectedTrack = {
  title: "Song",
  artist: "Artist",
  album: null,
  isPlaying: true,
  source: "test",
  playbackApp: "test",
  error: null,
  diagnostics: null,
};

function makeEngine(send: ReturnType<typeof vi.fn>) {
  const engine = new SyncEngine({
    detect: async () => TRACK,
    send: send as never,
    log: () => {},
  });
  engine.configure(CONFIG, "auto");
  return engine;
}

let engine: SyncEngine | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  vi.useRealTimers();
});

describe("send backoff", () => {
  it("slows retries down instead of hammering every 3s", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, httpStatus: 500 });
    engine = makeEngine(send);
    engine.start();

    // t=0 first send fails -> hold 1s (BACKOFF_MS[0])
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // t=3000 hold expired -> retry, fails -> hold 2s
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send).toHaveBeenCalledTimes(2);

    // t=6000 hold expired -> retry, fails -> hold 5s (until t=11000)
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send).toHaveBeenCalledTimes(3);

    // t=9000 detector still ticks, but the send is HELD by the 5s backoff.
    // Before the fix this was a 4th send. This is the assertion that matters.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send).toHaveBeenCalledTimes(3);

    // t=12000 hold expired -> retry
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("degrades to the longest step under a sustained outage", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, httpStatus: 503 });
    engine = makeEngine(send);
    engine.start();

    // Drive 60s of a hard outage.
    await vi.advanceTimersByTimeAsync(60_000);
    const callsInFirstMinute = send.mock.calls.length;

    // Unfixed, this would be 60_000/3_000 = 20 sends. The schedule tops out at
    // 30s, so a sustained outage must produce far fewer.
    expect(callsInFirstMinute).toBeLessThan(10);

    // And the next full minute should be ~2 sends (30s cap), not 20.
    send.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("recovers immediately once a send succeeds", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, httpStatus: 500 })
      .mockResolvedValueOnce({ ok: false, httpStatus: 500 })
      .mockResolvedValueOnce({ ok: false, httpStatus: 500 })
      .mockResolvedValue({ ok: true, httpStatus: 200 });
    engine = makeEngine(send);
    engine.start();

    // Burn through three failures into a 5s hold.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send).toHaveBeenCalledTimes(3);

    // The next allowed retry succeeds and must clear the backoff outright.
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    const afterSuccess = send.mock.calls.length;

    // Heartbeat cadence resumes; no lingering hold. The track is unchanged and
    // now delivered, so the engine idles rather than resending every tick.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(send.mock.calls.length).toBe(afterSuccess);
  });

  it("lets an explicit Sync Now bypass the hold", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, httpStatus: 500 });
    engine = makeEngine(send);
    engine.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const held = send.mock.calls.length; // now inside a 5s hold

    // A DJ pressing Sync Now is an explicit instruction and must not be
    // silently swallowed by the backoff.
    engine.syncNow("manual");
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.length).toBe(held + 1);
  });

  it("exposes a schedule that actually ends at the documented cap", () => {
    expect(BACKOFF_MS[BACKOFF_MS.length - 1]).toBe(30_000);
    expect(BACKOFF_MS[0]).toBeLessThan(POLL_MS);
  });
});
