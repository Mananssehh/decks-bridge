import { useState } from "react";
import { saveConfig, type Config } from "../lib/store";

interface Props {
  onSave: (config: Config) => void;
  onBack?: () => void;
}

export default function SetupScreen({ onSave, onBack }: Props) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [eventId, setEventId] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!url.trim() || !token.trim() || !eventId.trim()) {
      setError("All fields are required.");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setError("Edge Function URL is not a valid URL.");
      return;
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      setError("URL must use http or https.");
      return;
    }

    const config: Config = {
      url: url.trim(),
      token: token.trim(),
      eventId: eventId.trim(),
    };
    saveConfig(config);
    onSave(config);
  }

  return (
    <div style={{ padding: "32px 28px", maxWidth: 420, margin: "0 auto" }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--text-muted)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              ← Back
            </button>
          )}
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Advanced Setup</h1>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          Manually enter your Edge Function URL and ingest token.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="url">Edge Function URL</label>
          <input
            id="url"
            type="text"
            placeholder="https://xxx.supabase.co/functions/v1/now-playing-ingest"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="token">Ingest Token</label>
          <input
            id="token"
            type="password"
            placeholder="your-secret-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label htmlFor="eventId">Event ID</label>
          <input
            id="eventId"
            type="text"
            placeholder="e.g. event_abc123"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {error && (
          <div className="status-msg error" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary">
          Save &amp; Continue
        </button>
      </form>
    </div>
  );
}
