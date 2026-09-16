# nAlytics — Service Specification

> What nAlytics is, what it measures, and the rules it never crosses.
> Architecture and decision record: `docs/nAlytics_dev_plan.md` (authoritative history).
> This file is the clean reference.

## Purpose

Standalone, multi-site, **banner-free pageview analytics** ("Reichweitenmessung").
Websites embed a tiny beacon snippet; nAlytics aggregates pageviews into coarse
counters and serves an admin dashboard with realtime feed and graphs. No cookies,
no consent banner, no third parties — measurement stays inside the strictly-necessary
envelope of GDPR/TDDDG.

Public surface is always **nPort** (edge, TLS). nAlytics binds `127.0.0.1` only
and is reachable exclusively through nPort routes:

- `POST /analytics/ping` — open (CORS allowlist), the beacon
- `GET /analytics/*` — gated (nPort coarse gate, admin role): dashboard + APIs + SSE

## What is collected

Per accepted beacon ping, nAlytics derives and counts:

| Dimension | Source | Granularity |
|---|---|---|
| Site | `Origin` header (allowlist-mapped label) — **never** the payload | configured label |
| Date + minute | server clock (UTC) | `YYYY-MM-DD`, `hh:mm` |
| Path | payload `path` | query strings/fragments stripped, ≤512 chars |
| Referrer | payload `referrer` | registrable domain only (`www.` stripped), empty = direct |
| Country | GeoIP lookup of client IP (CC0 table, IPv4) | ISO country code, `??` unknown |
| Device class | User-Agent classification | `desktop` / `mobile` / `tablet` |
| Browser | User-Agent classification | family + major (`chrome-141`), `other` |
| Visit | daily-salted hash | dedupe within a day, non-linkable across days |
| Language | payload `lang` | primary subtag only (`de-AT` → `de`) |
| Viewport | payload `w`, `h` | rounded to 100px steps |
| Pixel density | payload `dpr` | rounded to 0.5 steps |
| Connection | payload `conn` | enum `slow-2g|2g|3g|4g` |

The first eight dimensions form the pre-aggregated **pv counter key**:
`site|date|hh:mm|path|refd|cc|device|browser` — one doc per distinct
combination, count incremented on repeats. Language/viewport/dpr/connection are
kept in **separate histogram docs** (`dim`), never in the pv key.

**Dimensions not in the key cannot be sliced later** — key changes are
conscious, non-retrofittable decisions.

## What is deliberately NOT collected

- **IP addresses** — used in-memory for country lookup + visit-hash derivation,
  then discarded. Never stored, never logged.
- **Raw User-Agent** — only the coarse device class + browser family/major.
- **Cookies / client storage / fingerprints** — no canvas, font, or audio
  fingerprinting; nothing that re-identifies across days.
- **Full referrer URLs** — registrable domain only, query stripped.
- **Cross-day visitor identity** — the visit hash salt rotates daily by design.
- **Precise geolocation** — country level only.
- **DNT/GPC users** — not measured at all (request dropped entirely, not even counted).

## Data model (nDB docs, JSONL store)

```
{ type:'pv',    key:'<site>|<date>|<hh:mm>|<path>|<refd>|<cc>|<device>|<browser>', count }
{ type:'visit', site, date, vh:'<16-hex>' }        // one per distinct visit-hash/day/site
{ type:'salt',  date, value:'<32-hex>' }           // daily salt, rotates
{ type:'anmeta', name:'rejects', count }           // malformed/disallowed payload counter
{ type:'dim',   site, date, dim:'lang|size|dpr|conn', value, count }
```

No raw event log exists — only these pre-aggregated counters. Visits = count of
`visit` docs; pageviews = sum of pv counts.

## Behavior rules

- The beacon **always answers 204** — rejects are counted, never logged, the
  client is never told (no retry loops).
- Beacon POSTs with missing/disallowed `Origin` → counted as rejects.
- Invalid payloads (bad path, oversized, malformed JSON) → counted as rejects.
- Missing GeoIP table → country `??` (tolerated, logged once at startup).
- Missing/invalid dim values → `??` bucket, never a reject.
- SSE events contain nothing identifying: `{site, path, refd, cc, device, browser}`.

## Components

- `src/server.js` — zero-dependency Node HTTP server (localhost:3110)
- `src/store.js` — ingest, aggregation, summary, dims (nDB)
- `src/config.js` — `.env` parsing, fail-fast (PORT, ORIGINS)
- `src/ui/` — NUI dashboard (nui_wc2 submodule)
- `modules/nDB`, `modules/nLogger`, `modules/nui_wc2` — git submodules
- `data/` — nDB store + GeoIP CSV (gitignored)
- `scripts/` — `download-geoip.js`, `test-store.js`

## Configuration (`.env`)

```
PORT=3110
ORIGINS=https://raum.com=raum,https://www.raum.com=raum
```

Each origin maps to a site label; the label becomes the site dimension. Adding
a site = adding an origin mapping (plus shipping the snippet on that site).
