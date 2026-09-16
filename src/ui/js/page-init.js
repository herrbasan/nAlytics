// Page registrations — nui.registerPage() pattern (standard JS modules, no CSP issues).
import { nui } from '/analytics/nui/nui.js';
import { lineChart, hourBars, donut, barRows, flag } from '/analytics/app/js/charts.js';

nui.registerPage('overview', {
    html: 'overview.html',
    init(element, params, nui) {
        const $ = (sel) => element.querySelector(sel);
        const siteSelect = $('#site-select');
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
            const qs = site ? '?site=' + encodeURIComponent(site) : '';
            const [sumRes, langRes, connRes] = await Promise.all([
                fetch('/analytics/summary' + qs),
                fetch('/analytics/dims?dim=lang' + (site ? '&site=' + encodeURIComponent(site) : '')),
                fetch('/analytics/dims?dim=conn' + (site ? '&site=' + encodeURIComponent(site) : ''))
            ]);
            if (!sumRes.ok) throw new Error('summary fetch failed: ' + sumRes.status);
            const s = await sumRes.json();
            const lang = await langRes.json();
            const conn = await connRes.json();
            render(s, lang, conn);
        }

        // ---- rendering ----

        function render(s, lang, conn) {
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
        $('#refresh-btn button').addEventListener('click', () => loadSummary().catch(console.error));

        loadSites().then(loadSummary).catch(err => console.error('overview init failed:', err));
        startTicker();

        element.hide = () => { if (sse) { sse.close(); sse = null; } $('#live-dot').classList.remove('on'); };
        element.show = () => { if (!sse) startTicker(); loadSummary().catch(console.error); };
    }
});
