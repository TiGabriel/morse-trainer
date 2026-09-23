/**
 * MiniChart — small, dependency-free inline-SVG charts for the student
 * History & Progress page (see stats.js). No charting library: this is
 * a offline-only LAN classroom app with no build step, so pulling in an
 * external CDN chart library isn't an option (and isn't needed for four
 * small over-time/comparison charts).
 *
 * Deliberately minimal: a line chart (accuracy/WPM/errors over time) and
 * a bar chart (reception vs transmission). Null values in a line series
 * are gaps, never interpolated across — same "don't fabricate data for a
 * quiet day" rule the server's own day-bucketed queries already follow.
 */
(function (root) {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function el(tag, attrs, children) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
        (children || []).forEach((c) => node.appendChild(c));
        return node;
    }

    function emptyState(container, message) {
        container.innerHTML = `<p class="mini-chart-empty">${message}</p>`;
    }

    /**
     * @param {HTMLElement} container
     * @param {Array<{x: string, y: number|null}>} points - in display order (oldest first).
     * @param {{color?: string, unit?: string, height?: number, min?: number, max?: number}} [opts]
     */
    function renderLineChart(container, points, opts = {}) {
        container.innerHTML = '';
        const withData = points.filter((p) => p.y !== null && p.y !== undefined);
        if (withData.length === 0) {
            emptyState(container, window.t ? window.t('stats.noDataYetShort') : 'No data yet.');
            return;
        }

        const color = opts.color || '#3d7ab8';
        const unit = opts.unit || '';
        const height = opts.height || 140;
        const width = Math.max(240, points.length * 28);
        const padding = { top: 12, right: 12, bottom: 24, left: 12 };
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;

        const yMin = opts.min !== undefined ? opts.min : Math.min(...withData.map((p) => p.y));
        const yMax = opts.max !== undefined ? opts.max : Math.max(...withData.map((p) => p.y));
        const yRange = yMax - yMin || 1;

        const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
        const xAt = (i) => padding.left + i * xStep;
        const yAt = (v) => padding.top + plotH - ((v - yMin) / yRange) * plotH;

        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'mini-chart-svg', preserveAspectRatio: 'xMidYMid meet' });

        // Baseline
        svg.appendChild(el('line', { x1: padding.left, y1: padding.top + plotH, x2: width - padding.right, y2: padding.top + plotH, stroke: 'currentColor', 'stroke-opacity': 0.15 }));

        // Line segments — broken at gaps (null values), never bridged.
        let pathD = '';
        let drawing = false;
        points.forEach((p, i) => {
            if (p.y === null || p.y === undefined) {
                drawing = false;
                return;
            }
            const cmd = drawing ? 'L' : 'M';
            pathD += `${cmd}${xAt(i).toFixed(1)},${yAt(p.y).toFixed(1)} `;
            drawing = true;
        });
        if (pathD) {
            svg.appendChild(el('path', { d: pathD.trim(), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        }

        // Points (with a native tooltip via <title> — no JS interactivity needed).
        points.forEach((p, i) => {
            if (p.y === null || p.y === undefined) return;
            const circle = el('circle', { cx: xAt(i).toFixed(1), cy: yAt(p.y).toFixed(1), r: 3, fill: color });
            circle.appendChild(el('title', {}, []));
            circle.lastChild.textContent = `${p.x}: ${p.y}${unit}`;
            svg.appendChild(circle);
        });

        // A handful of x-axis labels only (first, middle, last) — dense
        // per-point labels would overlap on any real amount of history.
        const labelIndexes = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
        [...new Set(labelIndexes)].forEach((i) => {
            const text = el('text', { x: xAt(i).toFixed(1), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', class: 'mini-chart-axis-label' });
            text.textContent = points[i].x;
            svg.appendChild(text);
        });

        container.innerHTML = '';
        container.appendChild(svg);
    }

    /**
     * @param {HTMLElement} container
     * @param {Array<{label: string, value: number|null, color?: string}>} bars
     * @param {{unit?: string, height?: number}} [opts]
     */
    function renderBarChart(container, bars, opts = {}) {
        container.innerHTML = '';
        const withData = bars.filter((b) => b.value !== null && b.value !== undefined);
        if (withData.length === 0) {
            emptyState(container, window.t ? window.t('stats.noDataYetShort') : 'No data yet.');
            return;
        }

        const unit = opts.unit || '';
        const height = opts.height || 140;
        const width = 260;
        const padding = { top: 12, right: 12, bottom: 28, left: 12 };
        const plotW = width - padding.left - padding.right;
        const plotH = height - padding.top - padding.bottom;
        const maxValue = Math.max(...withData.map((b) => b.value), 1);
        const barWidth = plotW / bars.length - 16;

        const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, class: 'mini-chart-svg', preserveAspectRatio: 'xMidYMid meet' });
        svg.appendChild(el('line', { x1: padding.left, y1: padding.top + plotH, x2: width - padding.right, y2: padding.top + plotH, stroke: 'currentColor', 'stroke-opacity': 0.15 }));

        bars.forEach((b, i) => {
            const slotX = padding.left + i * (plotW / bars.length);
            const barX = slotX + 8;
            if (b.value === null || b.value === undefined) {
                const text = el('text', { x: slotX + plotW / bars.length / 2, y: padding.top + plotH / 2, 'text-anchor': 'middle', class: 'mini-chart-axis-label' });
                text.textContent = window.t ? window.t('stats.noDataShort') : 'no data';
                svg.appendChild(text);
            } else {
                const barH = (b.value / maxValue) * plotH;
                const rect = el('rect', {
                    x: barX.toFixed(1),
                    y: (padding.top + plotH - barH).toFixed(1),
                    width: Math.max(4, barWidth).toFixed(1),
                    height: barH.toFixed(1),
                    fill: b.color || '#3d7ab8',
                    rx: 3,
                });
                rect.appendChild(el('title', {}, []));
                rect.lastChild.textContent = `${b.label}: ${b.value}${unit}`;
                svg.appendChild(rect);

                const valueText = el('text', { x: (barX + barWidth / 2).toFixed(1), y: (padding.top + plotH - barH - 4).toFixed(1), 'text-anchor': 'middle', class: 'mini-chart-value-label' });
                valueText.textContent = `${b.value}${unit}`;
                svg.appendChild(valueText);
            }
            const labelText = el('text', { x: slotX + plotW / bars.length / 2, y: height - 6, 'text-anchor': 'middle', class: 'mini-chart-axis-label' });
            labelText.textContent = b.label;
            svg.appendChild(labelText);
        });

        container.innerHTML = '';
        container.appendChild(svg);
    }

    root.MiniChart = { renderLineChart, renderBarChart };
})(typeof window !== 'undefined' ? window : globalThis);
