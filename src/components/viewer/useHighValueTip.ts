import { useEffect, useRef, useState } from "react";
import type { Tip } from "../../lib/bridge/types";

interface Result {
  /** Tip ids currently highlighted as recent high-value boosts. */
  hotTipIds: Set<string>;
  /** The newest high-value tip to surface as a transient alert, or null. */
  latestBoost: Tip | null;
  dismissBoost: () => void;
}

/**
 * Detects NEW tips at/above `threshold` as they arrive in successive snapshots.
 * The first snapshot only seeds the "seen" set (so existing tips don't all fire
 * on open). Highlights last ~8s; the toast auto-dismisses after ~6s. No sound.
 */
export function useHighValueTip(tips: Tip[], threshold: number): Result {
  const seenRef = useRef<Set<string> | null>(null);
  const [hotTipIds, setHotTipIds] = useState<Set<string>>(new Set());
  const [latestBoost, setLatestBoost] = useState<Tip | null>(null);

  useEffect(() => {
    // Seed on first run — don't alert for tips that were already there.
    if (seenRef.current === null) {
      seenRef.current = new Set(tips.map((t) => t.id));
      return;
    }
    const seen = seenRef.current;
    const fresh = tips.filter((t) => !seen.has(t.id));
    fresh.forEach((t) => seen.add(t.id));

    const bigNew = fresh.filter((t) => t.amount >= threshold);
    if (bigNew.length === 0) return;

    const newest = bigNew[0];
    setHotTipIds((prev) => {
      const next = new Set(prev);
      bigNew.forEach((t) => next.add(t.id));
      return next;
    });
    setLatestBoost(newest);

    const hotTimer = setTimeout(() => {
      setHotTipIds((prev) => {
        const next = new Set(prev);
        bigNew.forEach((t) => next.delete(t.id));
        return next;
      });
    }, 8000);
    const toastTimer = setTimeout(() => setLatestBoost((c) => (c === newest ? null : c)), 6000);

    return () => {
      clearTimeout(hotTimer);
      clearTimeout(toastTimer);
    };
    // Keyed on the tip-id list + threshold so it re-runs when tips change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tips.map((t) => t.id).join(","), threshold]);

  return { hotTipIds, latestBoost, dismissBoost: () => setLatestBoost(null) };
}
