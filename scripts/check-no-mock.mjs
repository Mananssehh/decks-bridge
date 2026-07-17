#!/usr/bin/env node
// Production build guard: refuse to build a release bundle with mock data on.
//
// `npm run build` produces a PRODUCTION bundle (vite build). Mock data must
// never ship, so if VITE_MOCK_DATA is truthy in the environment at build time,
// fail loudly before tsc/vite run. Dev mock lives in .env.development, which
// Vite only loads for `vite` (dev) — never for `vite build` — so normal
// development is unaffected.

const v = String(process.env.VITE_MOCK_DATA ?? "").toLowerCase();
if (v === "true" || v === "1" || v === "yes") {
  console.error(
    "\n✖ Refusing to build: VITE_MOCK_DATA is enabled.\n" +
      "  Mock data must never ship in a production build.\n" +
      "  Unset VITE_MOCK_DATA and rebuild.\n"
  );
  process.exit(1);
}
console.log("✓ mock-data guard: production build is clean (no mock).");
