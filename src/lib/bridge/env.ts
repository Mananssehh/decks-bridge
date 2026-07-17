// ── Build-mode flags + the production mock safeguard ─────────────────────────
//
// `VITE_MOCK_DATA=true` selects the MockBridgeProvider (development only). In a
// production build this MUST be impossible — `assertMockAllowed()` throws, and a
// separate build-time check (scripts/check-no-mock.mjs) fails the release build
// before this code even ships. Production therefore never silently renders mock
// data; if live data is unavailable the UI shows an honest state instead.

export const IS_PROD = import.meta.env.PROD === true;

export const MOCK_ENABLED =
  String(import.meta.env.VITE_MOCK_DATA ?? "").toLowerCase() === "true";

export class MockInProductionError extends Error {
  constructor() {
    super(
      "MOCK_DATA is enabled in a production build. Mock data must never ship. " +
        "Unset VITE_MOCK_DATA for production builds."
    );
    this.name = "MockInProductionError";
  }
}

/** Throws if mock is requested in a production build. Call before using mock. */
export function assertMockAllowed(): void {
  if (IS_PROD && MOCK_ENABLED) throw new MockInProductionError();
}

/** True only when we should actually construct the mock provider. */
export function shouldUseMock(): boolean {
  if (IS_PROD) return false; // hard stop — never mock in production
  return MOCK_ENABLED;
}
