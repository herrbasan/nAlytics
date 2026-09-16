# nAlytics — Development Plan

> Created 2026-09-16, carried over from a design session in the nPort workspace.
> This file is the authoritative record of every decision made before the repo
> existed. Read it fully before changing anything it describes.

## What nAlytics is

Standalone, multi-site, banner-free pageview analytics ("Reichweitenmessung")
service. Ingests a beacon from arbitrary websites, aggregates with nDB, serves
an admin dashboard with realtime stats and graphs.

Born as an extraction from nPort (`src/auth/server/analytics-store.js` +
`src/auth/server/routes/analytics.js`, built 2026-09-13 for raum.com). The
extraction happened because:

1. nPort must stay thin — "no business logic, no service coupling". Analytics
   for arbitrary websites is business logic and it was sitting inside `src/auth/`,
   which has a hard inbound-dependency boundary.
2. We want to grow it: cool dashboard, realtime stats, fancy graphs. (Current
   traffic: ~2 accesses/day. Aspirations: one viral hit away from a stress test.)

The name: **nAlytics** — the n-family prefix (nPort, nDB, nLogger, nVoice...)
with a phonetic bonus the author finds perennially funny. It's pronounced
"ahn-a-lytics". The joke is left as an exercise for the reader.

## Architecture

```
visitor browser ──POST beacon──▶ nPort (edge, TLS)
                                  │  /analytics/ping   OPEN  (no token, CORS allowlist)
                                  │  /analytics/*      GATED (coarse gate, admin role)
                                  ▼
                             nAlytics (own Node process, localhost upstream)
                               ├── ingest: record ping → nDB counters + SSE broadcast
                               ├── summary/raw API (aggregations)
                               ├── SSE realtime feed (per-ping events)
                               └── NUI dashboard (nui_wc2)
```

- nPort stays thin: two routes, one open one gated, zero logic. Same pattern as
  the localweb route pair (open ingest path ahead of the gated wildcard).
- nAlytics owns ALL measurement logic, data, GeoIP, and the dashboard.
- Deployment target: Windows service on the usual machine, behind nPort.

## Routes (public surface, via nPort)

| Path | Auth | Purpose |
|------|------|---------|
| `POST /analytics/ping` | open, CORS allowlist | beacon ingest — always 204, never errors to client |
| `GET /analytics` | coarse gate (admin) | dashboard UI |
| `GET /analytics/*` (summary, raw, sse) | coarse gate (admin) | dashboard feeds |

Decision: gated **path** through nPort, NOT a subdomain (e.g. served under
`nport.raum.com/analytics/...`). Subdomains-vs-paths remains an open decision in
nPort generally; this does not force it. Reversible later.

Caddy ordering: the open `handle /analytics/ping` must sit AHEAD of the gated
`/analytics/*` handle in the generated Caddyfile (mirrors the
`/localweb/computer_stats` pattern in nPort).

Route name is **`/analytics`** (not `/nalytics`) for consistency with the
existing beacon snippet already shipped to raum.com.

## Multi-site support (the non-retrofittable change)

- **`site` is a first-class dimension in every counter key** from day one.
  Derived from the request `Origin` header (set by the browser on cross-origin
  POSTs — trustworthy, cannot be spoofed into polluting another site's stats),
  NOT from the payload.
- CORS allowlist becomes configuration: a list of allowed origins
  (e.g. `https://raum.com`, `https://www.raum.com`). Each origin maps to a site
  label. Beacon POSTs with disallowed/missing Origin: counted as rejects, never
  logged.
- Summary API takes `?site=` filter; dashboard has a site switcher.

This must be in the key BEFORE the second site onboards — existing aggregate
docs can't be re-sliced later. (Migration of the small existing raum.com data:
acceptable to either treat pre-migration docs as site `raum.com` via a one-off
backfill, or to start fresh. Decide at extraction time; data volume is tiny.)

## Data model (nDB docs, JSONL)

