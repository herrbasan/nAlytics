/**
 * Config — parsed once at startup, fail-fast.
 *
 * PORT    — localhost port nAlytics binds (nPort proxies to it)
 * ORIGINS — beacon CORS allowlist + origin→site map:
 *           "https://raum.com=raum,https://www.raum.com=raum"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
}

export function loadConfig() {
    loadEnvFile();

    const port = Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`config: PORT missing or invalid (got "${process.env.PORT}")`);
    }

    const raw = process.env.ORIGINS;
    if (!raw || !raw.trim()) throw new Error('config: ORIGINS missing — beacon allowlist is required');

    const origins = new Map(); // origin → site label
    for (const part of raw.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const eq = entry.indexOf('=');
        if (eq < 1) throw new Error(`config: ORIGINS entry "${entry}" must be <origin>=<site>`);
        const origin = entry.slice(0, eq).trim();
        const site = entry.slice(eq + 1).trim();
        if (!/^https?:\/\//.test(origin)) throw new Error(`config: origin "${origin}" must be an absolute http(s) URL`);
        if (!site || /[|,]/.test(site)) throw new Error(`config: site label "${site}" invalid (empty, "|" or ",")`);
        origins.set(origin, site);
    }
    if (origins.size === 0) throw new Error('config: ORIGINS parsed to zero entries');

    return { port, origins, dataDir: path.join(ROOT, 'data') };
}
