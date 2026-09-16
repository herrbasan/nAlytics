// Page registrations — nui.registerPage() pattern (standard JS modules, no CSP issues).
import { nui } from '/analytics/nui/nui.js';
import { lineChart, hourBars, donut, barRows, flag } from '/analytics/app/js/charts.js';

function getDateRange(rangeVal) {
    const now = new Date();
    const to = now.toISOString().slice(0, 10);
    if (rangeVal === 'today') return { from: to, to };
    if (rangeVal === '7d') {
        const d = new Date(Date.now() - 6 * 86400000);
        return { from: d.toISOString().slice(0, 10), to };
    }
    if (rangeVal === '30d') {
        const d = new Date(Date.now() - 29 * 86400000);
        return { from: d.toISOString().slice(0, 10), to };
    }
    return { from: '', to: '' };
}

nui.registerPage('overview', {
    html: 'overview.html',
    init(element, params, nui) {
        const $ = (sel) => element.querySelector(sel);
        const siteSelect = $('#site-select');
        const rangeSelect = $('#range-select');
        let sse = null;
        let refreshTimer = null;

        // ---- data loading ----

        async function loadSites() {
            const res = await fetch('/analytics/sites');
            if (!res.ok) throw new Error('sites fetch failed: ' + res.status);
            const { configured, known } = await res.json();
            for (const s of [...new Set([...configured, ...known])]) {
                if (!siteSelect.querySelector(`option[value="${s}"]`)) siteSelect.addItem(s, s);
            }
        }

        async function loadSummary() {
            const site = siteSelect.getValue();
            const rangeVal = rangeSelect?.getValue() || 'all';
            const { from, to } = getDateRange(rangeVal);
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
            render(s, lang, conn, size, dpr);
        }

        // ---- rendering ----

        function render(s, lang, conn, size, dpr) {
            const today = new Date().toISOString().slice(0, 10);
            const days = Object.keys(s.pageviewsByDay);
            const visitsSum = Object.values(s.visitsByDay).reduce((a, b) => a + b, 0);

            $('#stat-total').textContent = s.total;
            $('#stat-visits').textContent = visitsSum;
            $('#stat-rejects').textContent = s.rejects;
            $('#stat-today').textContent = s.pageviewsByDay[today] ?? 0;

            // By-day: dual line chart (pageviews filled area + visits line)
            $('#chart-days').innerHTML = days.length
                ? lineChart(
                    [
                        { name: 'Pageviews', color: 'var(--color-highlight)', fill: true, values: days.map(d => s.pageviewsByDay[d]) },
                        { name: 'Visits', color: '#e0556a', values: days.map(d => s.visitsByDay[d] || 0) }
                    ],
                    days.map(d => d.slice(5)) // MM-DD labels
                )
                : '<p class="lead">No data yet.</p>';

            // Time of day — index explicitly by hour: object key order is NOT
            // chronological (JS hoists integer-like keys "10".."23" before "00".."09")
            const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
            $('#chart-hours').innerHTML = hourBars(hours.map(h => s.pageviewsByHour[h] || 0));

            // Devices donut + legend
            const devices = Object.entries(s.devices)
                .map(([label, value], i) => ({ label, value, color: ['var(--color-highlight)', '#e0556a', '#3aa66a', '#c98a2d'][i % 4] }));
            $('#chart-devices').innerHTML = devices.length
                ? donut(devices) + '<div>' + barRows(devices.map(d => ({ label: d.label, value: d.value }))) + '</div>'
                : '<p class="lead">No data yet.</p>';

            // Countries with flags, top paths, referrers, dims
            $('#list-countries').innerHTML = s.countries.length
                ? barRows(s.countries.map(c => ({ label: `${flag(c.k)} ${c.k}`, value: c.v }))) : '<p class="lead">No data yet.</p>';
            $('#list-paths').innerHTML = s.topPaths.length
                ? barRows(s.topPaths.map(p => ({ label: p.k, value: p.v }))) : '<p class="lead">No data yet.</p>';
            $('#list-referrers').innerHTML = s.topReferrers.length
                ? barRows(s.topReferrers.map(r => ({ label: r.k, value: r.v }))) : '<p class="lead">No data yet.</p>';
            $('#list-lang').innerHTML = lang.length
                ? barRows(lang.map(l => ({ label: l.k, value: l.v }))) : '<p class="lead">No dims yet — needs the new beacon snippet.</p>';
            $('#list-conn').innerHTML = conn.length
                ? barRows(conn.map(c => ({ label: c.k, value: c.v }))) : '<p class="lead">No dims yet — needs the new beacon snippet.</p>';
            $('#list-size').innerHTML = size.length
                ? barRows(size.map(x => ({ label: x.k === '??' ? 'Unknown' : x.k + ' px', value: x.v }))) : '<p class="lead">No dims yet — needs the new beacon snippet.</p>';
            $('#list-dpr').innerHTML = dpr.length
                ? barRows(dpr.map(x => ({ label: x.k === '??' ? 'Unknown' : x.k + 'x' + (x.k === '2' ? ' (Retina)' : x.k === '1' ? ' (Standard)' : ''), value: x.v }))) : '<p class="lead">No dims yet — needs the new beacon snippet.</p>';
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

                // optimistic bump of the Today counter
                const todayEl = $('#stat-today');
                todayEl.textContent = (Number(todayEl.textContent) || 0) + 1;
                scheduleRefresh();
            };
            sse.onerror = () => { $('#live-dot').classList.remove('on'); };
            sse.onopen = () => { $('#live-dot').classList.add('on'); };
        }

        // ---- wiring ----

        siteSelect.addEventListener('nui-change', () => loadSummary().catch(console.error));
        rangeSelect?.addEventListener('nui-change', () => loadSummary().catch(console.error));
        $('#refresh-btn button').addEventListener('click', () => loadSummary().catch(console.error));

        loadSites().then(loadSummary).catch(err => console.error('overview init failed:', err));
        startTicker();

        element.hide = () => { if (sse) { sse.close(); sse = null; } $('#live-dot').classList.remove('on'); };
        element.show = () => { if (!sse) startTicker(); loadSummary().catch(console.error); };
    }
});