Pre-aggregated counters, NOT raw events. All docs in nAlytics' own store file
(no longer nPort's `nauth.jsonl`).

```
{ type:'pv', key:'<site>|<date>|<hh:mm UTC>|<path>|<refd>|<cc>|<device>|<browser>', count }
    One doc per distinct combination. count incremented on repeat.
{ type:'visit', site, date:'<date>', vh:'<hash>' }
    One doc per distinct visit_hash per site per day → visits = count of docs.
{ type:'salt', date:'<date>', value:'<random hex>' }
    Daily salt for visit_hash.
{ type:'anmeta', name:'rejects', count }
    Malformed/disallowed-payload counter.
```

Changes vs the nPort-era model:

1. `site` prepended to the `pv` key (see above).
2. key time bucket is **minute** (`hh:mm`), was hour — needed for "realtime"
   dashboard granularity. Still just a counter doc; no cost.

Consequence of pre-aggregation: you can only slice by dimensions baked into the
key. If a new dimension is ever needed, it needs a key change + fresh data.
Accept this consciously.

### Red lines (GDPR/TDDDG) — inherited, non-negotiable

- IP used in-memory only: country lookup + visit-hash derivation, then
  discarded. Never stored, never logged.
- No cookies, no client storage, no third parties, no consent banner needed.
- DNT/GPC requests: dropped entirely (not measured at all).
- Raw UA never stored — only coarse device class + browser family+major.
- Referrer reduced to registrable domain; query strings stripped.
- visit_hash = sha256(IP /24 | device | browser | date | daily-salt), truncated.
  Salt rotates daily → same visitor dedupes within a day, non-linkable across days.

## Realtime feed

- SSE endpoint (`GET /analytics/sse`) pushing each accepted ping as a small
  JSON event: `{site, path, country, device, browser, refd}` — nothing
  identifying (no IP, no hash, no UA).
- Implementation: the ingest path already sees every ping; broadcast is a
  simple subscriber set. ~10 lines. Events are fire-and-forget; SSE clients
  get a periodic keepalive comment.
- Note for HTTP clients: SSE never "completes" — don't probe it with
  Invoke-WebRequest or `fetch().text()`.

## Dashboard

- NUI app (nui_wc2 submodule, same as nPort's admin UI). **Read
  `modules/nui_wc2/LLM-CHEATSHEET.md` before writing any UI code** — nui_wc2
  is a library, not a framework; guessing produces broken code.
- Served by nAlytics at `GET /analytics` (gated upstream of nPort's coarse
  gate — nAlytics itself binds localhost only).
- Features: site switcher, realtime ping ticker (SSE), pageviews/visits by day
  graphs, top paths/referrers/countries/devices tables, reject counter.
- Graphs: client-side, no heavy chart framework unless justified — prefer
  lightweight (hand-rolled SVG or a tiny lib). Decide when building.

## Service skeleton

```
nAlytics/
├── Agents.md              ← briefing (exists; keep in sync)
├── docs/
│   └── nAlytics_dev_plan.md   ← this file
├── src/
│   ├── server.js          HTTP server (localhost bind), routes, SSE
│   ├── store.js           analytics store (moved from nPort + site/minute changes)
│   └── ui/                NUI dashboard
├── data/                  nDB store file + geoip-country-ipv4.csv  (gitignored)
├── modules/nui_wc2        submodule
├── scripts/
│   ├── download-geoip.js  (moved from nPort)
│   └── test-store.js      (adapted from nPort scripts/test-analytics.js)
└── .env                   PORT, allowed origins/sites map  (gitignored)
```

- Node + nDB (submodule `modules/nDB`) + nLogger. Zero other dependencies.
- Port: **3110** (confirmed free; nPort:3199, MCP:3100, Gateway:3400, nMedia:3500,
  nVoice:2244 taken).
- GeoIP: `data/geoip-country-ipv4.csv` (CC0, github.com/sapics/ip-location-db,
  geolite2-derived, 358k ranges, binary search). Refresh via script. Missing
  file → country `??` (tolerated, logged).

## Beacon client snippet (for target sites)

```js
fetch('https://<edge-host>/analytics/ping', {
  method: 'POST',
  keepalive: true,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: location.pathname, referrer: document.referrer || '', lang: navigator.language, w: innerWidth })
});
```
Payload validation (server): `path` required, starts with `/`, ≤512 chars;
referrer → registrable domain, query stripped; everything else optional/coerced.
Beacon ALWAYS answers 204, even on reject (client never learns, never retries).

## Extraction steps (from nPort)

Status 2026-09-16: steps 1–3 DONE (store extracted with site/minute/per-site-visit
schema + SSE events, server on 127.0.0.1:3110, test-store green). Migration
decision: **start fresh** — the few days of raum.com pre-extraction data are not
worth a backfill. Steps 4–5 (nPort rewiring, deploy) pending.

1. Create this repo; copy store/routes from nPort `src/auth/server/analytics-*`.
2. Apply schema changes: site dimension (Origin-derived), minute buckets,
   site-filtered summary, SSE broadcast.
3. Adapt `scripts/test-analytics.js` → scratch-DB test, run green.
4. nPort changes (separate session in the nPort workspace):
   - caddyfile-generator: gated `/analytics/*` upstream → nAlytics, open
     `handle /analytics/ping` ahead of it.
   - Remove `analytics-store.js`, `routes/analytics.js`, their wiring in
     `src/auth/standalone.js`, `scripts/test-analytics.js`.
   - Update nPort `Agents.md` route table + `docs/ROUTING.md`.
   - `scripts/download-geoip.js` moves to nAlytics (nPort no longer needs it).
5. Deploy: run nAlytics as service, restart nPort, verify beacon 204 from
   raum.com and gated dashboard behind auth.

## Open decisions

- Migrate existing raum.com aggregate docs or start fresh (trivial volume).
- Chart approach for the dashboard (SVG hand-roll vs tiny lib).
- Whether `GET /analytics/raw` (raw counter dump) survives into the new service
  or is superseded by a richer summary API.
- Retention: currently nothing is ever pruned. Fine for years at this volume;
  revisit if a viral hit happens.
