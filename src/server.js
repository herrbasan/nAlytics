/**
 * nAlytics HTTP server — localhost bind ONLY. nPort is the public surface:
 *   POST /analytics/ping   open  (nPort: CORS allowlist, always 204)
 *   GET  /analytics/*      gated (nPort coarse gate, admin role) → proxied here
 *
 * The beacon always answers 204 — rejects are counted, never logged,
 * the client is never told. DNT/GPC → not measured at all.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../modules/nLogger/src/logger.js';
import ndb from '../modules/nDB/napi/index.js';
import { loadConfig, ROOT } from './config.js';
import { initAnalytics } from './store.js';

const { Database } = ndb;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- SSE broadcast (subscriber set; events are fire-and-forget) ----

const sseClients = new Set();

function sseBroadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) res.write(data);
}

function sseKeepalive() {
    for (const res of sseClients) res.write(': ka\n\n');
}
setInterval(sseKeepalive, 25000).unref();

// ---- helpers ----

function readBody(req, limit = 8192) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function referrerDomain(ref) {
    if (!ref) return '';
    try { return new URL(ref).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Client IP for GeoIP + visit-hash. Behind nPort (Caddy reverse proxy), the
 * socket address is always 127.0.0.1 — the real client is in X-Forwarded-For
 * (leftmost entry; browsers cannot forge the header, Caddy appends the real IP).
 * Safe to trust because nAlytics binds localhost-only: the only possible sender
 * is nPort on this machine (or local dev).
 */
function clientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(first)) return first;
    }
    return (req.socket.remoteAddress || '').replace('::ffff:', '') || '0.0.0.0';
}

// ---- routes ----

function handlePing(req, res, ctx) {
    // Site comes from the Origin header via the allowlist map — never the payload.
    const origin = req.headers.origin;
    const cors = origin && ctx.config.origins.has(origin)
        ? {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400',
            'Vary': 'Origin'
        }
        : null;

    if (req.method === 'OPTIONS') { // preflight
        res.writeHead(204, cors || { Vary: 'Origin' });
        res.end();
        return;
    }

    const done = () => { res.writeHead(204, { 'Cache-Control': 'no-store', ...(cors || {}) }); res.end(); };

    // Unknown/missing origin → reject (counted, never logged, client never told).
    if (!cors) { ctx.analytics.countReject(ctx.db); done(); return; }

    // Consent-signal: honoring means dropping entirely (not even a count).
    const dnt = req.headers.dnt === '1';
    const gpc = String(req.headers['sec-gpc'] || req.headers.gpc || '').toLowerCase() === '1';
    if (dnt || gpc) { done(); return; }

    readBody(req).then(body => {
        const payload = JSON.parse(body);
        // Validate + normalize client fields. Query strings/fragments never stored.
        const p = typeof payload.path === 'string' ? payload.path.split('?')[0].split('#')[0] : null;
        if (!p || !p.startsWith('/') || p.length > 512) { ctx.analytics.countReject(ctx.db); done(); return; }

        const event = ctx.analytics.recordPing(ctx.db, ctx.log, {
            site: ctx.config.origins.get(origin),
            ip: clientIp(req),
            ua: req.headers['user-agent'] || '',
            payload: {
                path: p, refd: referrerDomain(payload.referrer),
                // Coarse client capabilities — normalized to buckets in the store.
                dims: { lang: payload.lang, w: payload.w, h: payload.h, dpr: payload.dpr, conn: payload.conn }
            }
        });
        sseBroadcast(event);
        done();
    }).catch(() => {
        // Malformed payload: count the reject, never log contents.
        ctx.analytics.countReject(ctx.db);
        done();
    });
}

function handleSse(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
}

// ---- static UI serving ----

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.md': 'text/markdown; charset=utf-8'
};

/** Serve a file from `rootDir` at `subpath` — traversal-safe, 404 when missing. */
function serveStatic(res, rootDir, subpath) {
    const resolved = path.resolve(rootDir, '.' + path.sep + subpath.replace(/^\/+|\/+$/g, ''));
    const root = path.resolve(rootDir);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        sendJson(res, 404, { error: 'not found' });
        return;
    }
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
    });
    res.end(fs.readFileSync(resolved));
}

const UI_DIR = path.join(__dirname, 'ui');                       // src/ui
const NUI_DIR = path.join(__dirname, '..', 'modules', 'nui_wc2', 'NUI'); // submodule library

function handleDashboard(res) {
    serveStatic(res, UI_DIR, 'index.html');
}

// ---- server ----

function start() {
    const config = loadConfig();
    const log = createLogger({ logsDir: path.join(ROOT, 'logs'), sessionPrefix: 'nalytics' });

    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = Database.open(path.join(config.dataDir, 'nalytics.jsonl'), { persistence: 'immediate' });
    const analytics = initAnalytics(config.dataDir, db, log);

    const ctx = { config, db, log, analytics };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const route = url.pathname;

        if (route === '/health') { sendJson(res, 200, { ok: true }); return; }
        if (route === '/analytics/ping') { handlePing(req, res, ctx); return; }
        if (route === '/analytics/sse') { handleSse(req, res); return; }
        if (route === '/analytics' || route === '/analytics/') { handleDashboard(res); return; }
        if (route === '/analytics/summary') {
            sendJson(res, 200, analytics.summarize(db,
                url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('site')));
            return;
        }
        if (route === '/analytics/raw') {
            sendJson(res, 200, analytics.rawRows(db, url.searchParams.get('site')));
            return;
        }
        if (route === '/analytics/sites') {
            sendJson(res, 200, { configured: [...new Set(config.origins.values())], known: analytics.knownSites(db) });
            return;
        }
        if (route === '/analytics/dims') {
            const dim = url.searchParams.get('dim');
            if (!['lang', 'size', 'dpr', 'conn'].includes(dim)) {
                sendJson(res, 400, { error: 'dim must be one of lang|size|dpr|conn' });
                return;
            }
            sendJson(res, 200, analytics.dimHistogram(db,
                url.searchParams.get('from'), url.searchParams.get('to'),
                url.searchParams.get('site'), dim));
            return;
        }
        if (route.startsWith('/analytics/nui/')) { serveStatic(res, NUI_DIR, route.slice('/analytics/nui'.length)); return; }
        if (route.startsWith('/analytics/app/')) { serveStatic(res, UI_DIR, route.slice('/analytics/app'.length)); return; }
        sendJson(res, 404, { error: 'not found' });
    });

    server.listen(config.port, '127.0.0.1', () => {
        log.info(`nAlytics listening on localhost:${config.port}`, { sites: [...config.origins.values()] });
        console.log(`nAlytics listening on http://127.0.0.1:${config.port}`);
    });
}

start();
