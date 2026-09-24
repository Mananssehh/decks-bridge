import { useState, useEffect, useRef } from "react";
import PairingScreen from "./components/PairingScreen";
import SetupScreen from "./components/SetupScreen";
import NowPlaying from "./components/NowPlaying";
import UpdateAlert from "./components/UpdateAlert";
import { appUpdater } from "./hooks/useAppUpdate";
import { loadConfig, clearConfig, resetAndReload, type Config } from "./lib/store";
import { CrashScreen } from "./main";

type Screen = "pairing" | "manual-setup" | "now-playing";

const CRASH_LOG_KEY  = "bridge_last_error";
const SAFE_MODE_KEY  = "bridge_safe_mode";
const STARTUP_TIMEOUT_MS = 5000;

// ── Loading screen ─────────────────────────────────────────────────────────────

function LoadingScreen({ timedOut }: { timedOut: boolean }) {
  if (timedOut) {
    return (
      <CrashScreen
        error="App startup timed out after 5 seconds."
        source="startup timeout"
        onReset={resetAndReload}
        onReload={() => window.location.reload()}
      />
    );
  }
  return (
    <div style={{ background: "#0e0e10", minHeight: "100vh", display: "flex",
                  alignItems: "center", justifyContent: "center", color: "#f0f0f0" }}>
      <span style={{ fontSize: 13, color: "#555" }}>Decks Bridge</span>
    </div>
  );
}

export default function App() {
  const [config, setConfig]     = useState<Config | null>(null);
  const [screen, setScreen]     = useState<Screen>("pairing");
  const [autoStart, setAutoStart] = useState(false);
  const [ready, setReady]       = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const readyRef = useRef(false); // for timeout closure

  // ── Viewer lifecycle host ──────────────────────────────────────────────────
  // The MAIN window owns viewer window lifecycle. Viewers emit a switch request;
  // this listener performs close → confirm gone → create, in that order, from a
  // context that is never destroyed mid-switch. Enforces the single-viewer rule.
  useEffect(() => {
    let un: (() => void) | undefined;
    void import("./lib/windows")
      .then((m) => m.initViewerHost())
      .then((fn) => {
        un = fn;
      })
      .catch((err) => console.error("[app] viewer host init failed:", err));
    return () => un?.();
  }, []);

  // ── Update checks ──────────────────────────────────────────────────────────
  // App renders only in the main window, so exactly one window checks for
  // updates: shortly after launch, then periodically while the app is open.
  useEffect(() => {
    appUpdater.start();
    return () => appUpdater.stop();
  }, []);

  // ── Startup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    console.log("[app] ── startup begin ──────────────────────────");
    console.log("[app] React mounted");

    // ── 1. Startup timeout guard ──────────────────────────────────────────
    const timeoutHandle = setTimeout(() => {
      if (!readyRef.current) {
        console.error("[app] STARTUP TIMEOUT — app did not become ready in 5 s");
        try {
          localStorage.setItem(CRASH_LOG_KEY, JSON.stringify({
            message: "Startup timeout",
            stack: "",
            time: new Date().toISOString(),
            source: "startup-timeout",
          }));
        } catch { /* ignore */ }
        setTimedOut(true);
        setReady(true);
      }
    }, STARTUP_TIMEOUT_MS);

    // ── 2. Safe mode check (previous crash) ──────────────────────────────
    let isSafeMode = false;
    try {
      const lastError = localStorage.getItem(CRASH_LOG_KEY);
      const requestedSafe = localStorage.getItem(SAFE_MODE_KEY);
      if (lastError || requestedSafe) {
        const parsed = lastError ? JSON.parse(lastError) : null;
        console.warn("[app] previous crash detected — entering safe mode:", parsed?.message ?? "unknown");
        isSafeMode = true;
        setSafeMode(true);
        // Clear the crash log so safe mode only fires once.
        localStorage.removeItem(CRASH_LOG_KEY);
        localStorage.removeItem(SAFE_MODE_KEY);
      }
    } catch (err) {
      console.error("[app] safe-mode check failed:", err);
    }

    // ── 3. Load config ────────────────────────────────────────────────────
    let saved: Config | null = null;
    try {
      saved = loadConfig();
      console.log("[app] config load:", saved
        ? `found (eventId=${saved.eventId} name=${saved.eventName ?? "(none)"})`
        : "not found");
    } catch (err) {
      console.error("[app] loadConfig threw:", err);
      saved = null;
    }

    // ── 4. Route selection ────────────────────────────────────────────────
    if (saved) {
      console.log("[app] route → now-playing");
      setConfig(saved);
      setScreen("now-playing");
    } else {
      console.log("[app] route → pairing");
    }

    // ── 5. Safe mode overrides ────────────────────────────────────────────
    if (isSafeMode) {
      console.log("[app] safe mode: autoStart disabled, MediaRemote polling disabled");
      // autoStart stays false — NowPlaying won't begin polling automatically.
    }

    readyRef.current = true;
    clearTimeout(timeoutHandle);
    setReady(true);
    console.log("[app] ── startup complete ─────────────────────────");
  }, []);

  // ── Main-window sizing ────────────────────────────────────────────────────
  // Pairing is a compact card; the Console needs real dimensions. Resize the
  // SAME window as the DJ crosses that boundary (Rec-A: main window = Console).
  useEffect(() => {
    if (!ready) return;
    const paired = screen === "now-playing" && !!config;
    void import("./lib/windows")
      .then((m) => (paired ? m.applyConsoleWindow() : m.applyPairingWindow()))
      .catch((err) => console.error("[app] window sizing failed:", err));
  }, [ready, screen, config]);

  // ── Render ────────────────────────────────────────────────────────────────
  // The outer shell div guarantees a dark background at the React layer
  // regardless of what the native window or WKWebView decides to paint.
  const shell = (children: React.ReactNode) => (
    <div style={{ background: "#0e0e10", color: "#f0f0f0", minHeight: "100vh" }}>
      {children}
      <UpdateAlert />
    </div>
  );

  if (!ready) return shell(<LoadingScreen timedOut={timedOut} />);

  if (screen === "now-playing" && config) {
    return shell(
      <>
        <NowPlaying
          config={config}
          autoStart={autoStart && !safeMode}
          safeMode={safeMode}
          onReset={() => {
            console.log("[app] reset → pairing");
            clearConfig();
            setConfig(null);
            setAutoStart(false);
            setSafeMode(false);
            setScreen("pairing");
          }}
        />
      </>
    );
  }

  if (screen === "manual-setup") {
    return shell(
      <SetupScreen
        onSave={(cfg) => {
          console.log("[app] manual setup → now-playing");
          setConfig(cfg);
          setAutoStart(false);
          setScreen("now-playing");
        }}
        onBack={() => setScreen("pairing")}
      />
    );
  }

  return shell(
    <PairingScreen
      onPaired={(cfg) => {
        console.log("[app] paired → now-playing, eventId:", cfg.eventId);
        setConfig(cfg);
        setAutoStart(true);
        setSafeMode(false);
        setScreen("now-playing");
      }}
      onManualSetup={() => setScreen("manual-setup")}
    />
  );
}
