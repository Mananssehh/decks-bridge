// ── Provider factory ─────────────────────────────────────────────────────────
//
// The ONE place that decides mock vs live. Production can never receive a mock
// provider: `shouldUseMock()` returns false in prod, and `assertMockAllowed()`
// throws loudly if someone forced VITE_MOCK_DATA into a prod build.

import type { Config } from "../store";
import type { BridgeDataProvider } from "./provider";
import { MockBridgeProvider } from "./MockBridgeProvider";
import { LiveBridgeProvider } from "./LiveBridgeProvider";
import { assertMockAllowed, shouldUseMock } from "./env";

export function createBridgeProvider(config: Config | null): BridgeDataProvider | null {
  // `import.meta.env.DEV` is a compile-time literal, so in a production build
  // this whole branch is dead code — Rollup drops it AND tree-shakes the
  // MockBridgeProvider import, so no mock code is bundled into production.
  if (import.meta.env.DEV && shouldUseMock()) {
    assertMockAllowed(); // belt-and-suspenders: throws in prod
    return new MockBridgeProvider();
  }
  // Live mode with no pairing yet → no provider; the viewer shows "not paired".
  if (!config) return null;
  return new LiveBridgeProvider(config);
}
