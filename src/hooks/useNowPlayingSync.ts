import { useCallback, useEffect, useRef, useState } from "react";
import type { Config } from "../lib/store";
import type { NowPlayingSource } from "../lib/playback";
import { SyncEngine, type SyncStatus } from "../lib/syncEngine";

interface Options {
  config: Config;
  source: NowPlayingSource;
  /** Run detection when true (auto-detect on AND a real source selected). */
  enabled: boolean;
  /** Called after every send with whether it succeeded (feeds ingest status). */
  onIngest: (ok: boolean) => void;
}

const INITIAL: SyncStatus = {
  running: false,
  source: "auto",
  state: "stopped",
  detected: null,
  lastCheckedAt: null,
  lastSentAt: null,
  lastSentTrack: null,
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
};

/**
 * Owns exactly one SyncEngine for the component's lifetime. The engine runs the
 * single detection→send loop; this hook just wires it to React state and starts/
 * stops it as config, source, or enablement change. Returns live status plus a
 * `syncNow` for the manual backup button and the engine for reconnect wiring.
 */
export function useNowPlayingSync({ config, source, enabled, onIngest }: Options) {
  const engineRef = useRef<SyncEngine | null>(null);
  if (!engineRef.current) engineRef.current = new SyncEngine();
  const [status, setStatus] = useState<SyncStatus>(INITIAL);

  // Keep engine callbacks current without restarting the loop.
  useEffect(() => {
    const e = engineRef.current!;
    e.onStatus = setStatus;
    e.onIngest = onIngest;
  }, [onIngest]);

  // Configure + start/stop. Depend on primitive keys so a new-but-equal config
  // object from the parent never thrashes the loop.
  useEffect(() => {
    const e = engineRef.current!;
    e.configure(config, source);
    if (enabled) e.start();
    else e.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.eventId, config.token, config.url, source, enabled]);

  // Tear the engine down for good on unmount.
  useEffect(() => {
    const e = engineRef.current!;
    return () => e.dispose();
  }, []);

  const syncNow = useCallback(() => {
    engineRef.current?.syncNow("manual");
  }, []);

  return { status, syncNow, engine: engineRef.current };
}
