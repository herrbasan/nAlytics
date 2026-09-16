// download-geoip.js — fetch the CC0 country GeoIP table into data/ (one-time / manual refresh).
// Source: github.com/sapics/ip-location-db (GeoLite2-derived country table, most accurate
// free variant; refreshed twice weekly upstream). Static file — no runtime dependency.
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_SRC = 'https://github.com/sapics/ip-location-db/releases/download/latest/geolite2-country-ipv4.csv';
const OUT = path.join(__dirname, '..', 'data', 'geoip-country-ipv4.csv');

const res = await fetch(URL_SRC, { signal: AbortSignal.timeout(120000) });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const text = await res.text();
const lines = text.split('\n').filter(l => l.trim());
// sanity: expected shape "start","end","CC"
if (lines.length < 50000 || !lines[0].match(/\d+\.\d+\.\d+\.\d+/)) {
    throw new Error(`unexpected file shape (${lines.length} lines, first: ${lines[0].slice(0, 60)})`);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`saved ${OUT} — ${lines.length} ranges`);
