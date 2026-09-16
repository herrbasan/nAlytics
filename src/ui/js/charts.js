// charts.js — hand-rolled SVG chart builders. No dependencies, no NUI styling conflicts:
// everything here is OUR content inside plain wrappers, using theme CSS variables.

/** ISO country code → emoji flag ('DE' → 🇩🇪). '??' and invalid → 🌐. */
export function flag(cc) {
    if (!/^[A-Za-z]{2}$/.test(cc || '')) return '🌐';
    return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Multi-series line/area chart. series: [{ name, color, values: number[] }]
 * labels: x-axis label per index. Returns an SVG string (viewBox 0 0 720 240).
 */
export function lineChart(series, labels, { height = 240 } = {}) {
    const W = 720, H = height, padL = 36, padR = 8, padT = 12, padB = 24;
    const n = labels.length;
    const max = Math.max(1, ...series.flatMap(s => s.values));
    const niceMax = Math.ceil(max / 5) * 5 || 5;
    const x = (i) => padL + (n <= 1 ? 0 : (W - padL - padR) * i / (n - 1));
    const y = (v) => H - padB - (H - padT - padB) * v / niceMax;

    const gridY = [0, 0.25, 0.5, 0.75, 1].map(t => {
        const gy = padT + (H - padT - padB) * t;
        const val = Math.round(niceMax * (1 - t));
        return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--border-shade1)" stroke-width="1"/>` +
            `<text x="${padL - 6}" y="${gy + 4}" text-anchor="end" font-size="11" fill="var(--color-text-dim)">${val}</text>`;
    }).join('');

    const labelEvery = Math.ceil(n / 10);
    const gridX = labels.map((l, i) =>
        i % labelEvery === 0 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="var(--color-text-dim)">${esc(l)}</text>` : ''
    ).join('');

    const paths = series.map(s => {
        const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        const line = `<polyline fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts.join(' ')}"><title>${esc(s.name)}</title></polyline>`;
        const area = s.fill
            ? `<polygon fill="${s.color}" opacity="0.12" points="${padL},${y(0)} ${pts.join(' ')} ${x(n - 1)},${y(0)}"/>`
            : '';
        const dots = s.values.map((v, i) =>
            `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.name)} ${esc(labels[i])}: ${v}</title></circle>`
        ).join('');
        return area + line + dots;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;display:block">${gridY}${gridX}${paths}</svg>`;
}

/**
 * 24-bar hour-of-day histogram. values: number[24], index = hour.
 * Bars use the accent color; current hour (UTC) highlighted.
 */
export function hourBars(values) {
    const W = 720, H = 120, padB = 18;
    const max = Math.max(1, ...values);
    const bw = (W / 24) * 0.7;
    const nowHour = new Date().getUTCHours();
    const bars = values.map((v, h) => {
        const bh = (H - padB - 8) * v / max;
        const x = (W / 24) * h + (W / 24 - bw) / 2;
        const hot = h === nowHour;
        return `<rect x="${x.toFixed(1)}" y="${(H - padB - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${hot ? 'var(--color-highlight)' : 'var(--color-highlight-dim)'}"><title>${String(h).padStart(2, '0')}:00 UTC — ${v} views</title></rect>` +
            (h % 3 === 0 ? `<text x="${(W / 24) * h + W / 48}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--color-text-dim)">${h}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;display:block">${bars}</svg>`;
}

/**
 * Donut chart. parts: [{ label, value, color }] — colors default to a palette.
 * Returns SVG string (square, 160px viewBox) + center total.
 */
const PALETTE = ['#4f8cff', '#e0556a', '#3aa66a', '#c98a2d', '#7a5fd0', '#4aa8c0', '#b05580'];
export function donut(parts) {
    const total = parts.reduce((a, p) => a + p.value, 0) || 1;
    const R = 60, C = 2 * Math.PI * R;
    let off = 0;
    const segs = parts.map((p, i) => {
        const frac = p.value / total;
        const seg = `<circle r="${R}" cx="80" cy="80" fill="none" stroke="${p.color || PALETTE[i % PALETTE.length]}" stroke-width="22" stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}" stroke-dashoffset="${(-off * C).toFixed(2)}" transform="rotate(-90 80 80)"><title>${esc(p.label)}: ${p.value}</title></circle>`;
        off += frac;
        return seg;
    }).join('');
    return `<svg viewBox="0 0 160 160" role="img" style="width:160px;height:160px">${segs}<text x="80" y="76" text-anchor="middle" font-size="26" fill="var(--color-text)">${total}</text><text x="80" y="96" text-anchor="middle" font-size="11" fill="var(--color-text-dim)">total</text></svg>`;
}

/** Horizontal bar row list (HTML). rows: [{ label, sub?, value, max }] */
export function barRows(rows) {
    const max = Math.max(1, ...rows.map(r => r.value));
    return rows.map(r => `
        <div class="bar-row" title="${esc(r.label)}: ${r.value}">
            <div class="bar-row-label"><span>${esc(r.label)}${r.sub ? ` <span class="bar-row-sub">${esc(r.sub)}</span>` : ''}</span><span class="bar-row-value">${r.value}</span></div>
            <div class="bar-row-track"><div class="bar-row-fill" style="width:${(100 * r.value / max).toFixed(1)}%"></div></div>
        </div>`).join('');
}
