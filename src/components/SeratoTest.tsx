import { useState } from "react";
import { checkSerato, type SeratoCheckResult } from "../lib/playback";
import { isMacOs } from "../lib/platform";
import { logDiagnostic } from "../lib/log";

/**
 * "Test Serato Pro Detection" — Serato DJ Pro is detected through its local
 * SQLite play history (…/Serato/Library/master.sqlite), NOT via macOS Now
 * Playing (which Serato doesn't publish and macOS blocks). Serato DJ Lite has
 * no such history DB, so it isn't supported.
 */
export default function SeratoTest() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SeratoCheckResult | null>(null);
  const [reportCopied, setReportCopied] = useState(false);

  if (!isMacOs()) return null;

  async function run() {
    setTesting(true);
    setResult(null);
    try {
      const r = await checkSerato();
      setResult(r);
      logDiagnostic("diagnostics", `serato test → ${r.status}`).catch(() => undefined);
    } catch (err) {
      setResult({
        seratoFound: false, edition: "", bundleId: "", pid: null, appPath: "",
        accessibilityTrusted: false, mediaRemoteResult: "", axElementCount: 0,
        readableText: false, dbPath: "", dbReadable: false, latestHistoryId: null,
        deck: null, isPlaying: false, title: null, artist: null, method: "",
        status: "error", verdict: `Test failed: ${String(err)}`, report: `Test failed: ${String(err)}`,
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
      <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>Serato DJ Pro</div>
      <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
        Reads your current Serato DJ Pro track from Serato's history database.
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
        {testing ? "Testing…" : "Test Serato Pro Detection"}
      </button>

      {result && (
        <div style={{ marginTop: 8 }}>
          {result.status === "detected" ? (
            <div
              style={{
                borderRadius: 6, border: "1px solid rgba(34,197,94,0.35)",
                background: "rgba(34,197,94,0.08)", padding: "8px 10px",
              }}
            >
              <div style={{ color: "#22c55e", fontWeight: 700, marginBottom: 2 }}>
                ✓ Serato DJ Pro detected
              </div>
              <div>Source: <span style={{ color: "var(--text)" }}>Serato DJ Pro</span></div>
              <div>Method: <span style={{ color: "var(--text)" }}>{result.method}</span></div>
              <div>Title: <span style={{ color: "var(--text)", fontWeight: 600 }}>{result.title}</span></div>
              <div>Artist: <span style={{ color: "var(--text)" }}>{result.artist ?? "—"}</span></div>
              {result.deck && (
                <div style={{ color: "var(--text-muted)", marginTop: 2 }}>Deck {result.deck}</div>
              )}
            </div>
          ) : (
            <div
              style={{
                borderRadius: 6, border: "1px solid rgba(239,165,0,0.35)",
                background: "rgba(239,165,0,0.08)", padding: "8px 10px", color: "#f59e0b",
              }}
            >
              {result.status === "serato_not_running" && <div>Serato DJ Pro is not open.</div>}
              {result.status === "not_exposed" && result.edition === "Serato DJ Pro" && (
                <div>
                  Serato DJ Pro is open, but no current history entry was found. Load and
                  play a track, then test again.
                </div>
              )}
              {result.status === "not_exposed" && result.edition !== "Serato DJ Pro" && (
                <div>
                  Serato DJ Lite is open, but it does not record a play history and exposes
                  no metadata. <b>Use Manual Mode</b> — only Serato DJ <b>Pro</b> is supported.
                </div>
              )}
              {result.status === "error" && <div>{result.report}</div>}
            </div>
          )}

          <button
            type="button"
            onClick={copyReport}
            style={{
              marginTop: 6, width: "100%", background: "var(--surface2)",
              border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px",
              color: "var(--text)", fontSize: 11, cursor: "pointer",
            }}
          >
            {reportCopied ? "Copied!" : "Copy Diagnostic Report"}
          </button>
        </div>
      )}
    </div>
  );
}
