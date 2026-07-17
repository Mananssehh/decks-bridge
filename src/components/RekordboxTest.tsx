import { useState } from "react";
import { checkRekordbox, type RekordboxCheckResult } from "../lib/playback";
import { isMacOs } from "../lib/platform";
import { logDiagnostic } from "../lib/log";

/**
 * "Test rekordbox Detection". rekordbox doesn't publish to macOS Now Playing and
 * its library DB is encrypted, but rekordbox 7 exposes the loaded deck's title
 * and artist via the Accessibility API — Decks Bridge reads that. This button
 * confirms whether the current track can be read (needs Accessibility permission
 * and a track loaded/playing on a deck).
 */
export default function RekordboxTest() {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<RekordboxCheckResult | null>(null);
  const [reportCopied, setReportCopied] = useState(false);

  if (!isMacOs()) return null;

  async function run() {
    setTesting(true);
    setResult(null);
    try {
      const r = await checkRekordbox();
      setResult(r);
      logDiagnostic("diagnostics", `rekordbox test → ${r.status}`).catch(() => undefined);
    } catch (err) {
      setResult({
        rekordboxRunning: false, bundleId: "", pid: null, appPath: "", version: "",
        accessibilityTrusted: false, mediaRemoteResult: "", axElementCount: 0,
        dbPath: "", dbReadable: false, dbEncrypted: false, title: null, artist: null,
        method: "", status: "error", verdict: `Test failed: ${String(err)}`,
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
      <div style={{ fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>
        rekordbox <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(via Accessibility)</span>
      </div>
      <div style={{ color: "var(--text-muted)", marginBottom: 8 }}>
        Reads the current deck's title + artist from rekordbox (needs Accessibility permission).
      </div>

      <button
        type="button"
        onClick={run}
        disabled={testing}
        style={{
          width: "100%", background: "var(--surface2)", border: "1px solid var(--border)",
          borderRadius: 6, padding: "8px 10px", color: "var(--text)", fontSize: 12,
          fontWeight: 600, cursor: testing ? "default" : "pointer",
        }}
      >
        {testing ? "Testing…" : "Test rekordbox Detection"}
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
                ✓ rekordbox detected
              </div>
              <div>Source: <span style={{ color: "var(--text)" }}>rekordbox</span></div>
              <div>Method: <span style={{ color: "var(--text)" }}>{result.method}</span></div>
              <div>Title: <span style={{ color: "var(--text)", fontWeight: 600 }}>{result.title}</span></div>
              <div>Artist: <span style={{ color: "var(--text)" }}>{result.artist ?? "—"}</span></div>
            </div>
          ) : (
            <div
              style={{
                borderRadius: 6, border: "1px solid rgba(239,165,0,0.35)",
                background: "rgba(239,165,0,0.08)", padding: "8px 10px", color: "#f59e0b",
              }}
            >
              {result.status === "rekordbox_not_running" && <div>rekordbox is not open.</div>}
              {result.status === "not_readable" && (
                <div>
                  rekordbox is open, but Decks Bridge could not read the current title/artist
                  yet. Grant <b>Accessibility</b> permission (System Settings → Privacy &amp;
                  Security → Accessibility), then load and <b>play</b> a track on a deck and
                  re-test. If it still fails, use <b>Manual Mode</b>.
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
