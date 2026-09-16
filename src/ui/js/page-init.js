// Page registrations — nui.registerPage() pattern (standard JS modules, no CSP issues).
import { nui } from '/analytics/nui/nui.js';

nui.registerPage('overview', {
    html: 'overview.html',
    init(element, params, nui) {
        const siteSelect = element.querySelector('#site-select');
        const summaryUrl = (site) => `/analytics/summary${site ? '?site=' + encodeURIComponent(site) : ''}`;
        let sse = null;

        async function loadSites() {
            const res = await fetch('/analytics/sites');
            if (!res.ok) throw new Error('sites fetch failed: ' + res.status);
            const { configured, known } = await res.json();
            const sites = [...new Set([...configured, ...known])];
            // Keep the "All sites" option, add each site via the programmatic API
            for (const s of sites) {
                if (!siteSelect.querySelector(`option[value="${s}"]`)) siteSelect.addItem(s, s);
            }
        }

        async function loadSummary() {
            const site = siteSelect.getValue();
            const res = await fetch(summaryUrl(site));
            if (!res.ok) throw new Error('summary fetch failed: ' + res.status);
            const s = await res.json();
            element.querySelector('#stat-total').textContent = s.total;
            element.querySelector('#stat-rejects').textContent = s.rejects;
            element.querySelector('#stat-days').textContent = s.days;

            const tbody = element.querySelector('#top-paths tbody');
            tbody.replaceChildren(
                ...s.topPaths.map(({ k, v }) => {
                    const tr = document.createElement('tr');
                    const td1 = document.createElement('td'); td1.textContent = k;
                    const td2 = document.createElement('td'); td2.textContent = v;
                    tr.append(td1, td2);
                    return tr;
                })
            );
        }

        function startTicker() {
            sse = new EventSource('/analytics/sse');
            const table = element.querySelector('#ticker');
            const tbody = table.querySelector('tbody');
            sse.onmessage = (e) => {
                element.querySelector('#ticker-empty').hidden = true;
                table.hidden = false;
                const ev = JSON.parse(e.data);
                const tr = document.createElement('tr');
                const cells = [
                    new Date().toLocaleTimeString(),
                    ev.site, ev.path, ev.cc, ev.device, ev.refd || '(direct)'
                ];
                for (const c of cells) {
                    const td = document.createElement('td'); td.textContent = c; tr.append(td);
                }
                tbody.prepend(tr);
                // keep the ticker light
                while (tbody.children.length > 50) tbody.lastChild.remove();
            };
        }

        siteSelect.addEventListener('nui-change', loadSummary);
        element.querySelector('#refresh-btn button').addEventListener('click', loadSummary);

        // Custom data-action from the page
        element.addEventListener('nui-action-refresh-summary', loadSummary);

        loadSites().then(loadSummary).catch(err => console.error('overview init failed:', err));
        startTicker();

        // Lifecycle: close SSE when navigating away
        element.hide = () => { if (sse) sse.close(); };
        element.show = () => { if (!sse) startTicker(); loadSummary(); };
    }
});
