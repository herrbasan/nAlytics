# nAlytics — Beacon Snippet

The snippet to embed on measured websites. It is a single `fetch`, ~10 lines,
loads nothing, sets nothing, blocks nothing.

## The snippet

```html
<script>
(function () {
    fetch('https://<edge-host>/analytics/ping', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            path: location.pathname,
            referrer: document.referrer || '',
            lang: navigator.language,
            w: innerWidth,
            h: innerHeight,
            dpr: devicePixelRatio,
            conn: navigator.connection ? navigator.connection.effectiveType : ''
        })
    }).catch(function () {});
})();
</script>
```

Replace `<edge-host>` with the nPort edge host serving the site's analytics.

## Placement

- As high in `<head>` as possible (measures even short visits) — or at the end
  of `<body>` if first-paint matters more; both work, the beacon is async.
- Once per page. On SPA sites, also call it on route changes (re-invoke with
  the new `location.pathname`).

## What each field becomes

| Field | Sent value | Stored as |
|---|---|---|
| `path` | `location.pathname` | path with query/fragment stripped (required, ≤512 chars) |
| `referrer` | `document.referrer` | registrable domain only (`news.ycombinator.com`), empty = direct |
| `lang` | `navigator.language` | primary subtag (`de-AT` → `de`) |
| `w`, `h` | `innerWidth`/`innerHeight` | viewport rounded to 100px steps |
| `dpr` | `devicePixelRatio` | rounded to 0.5 steps |
| `conn` | `navigator.connection.effectiveType` | `slow-2g`/`2g`/`3g`/`4g` (Firefox/Safari: absent → `??`) |

Country, device class, and browser family are derived server-side from the
request (GeoIP + User-Agent classification) — the snippet sends nothing for them.

## Privacy properties (why no consent banner is needed)

- **No cookies, no localStorage, no fingerprinting** — nothing is written or read on the device.
- The server cannot link visits across days: the daily visit hash is salted
  with a rotating daily salt.
- Users with DNT (`DNT: 1`) or GPC (`Sec-GPC: 1`) are **not measured at all**.
- The beacon answers `204 No Content` always — success, rejection, and
  do-not-track alike; the page never reacts, never retries.

## Before it works

The site's origin must be in nAlytics' allowlist (`ORIGINS` in `.env`):

```
ORIGINS=https://example.com=example,https://www.example.com=example
```

Pings from origins not on the list are silently rejected (counted as rejects,
never logged). After changing `.env`, restart nAlytics.

## Minimal version

If only basic pageview counting is wanted, this reduced snippet is fully
compatible — the extra fields are all optional:

```html
<script>fetch('https://<edge-host>/analytics/ping',{method:'POST',keepalive:true,
headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,
referrer:document.referrer||''})}).catch(function(){})</script>
```