nui.registerPage('raw', {
    html: 'raw.html',
    init(element, params, nui) {
        const $ = (sel) => element.querySelector(sel);
        const siteSelect = $('#raw-site-select');
        const searchInput = $('#raw-search');
        const limitSelect = $('#raw-limit');
        const tbody = $('#raw-tbody');
        const statsEl = $('#raw-stats');
        const emptyEl = $('#raw-empty');
        let allRows = [];

        async function loadSites() {
            const res = await fetch('/analytics/sites');
            if (!res.ok) return;
            const { configured, known } = await res.json();
            for (const s of [...new Set([...configured, ...known])]) {
                if (!siteSelect.querySelector(`option[value="${s}"]`)) siteSelect.addItem(s, s);
            }
        }

        async function loadRows() {
            statsEl.textContent = 'Loading rows…';
            const site = siteSelect.getValue();
            const qs = site ? '?site=' + encodeURIComponent(site) : '';
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
                    if (i === cells.length - 1) td.style.textAlign = 'right';
                    tr.appendChild(td);
                }
                fragment.appendChild(tr);
            }
            tbody.appendChild(fragment);
        }

        siteSelect.addEventListener('nui-change', () => loadRows().catch(console.error));
        limitSelect.addEventListener('nui-change', () => renderRows());
        searchInput.addEventListener('input', () => renderRows());
        $('#raw-refresh-btn button').addEventListener('click', () => loadRows().catch(console.error));

        loadSites().then(loadRows).catch(console.error);
        element.show = () => loadRows().catch(console.error);
    }
});
