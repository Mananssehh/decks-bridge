// ── Small display formatters for the viewer surfaces ─────────────────────────

/** "just now" / "12s ago" / "4m ago" / "1h 3m ago" from an ISO timestamp. */
export function timeAgo(iso: string | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** "2h 14m" event-duration label from an ISO start time. */
export function durationSince(iso: string | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const total = Math.max(0, Math.floor((nowMs - t) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "2h 14m" from a raw seconds count (backend-provided event duration). */
export function formatDurationSeconds(total: number | undefined): string {
  if (total == null || !Number.isFinite(total) || total < 0) return "—";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "$",
  AUD: "$",
};

/** "$185" / "$19.50" — compact money for tip displays. */
export function money(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency?.toUpperCase()] ?? "";
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  const num = hasCents ? amount.toFixed(2) : String(Math.round(amount));
  return sym ? `${sym}${num}` : `${num} ${currency}`;
}
