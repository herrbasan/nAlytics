/**
 * Analytics store — banner-free, multi-site Reichweitenmessung.
 * Extracted from nPort src/auth/server/analytics-store.js (2026-09-16).
 * See docs/nAlytics_dev_plan.md — this file implements that schema.
 *
 * Data model (nDB docs, pre-aggregated counters — NOT raw events):
 *   { type:'pv', key:'<site>|<date>|<hh:mm UTC>|<path>|<refd>|<cc>|<device>|<browser>', count }
 *     One doc per distinct combination. count incremented on repeat.
 *   { type:'visit', site, date:'<date>', vh:'<hash>' }
 *     One doc per distinct visit_hash per site per day → visits = count of docs.
 *   { type:'salt', date:'<date>', value:'<random hex>' }
 *     Daily salt for visit_hash; non-linkable across days by design.
 *   { type:'anmeta', name:'rejects', count }
 *     Malformed/disallowed-payload counter (contents never logged).
 *   { type:'dim', site, date:'<date>', dim:'lang'|'size'|'dpr'|'conn', value, count }
 *     Coarse client-capability histograms: browser language (primary subtag),
 *     viewport size (rounded to 100px), device pixel ratio (rounded to 0.5),
 *     connection type (effectiveType). Separate docs — never in the pv key —
 *     so they stay independently sliceable and coarse by design.
 *
 * You can only slice by dimensions baked into the key — change keys consciously.
 *
 * Red lines (GDPR/TDDDG): IP is used in-memory for country + visit-hash
 * derivation and then discarded — never stored, never logged. No cookies,
 * no storage on the client, no third parties. Raw UA never stored (coarse
 * class only). Referrer reduced to registrable domain.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---- GeoIP (optional) ----
// Expects data/geoip-country-ipv4.csv ("start","end","CC") — CC0 from
// github.com/sapics/ip-location-db. Missing file → country '??'.
let geoRanges = null; // sorted [startInt, endInt, cc]

function loadGeoIp(dataDir, log) {
    const csv = path.join(dataDir, 'geoip-country-ipv4.csv');
    if (!fs.existsSync(csv)) {
        log.info('GeoIP table absent — country will be ??', { expected: csv });
        return;
    }
    const ranges = [];
    for (const line of fs.readFileSync(csv, 'utf8').split('\n')) {
        const m = line.match(/^"?(\d+\.\d+\.\d+\.\d+)"?,(?:"?(\d+\.\d+\.\d+\.\d+)"?),"?([A-Z]{2}|..)"?/);
        if (!m) continue;
        ranges.push([ipToInt(m[1]), ipToInt(m[2]), m[3]]);
    }
    if (ranges.length === 0) throw new Error(`GeoIP file present but unparsable: ${csv}`);
    geoRanges = ranges;
    log.info('GeoIP table loaded', { ranges: ranges.length });
}

function ipToInt(ip) {
    const parts = ip.split('.');
    return ((+parts[0] << 24) | (+parts[1] << 16) | (+parts[2] << 8) | +parts[3]) >>> 0;
}

function lookupCountry(ip) {
    if (!geoRanges) return '??';
    const n = ipToInt(ip);
    let lo = 0, hi = geoRanges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = geoRanges[mid];
        if (n < r[0]) hi = mid - 1;
        else if (n > r[1]) lo = mid + 1;
        else return r[2];
    }
    return '??';
}

// ---- UA classification (coarse by design — family + major, never raw UA) ----

function classifyUa(ua) {
    ua = String(ua || '');
    // Device class
    const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua));
    const isMobile = !isTablet && /Mobi|iPhone|Android.*Mobile|Windows Phone/i.test(ua);
    const device = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';
    // Browser family + major version
    let browser = 'other';
    const m = ua.match(/(?:Firefox)\/(\d+)|(?:Edg)\/(\d+)|(?:OPR)\/(\d+)|(?:Chrome)\/(\d+)|(?:Version\/(\d+)).*Safari/);
    if (m) {
        if (m[1]) browser = 'firefox-' + m[1];
        else if (m[2]) browser = 'edge-' + m[2];
        else if (m[3]) browser = 'opera-' + m[3];
        else if (m[4]) browser = 'chrome-' + m[4];
        else if (m[5]) browser = 'safari-' + m[5];
    }
    return { device, browser };
}

// ---- Coarse client dimensions (anonymous by construction: coarse, high-population buckets) ----

/** Browser language — primary subtag only ('de-AT' → 'de'). Never the full list. */
function normLang(l) {
    const m = /^[\s"']*([a-zA-Z]{2,3})\b/.exec(String(l || ''));
    return m ? m[1].toLowerCase() : '??';
}

/** Viewport size — rounded to 100px steps so buckets stay population-large. */
function normSize(w, h) {
    const W = Math.round(Number(w) / 100) * 100;
    const H = Math.round(Number(h) / 100) * 100;
    if (!Number.isFinite(W) || !Number.isFinite(H) || W < 100 || W > 8000 || H < 100 || H > 8000) return '??';
    return `${W}x${H}`;
}

/** Device pixel ratio — rounded to 0.5 steps. */
function normDpr(d) {
    const v = Math.round(Number(d) * 2) / 2;
    if (!Number.isFinite(v) || v <= 0 || v > 10) return '??';
    return String(v);
}

/** Connection type — Network Information API effectiveType, allowlist-enummed. */
function normConn(c) {
    const v = String(c || '').toLowerCase();
    return ['slow-2g', '2g', '3g', '4g'].includes(v) ? v : '??';
}

/** Record the per-ping dimension histograms (best effort — every value coerces or '??'). */
function recordDims(db, site, date, dims) {
    const values = {
        lang: normLang(dims.lang),
        size: normSize(dims.w, dims.h),
        dpr: normDpr(dims.dpr),
        conn: normConn(dims.conn)
    };
    for (const [dim, value] of Object.entries(values)) {
        const existing = db.find('type', 'dim').filter(d => d.site === site && d.date === date && d.dim === dim && d.value === value);
        if (existing.length > 0) db.set(existing[0]._id, 'count', existing[0].count + 1);
        else db.insert({ type: 'dim', site, date, dim, value, count: 1 });
    }
}

// ---- Daily salt ----

function getDailySalt(db, dateStr) {
    const found = db.find('type', 'salt').filter(s => s.date === dateStr);
    if (found.length > 0) return found[0].value;
    const value = crypto.randomBytes(16).toString('hex');
    db.insert({ type: 'salt', date: dateStr, value });
    return value;
}

// ---- Recording ----

/**
 * Record one accepted beacon ping.
 * `site` comes from the origin→site map (Origin header), never the payload.
 * Returns the SSE broadcast event — identifying fields (IP, hash, UA) never included.
 */
function recordPing(db, log, { site, ip, ua, payload }) {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const minute = now.toISOString().slice(11, 16); // hh:mm UTC

    const { device, browser } = classifyUa(ua);
    const country = lookupCountry(ip);

    // visit_hash: /24 prefix + UA-class + day + daily salt. Same visitor
    // within one day dedupes; across days the salt changes → non-linkable.
    const salt = getDailySalt(db, date);
    const prefix = ip.split('.').slice(0, 3).join('.');
    const vh = crypto.createHash('sha256').update(`${prefix}|${device}|${browser}|${date}|${salt}`).digest('hex').slice(0, 16);

    const key = [site, date, minute, payload.path, payload.refd, country, device, browser].join('|');
    const existing = db.find('type', 'pv').filter(d => d.key === key);
    if (existing.length > 0) db.set(existing[0]._id, 'count', existing[0].count + 1);
    else db.insert({ type: 'pv', key, count: 1 });

    if (db.find('type', 'visit').filter(v => v.site === site && v.date === date && v.vh === vh).length === 0) {
        db.insert({ type: 'visit', site, date, vh });
    }

    if (payload.dims) recordDims(db, site, date, payload.dims);

    return { site, path: payload.path, refd: payload.refd, cc: country, device, browser };
}

function countReject(db) {
    const m = db.find('type', 'anmeta').filter(d => d.name === 'rejects');
    if (m.length > 0) db.set(m[0]._id, 'count', m[0].count + 1);
    else db.insert({ type: 'anmeta', name: 'rejects', count: 1 });
}

function rejectCount(db) {
    const m = db.find('type', 'anmeta').filter(d => d.name === 'rejects');
    return m.length > 0 ? m[0].count : 0;
}

// ---- Summary (dashboard feed) ----

/**
 * Aggregate pv docs into dashboard shape. `site` filters by the first key
 * dimension; omit it for all sites. `from`/`to` are inclusive UTC date strings.
 */
function summarize(db, from, to, site) {
    const pvs = db.find('type', 'pv').filter(d => {
        const parts = d.key.split('|');
        if (site && parts[0] !== site) return false;
        const date = parts[1];
        return (!from || date >= from) && (!to || date <= to);
    });
    const byPath = {}, byRef = {}, byCountry = {}, byDevice = {}, byDay = {};
    let total = 0;
    for (const d of pvs) {
        const [, date, , p, refd, cc, device] = d.key.split('|');
        total += d.count;
        byPath[p] = (byPath[p] || 0) + d.count;
        byRef[refd || '(direct)'] = (byRef[refd || '(direct)'] || 0) + d.count;
        byCountry[cc] = (byCountry[cc] || 0) + d.count;
        byDevice[device] = (byDevice[device] || 0) + d.count;
        byDay[date] = (byDay[date] || 0) + d.count;
    }
    const visitsByDay = {};
    for (const v of db.find('type', 'visit')) {
        if (site && v.site !== site) continue;
        if (from && v.date < from) continue;
        if (to && v.date > to) continue;
        visitsByDay[v.date] = (visitsByDay[v.date] || 0) + 1;
    }
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
        .map(([k, v]) => ({ k, v }));
    return {
        total, days: Object.keys(byDay).length,
        topPaths: top(byPath, 20), topReferrers: top(byRef, 15),
        countries: top(byCountry, 15), devices: byDevice,
        pageviewsByDay: Object.fromEntries(Object.entries(byDay).sort()),
        visitsByDay: Object.fromEntries(Object.entries(visitsByDay).sort()),
        rejects: rejectCount(db)
    };
}

/**
 * Raw counter rows — one per pv doc, key split into fields.
 * Used by the admin list; `site` filters by first key dimension.
 */
function rawRows(db, site) {
    return db.find('type', 'pv')
        .filter(d => !site || d.key.split('|')[0] === site)
        .map(d => {
            const [s, date, minute, p, refd, cc, device, browser] = d.key.split('|');
            return { site: s, date, minute, path: p, referrer: refd, country: cc, device, browser, count: d.count };
        })
        .sort((a, b) => (b.date + b.minute).localeCompare(a.date + a.minute));
}

/** Distinct site labels present in the data (for the dashboard site switcher). */
function knownSites(db) {
    const sites = new Set(db.find('type', 'visit').map(v => v.site));
    for (const d of db.find('type', 'pv')) sites.add(d.key.split('|')[0]);
    return [...sites].sort();
}

/** Histogram of one dimension, sorted by count desc. dim: 'lang'|'size'|'dpr'|'conn'. */
function dimHistogram(db, from, to, site, dim) {
    const acc = {};
    for (const d of db.find('type', 'dim')) {
        if (d.dim !== dim) continue;
        if (site && d.site !== site) continue;
        if (from && d.date < from) continue;
        if (to && d.date > to) continue;
        acc[d.value] = (acc[d.value] || 0) + d.count;
    }
    return Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ k, v }));
}

function initAnalytics(dataDir, db, log) {
    loadGeoIp(dataDir, log);
    return { recordPing, countReject, rejectCount, summarize, rawRows, knownSites, dimHistogram };
}

export { initAnalytics };
