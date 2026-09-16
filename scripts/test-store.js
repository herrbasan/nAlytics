// test-store.js — scratch-DB test of the nAlytics store (no live data touched).
// Adapted from nPort scripts/test-analytics.js; extended for site dimension + minute buckets.
'use strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ndb from '../modules/nDB/napi/index.js';
import { initAnalytics } from '../src/store.js';

const { Database } = ndb;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nalytics-'));
// Copy the geoip table so country lookup is exercised
fs.copyFileSync(path.join(__dirname, '..', 'data', 'geoip-country-ipv4.csv'), path.join(scratch, 'geoip-country-ipv4.csv'));

const log = { info: (...a) => console.log('[info]', ...a), error: (...a) => console.error('[err]', ...a) };
const db = Database.open(path.join(scratch, 'test.jsonl'), { persistence: 'immediate' });
const an = initAnalytics(scratch, db, log);

const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const mobileUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 1. raum: two pings, same visitor (same /24 + UA) → 2 pageviews, 1 visit
const ev1 = an.recordPing(db, log, { site: 'raum', ip: '79.245.134.10', ua, payload: { path: '/posts/telescope/', refd: 'news.ycombinator.com' } });
const ev2 = an.recordPing(db, log, { site: 'raum', ip: '79.245.134.99', ua, payload: { path: '/posts/telescope/', refd: 'news.ycombinator.com' } });
if (ev1.site !== 'raum' || ev1.cc !== 'DE' || ev1.device !== 'desktop') throw new Error('SSE event shape wrong: ' + JSON.stringify(ev1));
// 2. second site, different /24 → own visit, mobile device class
an.recordPing(db, log, { site: 'other', ip: '8.8.8.8', ua: mobileUa, payload: { path: '/', refd: '' } });
// 3. second view of same combo → count increments (not a new doc)
an.recordPing(db, log, { site: 'other', ip: '8.8.8.8', ua: mobileUa, payload: { path: '/', refd: '' } });

// 4. client dims: coarse buckets + rejects of garbage
an.recordPing(db, log, { site: 'raum', ip: '79.245.134.10', ua,
    payload: { path: '/dims/', refd: '', dims: { lang: 'de-AT', w: 1512, h: 982, dpr: 2, conn: '4g' } } });
an.recordPing(db, log, { site: 'raum', ip: '79.245.134.11', ua,
    payload: { path: '/dims/', refd: '', dims: { lang: 'de-DE', w: 9999, h: 50, dpr: 33, conn: 'wifi' } } });

// 5. IPv6 visitor: two pings from same /48 prefix -> 2 pageviews, 1 visit, country '??'
const evIpv6_1 = an.recordPing(db, log, { site: 'raum', ip: '2001:db8:abcd:0012::1', ua, payload: { path: '/ipv6/', refd: '' } });
const evIpv6_2 = an.recordPing(db, log, { site: 'raum', ip: '2001:db8:abcd:9999::2', ua, payload: { path: '/ipv6/', refd: '' } });
if (evIpv6_1.cc !== '??') throw new Error('IPv6 should yield ?? country, got ' + evIpv6_1.cc);

// per-site summaries
const sRaum = an.summarize(db, null, null, 'raum');
const sOther = an.summarize(db, null, null, 'other');
const sAll = an.summarize(db, null, null, null);
console.log('\n--- raum ---');
console.log('total:', sRaum.total, '(expect 6)');
console.log('visits today:', Object.values(sRaum.visitsByDay)[0], '(expect 2)');
console.log('--- other ---');
console.log('total:', sOther.total, '(expect 2)');
console.log('visits today:', Object.values(sOther.visitsByDay)[0], '(expect 1)');
console.log('--- all ---');
console.log('total:', sAll.total, '(expect 8)');

// reject counter
an.countReject(db);
an.countReject(db);
if (an.rejectCount(db) !== 2) throw new Error('reject count wrong: ' + an.rejectCount(db));

// sites list + raw rows + minute bucket shape
const sites = an.knownSites(db).join(',');
const rows = an.rawRows(db, null);
const keyOk = db.find('type', 'pv').every(d => d.key.split('|').length === 8 && /^\d{2}:\d{2}$/.test(d.key.split('|')[2]));

// dims: coarse buckets, garbage coerced to '??'
const langH = an.dimHistogram(db, null, null, 'raum', 'lang');
const sizeH = an.dimHistogram(db, null, null, 'raum', 'size');
const dprH = an.dimHistogram(db, null, null, 'raum', 'dpr');
const connH = an.dimHistogram(db, null, null, 'raum', 'conn');
console.log('dims lang:', JSON.stringify(langH), '(expect de:2)');
console.log('dims size:', JSON.stringify(sizeH), '(expect 1500x1000:1, ??:1)');
console.log('dims dpr:', JSON.stringify(dprH), '(expect 2:1, ??:1)');
console.log('dims conn:', JSON.stringify(connH), '(expect 4g:1, ??:1)');
const dimsOk = langH.length === 1 && langH[0].k === 'de' && langH[0].v === 2
    && sizeH.some(x => x.k === '1500x1000' && x.v === 1) && sizeH.some(x => x.k === '??' && x.v === 1)
    && dprH.some(x => x.k === '2' && x.v === 1) && connH.some(x => x.k === '4g' && x.v === 1);

const ok = sRaum.total === 6 && Object.values(sRaum.visitsByDay)[0] === 2
  && sOther.total === 2 && Object.values(sOther.visitsByDay)[0] === 1
  && sAll.total === 8 && sites === 'other,raum' && rows.length === 4 && keyOk && dimsOk
  && sAll.devices.desktop === 6 && sAll.devices.mobile === 2
  && sAll.countries.some(c => c.k === 'DE') && sAll.countries.some(c => c.k === 'US')
  && sAll.countries.some(c => c.k === '??');

const salts = db.find('type', 'salt');
console.log('salt docs:', salts.length, '(expect 1 for today)');
console.log('sites:', sites, '| raw rows:', rows.length, '(expect 4 distinct combos) | key shape ok:', keyOk);

console.log(ok && salts.length === 1 ? '\nPASS' : '\nFAIL');
process.exit(ok && salts.length === 1 ? 0 : 1);
