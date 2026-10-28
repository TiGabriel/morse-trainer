/**
 * Server-PC local time for everything shown to people or grouped "by
 * day". The authoritative clock is the SYSTEM CLOCK (and system time
 * zone) of the machine running this server — nothing is hardcoded, so
 * the app follows whatever the teacher/server PC is set to.
 *
 * Storage is unchanged: SQLite's datetime('now') keeps writing UTC
 * "YYYY-MM-DD HH:MM:SS" (no zone marker), ISO strings stay UTC, and all
 * session/playback timing stays in epoch milliseconds (Date.now() on the
 * server), which is zone-independent. This module only CONVERTS for
 * display / day boundaries. Daylight-saving switches are handled by the
 * Intl time zone database.
 */

// The server PC's own system time zone (e.g. "Europe/Bucharest"), read
// once at startup. Exposed to clients via GET /api/time so they display
// times in the server's zone, not their own.
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// en-CA formats dates as YYYY-MM-DD; hourCycle h23 gives 00-23 hours.
const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** A Date from a Date, epoch ms, ISO string, or SQLite UTC "YYYY-MM-DD HH:MM:SS" (treated as UTC). Null if unparseable. */
function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') return new Date(value);
    const s = String(value).trim().replace(' ', 'T');
    const hasZone = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s);
    const d = new Date(/T/.test(s) && !hasZone ? `${s}Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parts(format, date) {
    return Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
}

/** "YYYY-MM-DD" in the server's local time zone — the calendar day a timestamp belongs to locally. */
function localDate(value = new Date()) {
    const d = toDate(value);
    if (!d) return null;
    const p = parts(DATE_FORMAT, d);
    return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYY-MM-DD HH:MM:SS" in the server's local time zone. */
function localDateTime(value = new Date()) {
    const d = toDate(value);
    if (!d) return null;
    const p = parts(DATE_TIME_FORMAT, d);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Today's server-local date shifted by whole calendar days ("YYYY-MM-DD"), e.g. -30 for "30 days ago". */
function localDateOffset(daysOffset, now = new Date()) {
    const [y, m, d] = localDate(now).split('-').map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d + daysOffset));
    return shifted.toISOString().slice(0, 10);
}

module.exports = { TIME_ZONE, toDate, localDate, localDateTime, localDateOffset };
