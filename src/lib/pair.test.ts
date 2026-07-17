// Secret-redaction tests for the pairing flow.
//
// The bridge-pair success body carries `ingest_token` — the DJ's long-lived
// credential for their event. It was previously written verbatim to the console
// and the pairing code was written to the on-disk diagnostic log, which support
// may be sent. These tests pin the redaction so a future refactor cannot
// quietly reintroduce the leak.

import { describe, expect, it } from "vitest";
import { redactBody } from "./pair";

const REAL_SUCCESS_BODY = JSON.stringify({
  ingest_token: "tok_live_SUPERSECRET_abc123",
  event_id: "evt_1",
  event_name: "Friday Residency",
  endpoint_url: "https://x.supabase.co/functions/v1/now-playing-ingest",
});

describe("redactBody", () => {
  it("removes the ingest token from a real success body", () => {
    const out = redactBody(REAL_SUCCESS_BODY);
    expect(out).not.toContain("tok_live_SUPERSECRET_abc123");
    expect(out).toContain("(redacted)");
  });

  it("keeps the non-secret fields usable for debugging", () => {
    const out = JSON.parse(redactBody(REAL_SUCCESS_BODY));
    expect(out.event_id).toBe("evt_1");
    expect(out.event_name).toBe("Friday Residency");
    expect(out.endpoint_url).toContain("supabase.co");
  });

  it("redacts secret-ish field names generally, not just ingest_token", () => {
    const body = JSON.stringify({
      access_token: "a",
      refreshToken: "b",
      apiKey: "c",
      client_secret: "d",
      password: "e",
      authorization: "f",
      safe: "keep",
    });
    const out = JSON.parse(redactBody(body));
    for (const k of [
      "access_token",
      "refreshToken",
      "apiKey",
      "client_secret",
      "password",
      "authorization",
    ]) {
      expect(out[k]).toBe("(redacted)");
    }
    expect(out.safe).toBe("keep");
  });

  it("truncates a non-JSON body rather than echoing it unbounded", () => {
    const html = "<html>" + "x".repeat(5_000) + "</html>";
    const out = redactBody(html);
    expect(out.length).toBeLessThan(250);
    expect(out).toContain("truncated");
  });

  it("passes through short non-JSON bodies unchanged", () => {
    expect(redactBody("Not Found")).toBe("Not Found");
  });

  it("handles an empty body without throwing", () => {
    expect(redactBody("")).toBe("");
  });

  it("does not choke on a JSON array or scalar", () => {
    expect(() => redactBody("[1,2,3]")).not.toThrow();
    expect(() => redactBody('"just a string"')).not.toThrow();
    expect(() => redactBody("42")).not.toThrow();
  });
});
