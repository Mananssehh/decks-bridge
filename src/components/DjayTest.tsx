import { useState } from "react";
import { checkDjay, type DjayCheckResult } from "../lib/playback";
import { isMacOs } from "../lib/platform";
import { logDiagnostic } from "../lib/log";

/**
 * One-click "Test djay Pro Detection". Runs the app's `check_djay` command
 * (Accessibility trust + djay AX read only — no blocking prompts) and shows a
 * clear success/failure result. Reachable from the pairing screen AND the
 * Diagnostics panel so testers can confirm djay detection without Terminal,
 * with or without pairing.
 */
export default function DjayTest() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<DjayCheckResult | null>(null);
  const [reportCopied, setReportCopied] = useState(false);

  if (!isMacOs()) return null;

  async function run() {
    setTesting(true);
    setResult(null);
    try {
      const r = await checkDjay();
      setResult(r);
      logDiagnostic("diagnostics", `djay test → ${r.status}`).catch(() => undefined);
    } catch (err) {
      setResult({
        accessibilityTrusted: false,
        djayRunning: false,
        pids: [],
        title: null,
        artist: null,
        source: "none",
        appPath: "",
        expectedPath: "/Applications/Decks Bridge.app",
        correctLocation: false,
        status: "error",
        report: `Test failed: ${String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  }

  async function copyReport() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.report);
      setReportCopied(true);
      setTimeout(() => setReportCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div style={{ fontSize: 11, fontFamily: "monospace", lineHeight: 1.6 }}>
      <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>djay Pro</div>
      <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
        Checks if Decks Bridge can read the current djay Pro track.
      </div>

      <button
        type="button"
        onClick={run}
        disabled={testing}
        style={{
          width: "100%",
          background: "var(--accent)",
          border: "none",
          borderRadius: 6,
          padding: "8px 10px",
          color: "#fff",
          fontSize: 12,
          fontWeight: 600,
          cursor: testing ? "default" : "pointer",
        }}
      >
        {testing ? "Testing…" : "Test djay Pro Detection"}
      </button>

      {result && (
        <div style={{ marginTop: 8 }}>
          {result.status === "detected" ? (
            <div
              style={{
                borderRadius: 6,
                border: "1px solid rgba(34,197,94,0.35)",
                background: "rgba(34,197,94,0.08)",
                padding: "8px 10px",
              }}
            >
              <div style={{ color: "#22c55e", fontWeight: 700, marginBottom: 2 }}>
                ✓ djay Pro detected successfully
              </div>
              <div>Accessibility: <span style={{ color: "var(--text)" }}>Granted</span></div>
              <div>Source: <span style={{ color: "var(--text)" }}>djay Pro</span></div>
              <div>Title: <span style={{ color: "var(--text)", fontWeight: 600 }}>{result.title}</span></div>
              <div>Artist: <span style={{ color: "var(--text)" }}>{result.artist ?? "—"}</span></div>
            </div>
          ) : (
            <div
              style={{
                borderRadius: 6,
                border: "1px solid rgba(239,165,0,0.35)",
                background: "rgba(239,165,0,0.08)",
                padding: "8px 10px",
                color: "#f59e0b",
              }}
            >
              {result.status === "not_trusted" && (
                <span>
                  Decks Bridge needs Accessibility permission. Go to System Settings →
                  Privacy &amp; Security → Accessibility and enable Decks Bridge.
                </span>
              )}
              {result.status === "djay_not_running" && <span>djay Pro is not open.</span>}
              {result.status === "djay_no_track" && (
                <span>djay Pro is open, but no track is currently detected.</span>
              )}
              {(result.status === "error" || result.status === "unsupported") && (
                <span>{result.report}</span>
              )}
            </div>
          )}

          {!result.correctLocation && result.appPath && (
            <div
              style={{
                marginTop: 6,
                borderRadius: 6,
                border: "1px solid rgba(239,68,68,0.35)",
                background: "rgba(239,68,68,0.08)",
                padding: "8px 10px",
                color: "#ef4444",
                wordBreak: "break-all",
              }}
            >
              Running from the wrong copy.
              <div>running: {result.appPath}</div>
              <div>expected: {result.expectedPath}</div>
              <div style={{ marginTop: 2 }}>
                Quit all copies and open <b>/Applications/Decks Bridge.app</b>.
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={copyReport}
            style={{
              marginTop: 6,
              width: "100%",
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              color: "var(--text)",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            {reportCopied ? "Copied!" : "Copy Diagnostic Report"}
          </button>
        </div>
      )}
    </div>
  );
}
