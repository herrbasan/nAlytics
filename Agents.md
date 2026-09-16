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
  `site|date|hh:mm|path|refd|cc|device|browser` + `visit`/`salt`/`anmeta` docs.
  Site comes from the Origin header (never the payload). Time bucket is minute.
  Dimensions not in the key cannot be sliced later — change keys consciously.
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

## When updating this file

Keep in sync with `docs/nAlytics_dev_plan.md` and, for route/auth wiring, with
nPort's `Agents.md` and `docs/ROUTING.md`.
