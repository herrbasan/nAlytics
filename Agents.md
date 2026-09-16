---
description: "nAlytics agent briefing — standalone multi-site beacon analytics behind nPort. Use when: touching ingest, aggregation schema, dashboard, SSE feed, GeoIP, or nPort route wiring."
applyTo: "**"
---

# nAlytics — Agent Briefing

## Purpose

Standalone, multi-site, banner-free pageview analytics service. Accepts an open
beacon (`POST /analytics/ping`) from arbitrary websites via nPort, aggregates
into nDB counters, and serves an admin dashboard with realtime feed and graphs.
Extracted from nPort on 2026-09-16 (originally built 2026-09-13 inside nPort's
auth subsystem for raum.com).

**Read `docs/nAlytics_dev_plan.md` first.** It is the complete record of every
design decision — data model, routes, privacy red lines, extraction steps, open
decisions. This file is the summary; the plan is the source.

## Core facts

- nPort is the only public surface. nAlytics binds localhost and is reachable
  only through nPort routes: open `/analytics/ping` (CORS allowlist, always
  204), gated `/analytics/*` (coarse gate, admin role → dashboard + summary +
  SSE). The open handle sits AHEAD of the gated handle in Caddy, like nPort's
  localweb pattern.
- Dashboard served at `GET /analytics`. NUI app (nui_wc2 submodule) — read
  `modules/nui_wc2/LLM-CHEATSHEET.md` before writing UI code.
- Data: pre-aggregated nDB counter docs, no raw event log. Key:
  `site|date|hh:mm|path|refd|cc|device|browser` + `visit`/`salt`/`anmeta` docs
  + `dim` histogram docs (lang/size/dpr/conn — coarse buckets only, never in
  the pv key). Site comes from the Origin header (never the payload). Time
  bucket is minute. Dimensions not in the key cannot be sliced later — change
  keys consciously.
- GeoIP: `data/geoip-country-ipv4.csv`, CC0 (sapics/ip-location-db), binary
  search; missing file → country `??`. Refresh script in `scripts/`.
- Zero dependencies beyond Node + nDB + nLogger (+ nui_wc2 for UI).

## Red lines (GDPR/TDDDG) — never cross

- IP: in-memory only (country + visit hash), never stored, never logged.
- No cookies, no client storage, no third parties, no consent banner.
- DNT/GPC → not measured at all. Raw UA never stored (coarse class only).
- Referrer reduced to registrable domain; query strings stripped.
- Daily-salted visit hash: dedupe within a day, non-linkable across days.
- Beacon always answers 204; rejects counted, never logged, client never told.

## Security

- `data/` (nDB store, GeoIP CSV) and `.env` are gitignored — never commit.
- Summary/raw/SSE endpoints are reached only through nPort's coarse gate;
  nAlytics itself must never bind a public interface.

## Modules

`modules/nDB`, `modules/nLogger`, `modules/nui_wc2` are git submodules
(herrbasan repos). After clone: `git submodule update --init`. Check
`git submodule status` at session start; surface upstream drift, never
auto-update. Bug fixes belong upstream in the owning repo.

### nui_wc2 — always on latest main

The UI is based on our nui_wc2 library. The submodule is registered with
`-b main` and must always point at the latest upstream `main` — nAlytics never
carries local commits or pins old revisions of it.

Update check at session start (and before any UI work):

```
git -C modules/nui_wc2 fetch origin
git -C modules/nui_wc2 status -sb        # behind origin/main → update
git -C modules/nui_wc2 merge --ff-only origin/main
git add modules/nui_wc2 && git commit -m "Update nui_wc2 submodule to latest main"
```

Never edit files inside `modules/nui_wc2` — changes go upstream to
herrbasan/nui_wc2 first, then the submodule pointer is bumped here.

### nui_wc2 — how to work with it (mandatory reading)

nui_wc2 is a **high-performance library, not a framework**, and it is
**opinionated** — its patterns deliberately go against what your training-data
bias suggests. Do NOT write UI code from instinct.

Before any UI work, ingest:

1. `modules/nui_wc2/LLM-CHEATSHEET.md` — overview
2. All guides in `modules/nui_wc2/documentation/guides/` — the philosophy

When building the admin UI: **always check nui_wc2 for a suitable component
first** before hand-rolling anything.

If a component misbehaves or the API creates friction: file a GitHub issue on
herrbasan/nui_wc2 — it's ours, friction gets fixed at the source. If a feature
is missing, we can add it upstream. But **always update the local submodule to
latest main before making changes** — never work against a stale copy.

## When updating this file

Keep in sync with `docs/nAlytics_dev_plan.md` and, for route/auth wiring, with
nPort's `Agents.md` and `docs/ROUTING.md`.
