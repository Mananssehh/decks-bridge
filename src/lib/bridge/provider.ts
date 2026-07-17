// ── BridgeDataProvider — the seam between the viewer UI and its data source ───
//
// The viewer surfaces (expanded / mini / pill) never know whether they're
// looking at mock or live data — they only ever hold a `BridgeSnapshot`. The
// single polling loop lives in `useBridgeSnapshot`; a provider just answers
// `getSnapshot()`. This keeps "swap mock for live" a one-line factory change and
// guarantees production can be prevented from ever using mock (see factory.ts).

import type { BridgeSnapshot } from "./types";

export interface BridgeDataProvider {
  /** Fetch the current event snapshot. Throws `ProviderError` on failure. */
  getSnapshot(): Promise<BridgeSnapshot>;
  /**
   * Optional push channel. Providers that can stream (future realtime) may
   * implement this; polling providers leave it undefined and the hook drives
   * updates via `getSnapshot()` on its interval.
   */
  subscribe?(listener: (snapshot: BridgeSnapshot) => void): () => void;
  /** Release any resources (timers, sockets). Optional. */
  dispose?(): void;
  /** For diagnostics + the dev MOCK badge. */
  readonly kind: "mock" | "live";
}

/** Why a `getSnapshot()` call failed — lets the hook pick the right UI state. */
export type ProviderErrorKind =
  | "unauthorized" // 401/403 — pairing expired/invalid → prompt re-pair
  | "unavailable" // endpoint missing / not deployed yet (404/501)
  | "network" // offline / DNS / timeout
  | "server" // 5xx
  | "bad_response"; // 200 but unparseable / wrong shape

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}
