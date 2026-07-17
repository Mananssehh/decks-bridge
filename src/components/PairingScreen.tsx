import { useState, useRef, useCallback, useEffect } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { friendlyPairError } from "../lib/errors";
import { saveConfig, type Config } from "../lib/store";
import { pairWithCode } from "../lib/pair";
import { sendHeartbeat } from "../lib/api";
import DjayTest from "./DjayTest";

interface Props {
  onPaired: (config: Config) => void;
  onManualSetup: () => void;
}

type PairStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; config: Config }
  | { kind: "error"; message: string };

export default function PairingScreen({ onPaired, onManualSetup }: Props) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const [status, setStatus] = useState<PairStatus>({ kind: "idle" });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>(Array(6).fill(null));

  const code = digits.join("");
  const ready = code.length === 6;
  const busy = status.kind === "connecting" || status.kind === "connected";

  const focusIndex = useCallback((i: number) => {
    inputRefs.current[Math.max(0, Math.min(5, i))]?.focus();
  }, []);

  // ── Deep-link listener ────────────────────────────────────────────────────
  // Keeps the latest triggerConnect reachable without re-registering the
  // listener. The callback used to close over the FIRST render's
  // triggerConnect, so its `busy` guard was permanently the initial `false` —
  // a deep link arriving mid-pair fired a second concurrent pairWithCode.
  const triggerConnectRef = useRef<(c: string) => void>(() => {});

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    onOpenUrl((urls) => {
      for (const url of urls) {
        const match = url.match(/^decksbridge:\/\/pair\?code=(\d{6})$/i);
        if (match) {
          const incoming = match[1];
          setDigits(incoming.split(""));
          triggerConnectRef.current(incoming);
          break;
        }
      }
    })
      .then((fn) => {
        // If we unmounted while onOpenUrl was still resolving, the old cleanup
        // ran with unlisten still null and the listener was never removed —
        // it leaked and then fired setState on an unmounted component.
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────
  async function triggerConnect(c: string) {
    if (c.length !== 6 || busy) return;
    console.log("[pair] → connecting with code", c);
    setStatus({ kind: "connecting" });

    const result = await pairWithCode(c);
    console.log("[pair] ← result", result);

    if (!result.ok || !result.config) {
      const msg = friendlyPairError(result.error ?? "Something went wrong.");
      console.error("[pair] failed:", msg, "debug:", result.debug);
      setStatus({ kind: "error", message: msg });
      setDigits(Array(6).fill(""));
      setTimeout(() => focusIndex(0), 50);
      return;
    }

    console.log("[pair] success — config:", {
      eventId: result.config.eventId,
      eventName: result.config.eventName,
      endpointHost: result.config.url ? new URL(result.config.url).host : "(missing)",
      hasToken: Boolean(result.config.token),
    });
    saveConfig(result.config);
    // Fire-and-forget: tells the website Bridge is connected without waiting for music.
    sendHeartbeat(result.config);
    setStatus({ kind: "connected", config: result.config });
    setTimeout(() => onPaired(result.config!), 900);
  }

  // Keep the deep-link listener pointed at the current closure (same idiom as
  // syncNowRef in NowPlaying) so its `busy` guard reflects live state.
  triggerConnectRef.current = triggerConnect;

  function handleConnect() {
    triggerConnect(code);
  }

  // ── OTP input handlers ────────────────────────────────────────────────────
  function handleChange(index: number, value: string) {
    if (busy) return;
    const digit = value.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = digit;
    setDigits(next);
    if (status.kind === "error") setStatus({ kind: "idle" });
    if (digit && index < 5) focusIndex(index + 1);
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (busy) return;
    if (e.key === "Backspace") {
      if (digits[index]) {
        const next = [...digits];
        next[index] = "";
        setDigits(next);
      } else if (index > 0) {
        focusIndex(index - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusIndex(index + 1);
    } else if (e.key === "Enter" && ready) {
      handleConnect();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (busy) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const next = Array(6).fill("").map((_, i) => pasted[i] ?? "");
    setDigits(next);
    if (status.kind === "error") setStatus({ kind: "idle" });
    focusIndex(Math.min(pasted.length, 5));
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const isConnected = status.kind === "connected";
  const isConnecting = status.kind === "connecting";
  const hasError = status.kind === "error";

  const borderFor = (d: string) =>
    isConnected ? "var(--success)"
    : hasError   ? "var(--error)"
    : d          ? "var(--accent)"
    :              "var(--border)";

  const btnLabel = isConnected ? "Connected ✓" : isConnecting ? "Connecting…" : "Connect";

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        padding: "44px 28px 32px",
        maxWidth: 420,
        margin: "0 auto",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Header */}
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
        Decks Bridge
      </h1>
      <p
        style={{
          fontSize: 14,
          color: "var(--text-muted)",
          textAlign: "center",
          lineHeight: 1.5,
        }}
      >
        Enter the 6-digit code from Decks.
      </p>

      {/* OTP inputs */}
      <div style={{ display: "flex", gap: 10, margin: "36px 0 0" }}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={d}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.target.select()}
            autoFocus={i === 0}
            disabled={busy}
            style={{
              width: 48,
              height: 58,
              textAlign: "center",
              fontSize: 26,
              fontWeight: 700,
              padding: 0,
              borderRadius: 10,
              border: `2px solid ${borderFor(d)}`,
              background: "var(--surface2)",
              color: isConnected ? "var(--success)" : "var(--text)",
              outline: "none",
              transition: "border-color 0.15s, color 0.15s",
              opacity: busy ? 0.7 : 1,
            }}
          />
        ))}
      </div>

      {/* Status messages */}
      <div style={{ width: "100%", marginTop: 16, minHeight: 44 }}>
        {isConnecting && (
          <p style={{ textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
            Connecting…
          </p>
        )}

        {isConnected && (
          <div className="status-msg success" style={{ textAlign: "center", fontSize: 13 }}>
            Connected — starting Auto Detect…
          </div>
        )}

        {hasError && (
          <div className="status-msg error" style={{ textAlign: "center", fontSize: 13 }}>
            {(status as { kind: "error"; message: string }).message}
          </div>
        )}
      </div>

      {/* Connect button */}
      <button
        className="btn-primary"
        style={{
          width: "100%",
          padding: "13px",
          fontSize: 15,
          marginTop: 8,
          background: isConnected ? "var(--success)" : undefined,
          transition: "background 0.2s",
        }}
        onClick={handleConnect}
        disabled={!ready || busy}
      >
        {btnLabel}
      </button>

      {/* Advanced setup — collapsible, pushed to bottom */}
      <div
        style={{
          marginTop: "auto",
          paddingTop: 40,
          width: "100%",
          textAlign: "center",
        }}
      >
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            background: "none",
            border: "none",
            padding: "4px 8px",
            color: "var(--text-muted)",
            fontSize: 12,
            cursor: "pointer",
            opacity: 0.6,
          }}
        >
          Advanced setup {showAdvanced ? "▲" : "▼"}
        </button>

        {showAdvanced && (
          <div style={{ marginTop: 12 }}>
            <button
              onClick={onManualSetup}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 20px",
                color: "var(--text-muted)",
                fontSize: 13,
                cursor: "pointer",
                width: "100%",
              }}
            >
              Manual configuration
            </button>
            <div
              style={{
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--border)",
                textAlign: "left",
              }}
            >
              <DjayTest />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
