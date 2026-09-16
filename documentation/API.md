# nAlytics — HTTP API

Base URL (public, via nPort): `https://<edge-host>/analytics`
Direct (local): `http://127.0.0.1:3110`

All responses are JSON (`application/json; charset=utf-8`) unless noted.
All dashboard-facing routes sit behind nPort's coarse gate (admin role); the
beacon is open. There is no nAlytics-level auth — the localhost bind + nPort
gate are the security boundary.

---

## POST /analytics/ping — the beacon

Open route (no token). CORS-restricted to the configured origin allowlist.

- **Request**: JSON body, ≤8192 bytes.
  `{ path, referrer?, lang?, w?, h?, dpr?, conn? }` — see the snippet doc for field meanings.
- **Response**: **always `204 No Content`** — valid, rejected, or
  DNT/GPC-dropped alike. The client never learns anything.
- **Precondition**: `Origin` header must exactly match a configured allowed
  origin; otherwise the ping counts as a reject.
- `DNT: 1` or `Sec-GPC: 1` → request dropped entirely, not even counted.
- Client IP is taken from `X-Forwarded-For` (leftmost entry, set by Caddy);
  used in-memory for country + visit hash only.

## GET /health

Local liveness probe. → `{ "ok": true }`

## GET /analytics — dashboard

Serves the NUI app (`text/html`). Requires admin gate via nPort.

## GET /analytics/summary?from&to&site

Aggregated dashboard feed.

| Param | Format | Default |
|---|---|---|
| `from` | `YYYY-MM-DD` (inclusive) | no bound |
| `to` | `YYYY-MM-DD` (inclusive) | no bound |
| `site` | site label | all sites |

→

```json
{
  "total": 128,                       // pageviews in range
  "days": 3,                          // distinct days with data
  "rejects": 4,                       // total reject counter (not range-bound)
  "topPaths":     [{ "k": "/", "v": 42 }, ...],   // top 20
  "topReferrers": [{ "k": "(direct)", "v": 30 }, ...], // top 15
  "countries":    [{ "k": "DE", "v": 100 }, ...], // top 15
  "devices":      { "desktop": 90, "mobile": 38 },
  "pageviewsByDay": { "2026-09-16": 50, ... },
  "pageviewsByHour": { "00": 1, ..., "23": 4 },  // UTC hours; ⚠️ key order is NOT chronological (JS integer-key ordering) — index by hour key
  "visitsByDay":    { "2026-09-16": 12, ... }
}
```

## GET /analytics/raw?site

Raw counter rows — one per distinct pv combination, newest first.

→ `[{ site, date, minute, path, referrer, country, device, browser, count }, ...]`

## GET /analytics/sites

→ `{ "configured": ["raum"], "known": ["raum"] }` — `configured` from the
ORIGINS map, `known` from stored data. For the dashboard site switcher.

## GET /analytics/dims?dim&site&from&to

Histogram of one client-capability dimension.

| Param | Values | Required |
|---|---|---|
| `dim` | `lang` \| `size` \| `dpr` \| `conn` | yes (400 otherwise) |
| `site`, `from`, `to` | as summary | no |

→ `[{ "k": "de", "v": 87 }, { "k": "en", "v": 12 }, ...]` sorted by count desc.
Unknown/missing values aggregate in the `??` bucket.

## GET /analytics/sse — realtime feed

`text/event-stream`. One `data:` event per accepted ping:

```json
{ "site": "raum", "path": "/posts/x/", "refd": "news.ycombinator.com", "cc": "DE", "device": "desktop", "browser": "chrome-141" }
```

Nothing identifying (no IP, no hash, no UA). Keepalive comment every 25s.
**Never probe with a non-streaming client** (`Invoke-WebRequest`, `fetch().text()`) —
the stream never ends.

## Static assets

- `GET /analytics/nui/*` — the nui_wc2 library (from the submodule)
- `GET /analytics/app/*` — dashboard app files (`src/ui/`)

Both are path-traversal-safe and served with `Cache-Control: no-store`.
