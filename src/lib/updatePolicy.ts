// Update rules that need no Tauri or DOM access: SemVer comparison and the
// "Remind Me Later" bookkeeping. Kept pure so every rule is unit-tested.

/** First background check after launch — late enough not to compete with startup. */
export const UPDATE_CHECK_INITIAL_DELAY_MS = 10_000;
/** Re-check cadence while the app stays open (a set can run all night). */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Retry sooner after a failed background check (e.g. offline at the venue). */
export const UPDATE_CHECK_RETRY_MS = 30 * 60 * 1000;
/** How long "Remind Me Later" hides the alert for the same version. */
export const UPDATE_REMIND_LATER_MS = 24 * 60 * 60 * 1000;

export const UPDATE_REMINDER_KEY = "decks_bridge_update_reminder";

// ── SemVer ────────────────────────────────────────────────────────────────────

export interface ParsedVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
}

// semver.org's reference pattern, plus an optional leading "v" (tags are v1.2.3).
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** Parses a SemVer string ("1.2.3", "v1.2.3-beta.1"); null when invalid. */
export function parseVersion(input: string): ParsedVersion | null {
  const m = SEMVER.exec(input.trim());
  if (!m) return null;
  return {
    major: m[1],
    minor: m[2],
    patch: m[3],
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

// Numeric identifiers never have leading zeros, so length-then-lexical order is
// exact numeric order without any precision limit.
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer precedence: negative if a < b, 0 if equal, positive if a > b. */
export function comparePrecedence(a: ParsedVersion, b: ParsedVersion): number {
  const core =
    compareNumeric(a.major, b.major) ||
    compareNumeric(a.minor, b.minor) ||
    compareNumeric(a.patch, b.patch);
  if (core !== 0) return core;

  // A release outranks any of its pre-releases (1.0.0 > 1.0.0-rc.1).
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const shared = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const c = compareIdentifier(a.prerelease[i], b.prerelease[i]);
    if (c !== 0) return c;
  }
  return a.prerelease.length - b.prerelease.length;
}

/**
 * Compares two version strings by SemVer precedence (build metadata ignored).
 * Throws on invalid input — use isNewerStableVersion() when input is untrusted.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version: ${!pa ? a : b}`);
  return Math.sign(comparePrecedence(pa, pb));
}

/** True when `candidate` is a stable (non-pre-release) version newer than `current`. */
export function isNewerStableVersion(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const cur = parseVersion(current);
  if (!c || !cur) return false;
  return c.prerelease.length === 0 && comparePrecedence(c, cur) > 0;
}

function sameVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.trim() === b.trim();
  return comparePrecedence(pa, pb) === 0;
}

// ── Remind Me Later ───────────────────────────────────────────────────────────

/** "Don't show the alert for `version` again before `remindAt` (epoch ms)." */
export interface UpdateReminder {
  version: string;
  remindAt: number;
}

export function createReminder(
  version: string,
  now: number,
  snoozeMs: number = UPDATE_REMIND_LATER_MS
): UpdateReminder {
  return { version, remindAt: now + snoozeMs };
}

/** Reads a stored reminder; anything malformed counts as no reminder. */
export function parseReminder(raw: string | null): UpdateReminder | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { version, remindAt } = value as Record<string, unknown>;
    if (typeof version !== "string" || !version) return null;
    if (typeof remindAt !== "number" || !Number.isFinite(remindAt)) return null;
    return { version, remindAt };
  } catch {
    return null;
  }
}

/**
 * Whether an available update should raise the alert.
 *
 * - A manual "Check for updates" always answers.
 * - A version the DJ snoozed stays hidden until its reminder time.
 * - Any other version (e.g. a newer release) shows immediately.
 */
export function shouldShowUpdateAlert(opts: {
  version: string;
  reminder: UpdateReminder | null;
  now: number;
  manual: boolean;
}): boolean {
  const { version, reminder, now, manual } = opts;
  if (manual || !reminder) return true;
  if (!sameVersion(version, reminder.version)) return true;
  // A reminder further out than one snooze means the clock moved backwards or
  // the stored value is bad; don't let it hide the update indefinitely.
  if (reminder.remindAt - now > UPDATE_REMIND_LATER_MS) return true;
  return now >= reminder.remindAt;
}
