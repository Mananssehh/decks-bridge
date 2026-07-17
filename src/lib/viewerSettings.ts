// ── Viewer settings — small, shared, persisted preferences ───────────────────
//
// All viewer windows share one origin, so localStorage is shared across the
// expanded / mini / pill webviews. These are plain UI preferences only — no
// tokens, no payment data, nothing secret is ever stored here.

const TIP_THRESHOLD_KEY = "decks_bridge_tip_alert_threshold";
const SHOW_SECONDARY_KEY = "decks_bridge_show_secondary";
const ALWAYS_ON_TOP_KEY = "decks_bridge_always_on_top";

const DEFAULT_TIP_THRESHOLD = 10; // dollars

export function getTipThreshold(): number {
  try {
    const raw = localStorage.getItem(TIP_THRESHOLD_KEY);
    const n = raw == null ? NaN : parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_TIP_THRESHOLD;
}

export function setTipThreshold(n: number): void {
  try {
    localStorage.setItem(TIP_THRESHOLD_KEY, String(Math.max(0, n)));
  } catch {
    /* ignore */
  }
}

/** Whether to show secondary metrics (guests online / event duration). */
export function getShowSecondary(): boolean {
  try {
    return localStorage.getItem(SHOW_SECONDARY_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setShowSecondary(v: boolean): void {
  try {
    localStorage.setItem(SHOW_SECONDARY_KEY, v ? "true" : "false");
  } catch {
    /* ignore */
  }
}

/** Always-on-top preference for the mini-player and pill (default on). */
export function getAlwaysOnTopPref(): boolean {
  try {
    return localStorage.getItem(ALWAYS_ON_TOP_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setAlwaysOnTopPref(v: boolean): void {
  try {
    localStorage.setItem(ALWAYS_ON_TOP_KEY, v ? "true" : "false");
  } catch {
    /* ignore */
  }
}
