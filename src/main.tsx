import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css"; // canonical design tokens — must load before index.css
import "./index.css";
import App from "./App";
import { viewerModeFromHash } from "./lib/windows";
import ViewerRoot from "./components/viewer/ViewerRoot";

// ── Crash screen ──────────────────────────────────────────────────────────────

export function CrashScreen({
  error,
  source,
  onReset,
  onReload,
}: {
  error: unknown;
  source: string;
  onReset?: () => void;
  onReload?: () => void;
}) {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";

  function handleReset() {
    try { localStorage.clear(); } catch { /* ignore */ }
    window.location.reload();
  }

  return (
    <div
      style={{
        padding: "32px 28px",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
        background: "#0e0e10",
        color: "#f0f0f0",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase",
                    letterSpacing: "0.08em", color: "#ef4444", marginBottom: 6 }}>
          Bridge failed to load · {source}
        </p>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Something went wrong</h1>
      </div>

      <div style={{ padding: "12px 14px", borderRadius: 8, marginBottom: 16,
                    background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)",
                    fontSize: 13, color: "#ef4444", wordBreak: "break-word" }}>
        {msg || "(no message)"}
      </div>

      {stack && (
        <pre style={{ fontSize: 10, color: "#444", whiteSpace: "pre-wrap",
                      wordBreak: "break-all", lineHeight: 1.6, overflow: "auto",
                      flexGrow: 1, marginBottom: 20 }}>
          {stack}
        </pre>
      )}

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          onClick={onReset ?? handleReset}
          style={{ width: "100%", padding: "13px", borderRadius: 10,
                   background: "#ef4444", color: "#fff", border: "none",
                   fontSize: 14, fontWeight: 700, cursor: "pointer" }}
        >
          Reset Bridge Config
        </button>
        <button
          onClick={onReload ?? (() => window.location.reload())}
          style={{ width: "100%", padding: "11px", borderRadius: 10,
                   background: "transparent", color: "#888",
                   border: "1px solid #2e2e34", fontSize: 13, cursor: "pointer" }}
        >
          Reload App
        </button>
      </div>

      <p style={{ marginTop: 10, fontSize: 11, color: "#3a3a3a", textAlign: "center" }}>
        Resetting clears your pairing. You can re-pair immediately after.
      </p>
    </div>
  );
}

// ── ErrorBoundary ─────────────────────────────────────────────────────────────
// Only catches synchronous render errors. Async errors must be caught at their
// source (try/catch in effects) — never use window.onerror to hijack the root.

const CRASH_LOG_KEY = "bridge_last_error";

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] render crash:", error.message);
    console.error("[ErrorBoundary] stack:", error.stack);
    console.error("[ErrorBoundary] component stack:", info.componentStack);

    // Persist crash so next startup can detect it and enter safe mode.
    try {
      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify({
        message: error.message,
        stack: error.stack ?? "",
        componentStack: info.componentStack ?? "",
        time: new Date().toISOString(),
        source: "render",
      }));
    } catch { /* storage might be unavailable */ }
  }

  render() {
    if (this.state.error) {
      return (
        <CrashScreen
          error={this.state.error}
          source="render error"
          onReset={() => {
            try { localStorage.clear(); } catch { /* ignore */ }
            window.location.reload();
          }}
          onReload={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// NOTE: Do NOT add window.addEventListener("error") or "unhandledrejection"
// here. Those events fire for Vite HMR WebSocket drops, Tauri internal scripts,
// and any other browser noise — calling createRoot() inside them creates a
// second React root on the same element, corrupting the fiber tree → white screen.
// Async errors belong in try/catch at their call site.

console.log("[bridge] main.tsx — bootstrapping");

// Which surface does this window render? Viewer windows carry a hash
// (#viewer/expanded|mini|pill); every other case is the original main app,
// whose startup path below is unchanged.
const viewerMode = viewerModeFromHash();

const rootEl = document.getElementById("root");
if (!rootEl) {
  // This can only happen if index.html is broken — just write directly to body.
  document.body.innerHTML =
    '<div style="color:#ef4444;padding:24px;background:#0e0e10;font-family:system-ui">Root element missing</div>';
} else {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        {viewerMode ? <ViewerRoot mode={viewerMode} /> : <App />}
      </ErrorBoundary>
    </React.StrictMode>
  );
}
