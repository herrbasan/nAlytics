// Page registrations — nui.registerPage() pattern (standard JS modules, no CSP issues).
import { nui } from '/analytics/nui/nui.js';
import { lineChart, hourBars, donut, barRows, flag } from '/analytics/app/js/charts.js';

const nf = new Intl.NumberFormat();

nui.registerPage('overview', {
    html: 'overview.html',
    init(element, params, nui) {
        const $ = (sel) => element.querySelector(sel);
        const siteSelect = $('#site-select');
        const rangePicker = $('#range-picker');
        const rangeNote = $('#range-note');
        const refreshBtn = $('#refresh-btn button');
        let sse = null;
        let refreshTimer = null;
        let extent = { first: '', last: '' };

        // The range is mirrored in the hash so a view survives a reload or a shared
        // link: `#page=overview&from=…&to=…&site=…`. The router owns `page`; we own the
        // rest, and every writer goes through syncHash() so they cannot disagree.
        //
        // The hash IS the query string once the leading `#` is dropped — there is no `?`
        // in it, so splitting on '?' silently yields empty params and every deep link
        // restores "all time".
        function readHash() {
            const p = new URLSearchParams(location.hash.replace(/^#/, ''));
            return { from: p.get('from') || '', to: p.get('to') || '', site: p.get('site') || '' };
        }

        function syncHash() {
            const { from, to } = rangePicker.getValue();
            const site = siteSelect.getValue();
            const p = new URLSearchParams();
            p.set('page', 'overview');
            if (from) p.set('from', from);
            if (to) p.set('to', to);
            if (site) p.set('site', site);
            history.replaceState(null, '', '#' + p.toString());
        }

        // ---- data loading ----

        async function loadSites() {
            const site = siteSelect.getValue();
            const qs = site ? `?site=${encodeURIComponent(site)}` : '';
            const res = await fetch('/analytics/sites' + qs);
            if (!res.ok) throw new Error('sites fetch failed: ' + res.status);
            const { configured, known, first, last, daily } = await res.json();
            extent = { first: first || '', last: last || '' };
            for (const s of [...new Set([...configured, ...known])]) {
                if (!siteSelect.querySelector(`option[value="${s}"]`)) siteSelect.addItem(s, s);
            }
            // Never let the picker offer a window the data cannot answer for.
            rangePicker.setAttribute('min', extent.first);
            rangePicker.setAttribute('max', new Date().toISOString().slice(0, 10));
            if (rangePicker.setDensity && daily) {
                rangePicker.setDensity(daily);
            }
        }

        function currentRange() {
            const { from, to } = rangePicker.getValue();
            if (!from && !to) return { from: '', to: '' };
            // A range with only one end bound is a single day, not an open window —
            // otherwise "from 2026-10-01" would silently mean "from then until forever".
            return { from, to: to || from };
        }

        function describeRange() {
            const { from, to } = currentRange();
            if (!from && !to) {
                rangeNote.textContent = extent.last
                    ? `All time — ${extent.first} to ${extent.last} recorded.`
                    : 'No data recorded yet.';
                return;
            }
            rangeNote.textContent = from === to
                ? `Single day: ${from}`
                : `${from} to ${to} (UTC, inclusive)`;
        }

        async function loadSummary() {
            const site = siteSelect.getValue();
            const { from, to } = currentRange();
            const p = new URLSearchParams();
            if (site) p.set('site', site);
            if (from) p.set('from', from);
            if (to) p.set('to', to);
            const qs = p.toString() ? '?' + p.toString() : '';

            const dimQs = (dim) => {
                const dp = new URLSearchParams(p);
                dp.set('dim', dim);
                return '?' + dp.toString();
            };

            const [sumRes, langRes, connRes, sizeRes, dprRes] = await Promise.all([
                fetch('/analytics/summary' + qs),
                fetch('/analytics/dims' + dimQs('lang')),
                fetch('/analytics/dims' + dimQs('conn')),
                fetch('/analytics/dims' + dimQs('size')),
                fetch('/analytics/dims' + dimQs('dpr'))
            ]);
            if (!sumRes.ok) throw new Error('summary fetch failed: ' + sumRes.status);
            const s = await sumRes.json();
            const lang = await langRes.json();
            const conn = await connRes.json();
            const size = await sizeRes.json();
            const dpr = await dprRes.json();
            describeRange();
            render(s, lang, conn, size, dpr);
        }

        // ---- rendering ----

        const empty = (msg) => `<p class="lead">${msg}</p>`;

        function render(s, lang, conn, size, dpr) {
            const days = Object.keys(s.pageviewsByDay);
            const visits = s.visits ?? 0;

            $('#stat-total').textContent = nf.format(s.total);
            $('#stat-visits').textContent = nf.format(visits);
            $('#stat-rejects').textContent = nf.format(s.rejects);
            // A single recorded day has no daily rate to report, and dividing the whole
            // lifetime by one would read as a trend that never happened.
            $('#stat-avg').textContent = s.days > 1 ? nf.format(Math.round(s.total / s.days)) : '–';

            // By-day: dual line chart (pageviews filled area + visits line)
            $('#chart-days').innerHTML = days.length
                ? lineChart(
                    [
                        { name: 'Pageviews', color: 'var(--color-highlight)', fill: true, values: days.map(d => s.pageviewsByDay[d]) },
                        { name: 'Visits', color: 'var(--chart-alt)', values: days.map(d => s.visitsByDay[d] || 0) }
                    ],
                    days.map(d => d.slice(5)) // MM-DD labels
                )
                : empty('No pageviews in this range.');

            // Time of day — index explicitly by hour: object key order is NOT
            // chronological (JS hoists integer-like keys "10".."23" before "00".."09")
            const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
            $('#chart-hours').innerHTML = hourBars(hours.map(h => s.pageviewsByHour[h] || 0));

            // Devices donut + legend list
            const palette = ['var(--color-highlight)', 'var(--chart-alt)', '#3aa66a', '#c98a2d'];
            const devices = Object.entries(s.devices)
                .map(([label, value], i) => ({ label, value, color: palette[i % palette.length] }));
            $('#chart-devices').innerHTML = devices.length ? donut(devices) : '';
            $('#list-devices').innerHTML = devices.length
                ? barRows(devices.map(d => ({ label: d.label, value: d.value })))
                : empty('No pageviews in this range.');

            // Countries, content, technology
            $('#list-countries').innerHTML = s.countries.length
                ? barRows(s.countries.map(c => ({ label: `${flag(c.k)} ${c.k}`, value: c.v }))) : empty('No data in this range.');
            $('#list-paths').innerHTML = s.topPaths.length
                ? barRows(s.topPaths.map(p => ({ label: p.k, value: p.v }))) : empty('No data in this range.');
            $('#list-referrers').innerHTML = s.topReferrers.length
                ? barRows(s.topReferrers.map(r => ({ label: r.k, value: r.v }))) : empty('No data in this range.');
            $('#list-browsers').innerHTML = s.browsers?.length
                ? barRows(s.browsers.map(b => ({ label: b.k, value: b.v }))) : empty('No data in this range.');

            const dimRows = (rows, fmt) => rows.length
                ? barRows(rows.map(x => ({ label: fmt(x.k), value: x.v })))
                : empty('No dims recorded — needs a beacon sending them.');
            $('#list-lang').innerHTML = dimRows(lang, (k) => k);
            $('#list-conn').innerHTML = dimRows(conn, (k) => (k === '4g' ? '4G' : k.toUpperCase()));
            $('#list-size').innerHTML = dimRows(size, (k) => (k === '??' ? 'Unknown' : `${k} px`));
            $('#list-dpr').innerHTML = dimRows(dpr, (k) => {
                if (k === '??') return 'Unknown';
                if (k === '1') return '1x (standard)';
                if (k === '2') return '2x (retina)';
                return `${k}x`;
            });
        }

        // ---- SSE realtime ----

        function scheduleRefresh() {
            // Live pings refresh the aggregate views at most every 5s
            if (refreshTimer) return;
            refreshTimer = setTimeout(() => { refreshTimer = null; loadSummary().catch(console.error); }, 5000);
        }

        function startTicker() {
            $('#live-dot').classList.add('on');
            sse = new EventSource('/analytics/sse');
            const tbody = $('#ticker tbody');
            sse.onmessage = (e) => {
                $('#ticker-empty').hidden = true;
                $('#ticker').hidden = false;
                const ev = JSON.parse(e.data);
                const tr = document.createElement('tr');
                tr.className = 'ticker-new';
                const cells = [new Date().toLocaleTimeString(), ev.site, ev.path, `${flag(ev.cc)} ${ev.cc}`, ev.device, ev.refd || '(direct)'];
                for (const c of cells) {
                    const td = document.createElement('td'); td.textContent = c; tr.append(td);
                }
                tbody.prepend(tr);
                while (tbody.children.length > 50) tbody.lastChild.remove();
                scheduleRefresh();
            };
            sse.onerror = () => { $('#live-dot').classList.remove('on'); };
            sse.onopen = () => { $('#live-dot').classList.add('on'); };
        }

        // ---- wiring ----

        // One entry point for every change: persist the view, then reload it.
        function applyAndLoad() {
            syncHash();
            loadSites().catch(console.error);
            loadSummary().catch(console.error);
        }

        // Re-read the URL on every activation. The router only calls show() when the
        // ROUTE changes, so a hash edited in place — Back/Forward, a pasted link over
        // an open session — fires hashchange without ever reaching show(). Without this
        // the data reloads while the picker keeps the old range, and the label
        // describes a window the numbers are no longer for.
        // Only writes when the hash actually differs, so this cannot loop with
        // applyAndLoad() → syncHash() (which uses replaceState and fires nothing).
        function restoreFromHash() {
            const h = readHash();
            const cur = rangePicker.getValue();
            if (h.from === cur.from && h.to === cur.to) return false;
            rangePicker.setValue({ from: h.from, to: h.to });
            return true;
        }

        const onHashChange = () => { restoreFromHash(); loadSummary().catch(console.error); };
        window.addEventListener('hashchange', onHashChange);

        loadSites().then(() => {
            // Restore before the listeners below are attached — setValue() emits
            // nui-date-range-change, and loading twice on boot is visible.
            const h = readHash();
            if (h.site) siteSelect.setValue(h.site);
            rangePicker.setValue({ from: h.from, to: h.to });
            siteSelect.addEventListener('nui-change', applyAndLoad);
            rangePicker.addEventListener('nui-date-range-change', applyAndLoad);
            refreshBtn.addEventListener('click', applyAndLoad);
            syncHash();
            return loadSummary();
        }).catch(err => console.error('overview init failed:', err));
        startTicker();

        element.hide = () => { if (sse) { sse.close(); sse = null; } $('#live-dot').classList.remove('on'); };
        element.show = () => {
            if (!sse) startTicker();
            restoreFromHash();
            loadSummary().catch(console.error);
        };
    }
});

nui.registerPage('raw', {
    html: 'raw.html',
    init(element, params, nui) {
        const $ = (sel) => element.querySelector(sel);
        const siteSelect = $('#raw-site-select');
        const rangePicker = $('#raw-range-picker');
        const searchInput = $('#raw-search');
        const limitSelect = $('#raw-limit');
        const tbody = $('#raw-tbody');
        const statsEl = $('#raw-stats');
        const emptyEl = $('#raw-empty');
        let allRows = [];

        async function loadSites() {
            const site = siteSelect.getValue();
            const qs = site ? `?site=${encodeURIComponent(site)}` : '';
            const res = await fetch('/analytics/sites' + qs);
            if (!res.ok) return;
            const { configured, known, first, last, daily } = await res.json();
            for (const s of [...new Set([...configured, ...known])]) {
                if (!siteSelect.querySelector(`option[value="${s}"]`)) siteSelect.addItem(s, s);
            }
            rangePicker.setAttribute('min', first || '');
            rangePicker.setAttribute('max', new Date().toISOString().slice(0, 10));
            if (rangePicker.setDensity && daily) {
                rangePicker.setDensity(daily);
            }
            // An unbounded row limit over an unbounded date range is a full table
            // scan; default the window to the last 30 days so the first paint is bounded.
            if (!rangePicker.getValue().from && !rangePicker.getValue().to) rangePicker.setPreset('30d');
        }

        async function loadRows() {
            const site = siteSelect.getValue();
            const p = new URLSearchParams();
            if (site) p.set('site', site);
            const { from, to } = rangePicker.getValue();
            if (from) p.set('from', from);
            if (to) p.set('to', to);
            const qs = p.toString() ? '?' + p.toString() : '';
            statsEl.textContent = 'Loading rows…';
            const res = await fetch('/analytics/raw' + qs);
            if (!res.ok) {
                statsEl.textContent = 'Failed to load rows (' + res.status + ')';
                return;
            }
            allRows = await res.json();
            renderRows();
        }

        function renderRows() {
            const query = (searchInput.value || '').trim().toLowerCase();
            const limitVal = limitSelect.getValue();
            const maxRows = limitVal === 'all' ? Infinity : Number(limitVal) || 100;

            const filtered = query
                ? allRows.filter(r =>
                    r.path.toLowerCase().includes(query) ||
                    (r.referrer && r.referrer.toLowerCase().includes(query)) ||
                    (r.country && r.country.toLowerCase().includes(query)) ||
                    (r.browser && r.browser.toLowerCase().includes(query)) ||
                    (r.device && r.device.toLowerCase().includes(query)) ||
                    (r.site && r.site.toLowerCase().includes(query))
                  )
                : allRows;

            const totalHits = filtered.reduce((sum, r) => sum + r.count, 0);
            statsEl.textContent = `Showing ${Math.min(filtered.length, maxRows)} of ${filtered.length} rows (${totalHits} total pageviews)`;

            tbody.innerHTML = '';
            if (filtered.length === 0) {
                emptyEl.hidden = false;
                return;
            }
            emptyEl.hidden = true;

            const slice = filtered.slice(0, maxRows);
            const fragment = document.createDocumentFragment();
            for (const r of slice) {
                const tr = document.createElement('tr');
                const cells = [
                    `${r.date} ${r.minute}`,
                    r.site,
                    r.path,
                    r.referrer || '—',
                    `${flag(r.country)} ${r.country}`,
                    r.device,
                    r.browser,
                    String(r.count)
                ];
                for (let i = 0; i < cells.length; i++) {
                    const td = document.createElement('td');
                    td.textContent = cells[i];
                    if (i === cells.length - 1) td.className = 'num';
                    tr.appendChild(td);
                }
                fragment.appendChild(tr);
            }
            tbody.appendChild(fragment);
        }

        siteSelect.addEventListener('nui-change', () => loadRows().catch(console.error));
        rangePicker.addEventListener('nui-date-range-change', () => loadRows().catch(console.error));
        limitSelect.addEventListener('nui-change', () => renderRows());
        searchInput.addEventListener('input', () => renderRows());
        $('#raw-refresh-btn button').addEventListener('click', () => loadRows().catch(console.error));

        loadSites().then(loadRows).catch(console.error);
        element.show = () => loadRows().catch(console.error);
    }
});
