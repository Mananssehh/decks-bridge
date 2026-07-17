// ── MockBridgeProvider — DEVELOPMENT ONLY ────────────────────────────────────
//
// Produces a gently-evolving snapshot so layout, animation, polling, sync-
// confidence, and the high-value-tip alert can all be exercised without a live
// backend. Every snapshot is stamped `__mock: true` so the UI shows the MOCK
// badge. The factory refuses to construct this in production builds.

import type { BridgeSnapshot, Tip, QueueItem, TrendingSong } from "./types";
import type { BridgeDataProvider } from "./provider";

const TRACKS = [
  { title: "Midnight City", artist: "M83" },
  { title: "On The Low", artist: "Burna Boy" },
  { title: "Last Last", artist: "Burna Boy" },
  { title: "Essence", artist: "Wizkid" },
  { title: "Rush", artist: "Ayra Starr" },
];

const NAMES = ["Ava", "Marco", "Jules", "Kojo", "Nia", "Sam", "Zara", "Deb"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class MockBridgeProvider implements BridgeDataProvider {
  readonly kind = "mock" as const;

  private tick = 0;
  private startedAt = Date.now() - (2 * 60 * 60 * 1000 + 14 * 60 * 1000);
  private npIndex = 0;
  private guests = 87;
  private queue: QueueItem[] = [
    { id: "q1", title: "One Dance", artist: "Drake", votes: 42, status: "approved", requestedAt: this.ago(180_000), requesterName: "Ava" },
    { id: "q2", title: "Levels", artist: "Avicii", votes: 31, status: "pending", requestedAt: this.ago(150_000) },
    { id: "q3", title: "Titanium", artist: "David Guetta", votes: 27, status: "pending", requestedAt: this.ago(120_000), requesterName: "Marco" },
    { id: "q4", title: "Blinding Lights", artist: "The Weeknd", votes: 19, status: "pending", requestedAt: this.ago(90_000) },
    { id: "q5", title: "Sunflower", artist: "Post Malone", votes: 12, status: "played", requestedAt: this.ago(600_000) },
  ];
  private tips: Tip[] = [
    { id: "tip1", amount: 20, currency: "USD", displayName: "Ava", message: "Play One Dance! 🙏", createdAt: this.ago(45_000) },
    { id: "tip2", amount: 10, currency: "USD", displayName: "Marco", createdAt: this.ago(210_000) },
    { id: "tip3", amount: 5, currency: "USD", displayName: "Jules", message: "Killing it tonight", createdAt: this.ago(480_000) },
  ];
  private tipTotal = 185;
  private tipCount = 14;

  private ago(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
  }

  async getSnapshot(): Promise<BridgeSnapshot> {
    this.tick += 1;

    // Votes tick up on random queue items.
    for (const q of this.queue) {
      if (q.status !== "played" && q.status !== "rejected" && Math.random() < 0.4) {
        q.votes += Math.floor(Math.random() * 3);
      }
    }

    // Occasionally a new tip arrives — every ~4th poll, and every ~12th is a
    // high-value tip so the alert threshold can be exercised.
    if (this.tick % 4 === 0) {
      const highValue = this.tick % 12 === 0;
      const amount = highValue ? pick([15, 20, 50]) : pick([2, 3, 5]);
      const linked = pick(this.queue.filter((q) => q.status !== "played"));
      const tip: Tip = {
        id: `tip-${this.tick}`,
        amount,
        currency: "USD",
        displayName: pick(NAMES),
        message: highValue && linked ? `Play ${linked.title}!` : undefined,
        createdAt: new Date().toISOString(),
      };
      this.tips = [tip, ...this.tips].slice(0, 12);
      this.tipTotal += amount;
      this.tipCount += 1;
    }

    // Now Playing advances occasionally.
    if (this.tick % 15 === 0) this.npIndex = (this.npIndex + 1) % TRACKS.length;
    const np = TRACKS[this.npIndex];

    // Guests drift.
    this.guests = Math.max(20, this.guests + Math.floor(Math.random() * 5) - 2);

    const trending: TrendingSong[] = [...this.queue]
      .filter((q) => q.status !== "played" && q.status !== "rejected")
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 5)
      .map((q, i) => ({
        id: `t-${q.id}`,
        title: q.title,
        artist: q.artist,
        votes: q.votes,
        rank: i + 1,
        requestCount: 1 + (q.votes % 4),
        tipTotal: q.votes > 30 ? 25 : 0,
        queuePosition: i + 1,
        requestStatus: q.status,
      }));

    return {
      eventName: "Skyline Rooftop — Saturday",
      venue: "Skyline Rooftop",
      djName: "Nova",
      eventStatus: "live",
      roomCode: "SKY42",
      connectionStatus: "connected",
      nowPlaying: {
        title: np.title,
        artist: np.artist,
        source: "djay Pro",
        startedAt: this.ago(72_000),
        status: "playing",
      },
      queue: this.queue.map((q, i) => ({
        ...q,
        queuePosition: i + 1,
        requestCount: 1 + (q.votes % 5),
        tipTotal: q.votes > 25 ? 20 : 0,
      })),
      trending,
      tips: this.tips.map((t) => ({
        ...t,
        netAmount: Math.round(t.amount * 0.9 * 100) / 100,
        songTitle: t.message ? "One Dance" : undefined,
        paymentStatus: "succeeded",
      })),
      tipTotals: { total: this.tipTotal, pending: 12, count: this.tipCount, currency: "USD" },
      guestsOnline: this.guests,
      eventStartedAt: new Date(this.startedAt).toISOString(),
      eventDurationSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      bridgeLastSeen: this.ago(2_000),
      bridgeLastSync: this.ago(2_000),
      bridgeSourceType: "djay",
      updatedAt: new Date().toISOString(),
      __mock: true,
    };
  }
}
