# `bridge-event-snapshot` — Backend Contract

**Status: NOT YET IMPLEMENTED.** This document is the exact contract the Decks
Bridge viewer needs from the backend. It is written so it can be implemented
against the real Lovable/Supabase schema **without guessing**. Bridge already
speaks to this shape through `LiveBridgeProvider`
([src/lib/bridge/LiveBridgeProvider.ts](../src/lib/bridge/LiveBridgeProvider.ts),
added in Phase 2); only the server side remains.

The response mirrors `BridgeSnapshot` in
[src/lib/bridge/types.ts](../src/lib/bridge/types.ts) — keep the two in sync.

---

## 1. Endpoint

```
POST /functions/v1/bridge-event-snapshot
```

A Supabase Edge Function alongside the existing `bridge-pair` and
`now-playing-ingest` functions on project `rwdgnapajxcxktmewlxb`.

- **Read-only.** It performs no writes and must never accept mutations.
- **Same-origin as ingest.** Bridge derives the base URL from the paired
  `endpoint_url` returned at pairing time, so no new host/config is introduced.

## 2. Request

### Headers
| Header | Value | Notes |
|---|---|---|
| `Content-Type` | `application/json` | |
| `X-Ingest-Token` | `<paired ingest token>` | The **existing** token from `bridge-pair` (`Config.token`). No new secret is minted for Bridge. |

> The token is the sole credential. The server resolves the event from it — the
> client never sends anything that could target another event.

### Body
```json
{ "event_id": "optional-echo-of-paired-event" }
```
`event_id` is optional and, if present, must be **ignored for authorization** —
the event is always resolved server-side from the token. It exists only so the
server may 409/403 if the token and body disagree (defense-in-depth).

## 3. Response — `200 OK`

Exact JSON shape (fields map 1:1 to `BridgeSnapshot`):

```jsonc
{
  "eventName": "Skyline Rooftop — Saturday",
  "connectionStatus": "connected",          // "connected" | "waiting_dj" | "disconnected"
  "nowPlaying": {                            // or null when nothing is playing
    "title": "Midnight City",
    "artist": "M83",
    "albumArt": "https://…",                // optional
    "source": "djay Pro",                   // optional (detected DJ app)
    "startedAt": "2026-07-13T02:14:00Z"     // optional ISO 8601
  },
  "queue": [
    {
      "id": "uuid",
      "title": "One Dance",
      "artist": "Drake",
      "votes": 42,
      "status": "approved",                 // "pending"|"approved"|"playing"|"played"|"rejected"
      "requestedAt": "2026-07-13T02:10:00Z", // ISO 8601
      "requesterName": "Ava"                 // optional, display-only handle
    }
  ],
  "trending": [
    { "id": "uuid", "title": "One Dance", "artist": "Drake", "votes": 42, "rank": 1 }
  ],
  "tips": [
    {
      "id": "uuid",
      "amount": 20,                          // MAJOR units (dollars), not cents
      "currency": "USD",                     // ISO 4217
      "displayName": "Ava",                  // optional handle
      "message": "Play One Dance! 🙏",       // optional
      "createdAt": "2026-07-13T02:13:15Z"    // ISO 8601
    }
  ],
  "tipTotals": { "total": 185, "count": 14, "currency": "USD" },
  "guestsOnline": 87,                        // optional aggregate count
  "eventStartedAt": "2026-07-13T00:00:00Z",  // optional ISO 8601 (drives duration timer)
  "updatedAt": "2026-07-13T02:14:23Z"        // ISO 8601 — when this snapshot was built
}
```

### Field notes
- All timestamps are **ISO 8601 UTC strings**.
- `tips[].amount` and `tipTotals.total` are in **major currency units** (e.g.
  `20` = $20.00). If the DB stores cents, divide by 100 server-side.
- `trending` should be pre-sorted by `votes` descending; `rank` is optional
  (the UI can fall back to array order).
- Arrays may be empty; `nowPlaying`, `guestsOnline`, `eventStartedAt` may be
  omitted/null. The UI degrades gracefully.
- Recommended caps to keep payloads small: `queue` ≤ 50, `trending` ≤ 10,
  `tips` ≤ 20 (most recent first).

## 4. Server responsibilities

1. **Validate the token.** Look it up the same way `now-playing-ingest` does
   (the chat notes describe `event_integrations.ingest_token`). Reject if
   missing/invalid/expired/unclaimed.
2. **Resolve the event server-side** from the token → the paired DJ + event.
3. **Query read-only, event-scoped data** for exactly that event.
4. **Return only the fields above.** Whitelist columns explicitly; never
   `select *` into the response.
5. **Never expose service-role or Stripe secrets.** Use the service-role key
   only inside the function to run the queries; it must never appear in the
   response or reach the client.

## 5. Required tables / fields — **to be filled in against the real schema**

Bridge does not know the real table names. Map each response field to its source
here before implementing (placeholders in ⟨angle brackets⟩):

| Response field | Source (fill in) |
|---|---|
| `eventName` | ⟨events.name⟩ for the resolved event |
| `connectionStatus` | derive from ⟨event_integrations.last_seen_at⟩ freshness (per chat notes) |
| `nowPlaying.*` | ⟨current now-playing row for the event⟩ (title/artist/art/source/started_at) |
| `queue[]` | ⟨song requests table⟩ scoped to event (id/title/artist/status/requested_at/requester handle) |
| `queue[].votes` / `trending[].votes` | ⟨votes table aggregated per request/song⟩ |
| `trending[]` | ⟨top songs by vote count for the event⟩ |
| `tips[]` + `tipTotals` | ⟨tips/payments table⟩ — **only** amount, currency, handle, message, created_at |
| `guestsOnline` | ⟨aggregate count of active guest sessions⟩ (optional) |
| `eventStartedAt` | ⟨events.started_at / created_at⟩ (optional) |
| `updatedAt` | server clock at response time |

## 6. Authorization & error responses

| Case | Status | Body |
|---|---|---|
| Valid token | `200` | snapshot above |
| Missing/invalid token | `401` | `{ "error": "unauthorized" }` |
| Expired/unclaimed/revoked token | `403` | `{ "error": "forbidden" }` |
| Token/`event_id` mismatch | `403` | `{ "error": "forbidden" }` |
| Method not `POST` | `405` | `{ "error": "method_not_allowed" }` |
| Server error | `500` | `{ "error": "server_error" }` |

`LiveBridgeProvider` maps `401/403` → `unauthorized` (prompts re-pair) and other
failures → `stale`/`error` (keeps last snapshot, retries on the poll interval).

## 7. Security — MUST NOT be returned

Never include, in any field:
- Stripe secret **or** publishable keys
- Webhook signing secrets
- Supabase service-role credentials / JWTs
- Full payment intent / charge / customer IDs (send none — the UI needs none)
- Guest PII beyond an optional chosen display handle (no emails, phone numbers,
  IPs, raw device IDs)

## 8. Realtime

Bridge uses **polling** (`LiveBridgeProvider` re-`POST`s every 3–5 s). No
realtime channel, no websocket, no service-role exposure to the client. If a
scoped realtime channel is added later it is an additive optimization; this
polling contract remains the baseline.
