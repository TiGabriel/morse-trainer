/**
 * Minimal CSV generation — no dependency needed for this: quoting fields
 * that contain a comma/quote/newline (doubling embedded quotes, per
 * RFC 4180) is the entire algorithm. A leading UTF-8 BOM is included so
 * Excel (the "Excel-compatible export" requirement) opens accented
 * characters correctly instead of mis-detecting the encoding.
 */
function escapeCsvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string}
 */
function toCsv(headers, rows) {
    const lines = [headers.map(escapeCsvField).join(',')];
    rows.forEach((row) => lines.push(row.map(escapeCsvField).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

/**
 * Free-form variant of toCsv for report-shaped files (section headings,
 * repeated column headers, blank separator lines): every entry of
 * `lines` is one CSV line's cells; an empty array produces a blank line.
 * @param {Array<Array<string|number|null>>} lines
 * @returns {string}
 */
function toCsvLines(lines) {
    return '﻿' + lines.map((cells) => cells.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
}

module.exports = { toCsv, toCsvLines, escapeCsvField };
