/**
 * Server-local time conversion. The helper follows the server PC's SYSTEM
 * time zone (nothing hardcoded), so this test pins the process zone via
 * process.env.TZ before loading it, then checks SQLite UTC strings, the
 * summer/winter offset, the calendar-day boundary around midnight, and
 * the local_date() SQL function on a real temp DB.
 */
process.env.TZ = 'Europe/Bucharest'; // stands in for "whatever the server PC is set to"

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-servertime-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const { TIME_ZONE, localDate, localDateTime, localDateOffset, toDate } = require('../serverTime');
const db = require('../../db/client');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDbPath + suffix, { force: true });
});

test('the time zone is the process/system zone, not a hardcoded one', () => {
    assert.equal(TIME_ZONE, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(TIME_ZONE, 'Europe/Bucharest');
});

test('SQLite "YYYY-MM-DD HH:MM:SS" is read as UTC and shown in server-local summer time', () => {
    assert.equal(localDateTime('2026-09-23 08:27:25'), '2026-09-23 11:27:25');
});

test('winter time offset differs from summer', () => {
    assert.equal(localDateTime('2026-01-15 10:00:00'), '2026-01-15 12:00:00');
});

test('daylight-saving switch days (last Sunday of March / October)', () => {
    assert.equal(localDateTime('2026-03-29 00:30:00'), '2026-03-29 02:30:00'); // before the jump
    assert.equal(localDateTime('2026-03-29 01:30:00'), '2026-03-29 04:30:00'); // after
    assert.equal(localDateTime('2026-10-25 00:30:00'), '2026-10-25 03:30:00'); // still summer
    assert.equal(localDateTime('2026-10-25 01:30:00'), '2026-10-25 03:30:00'); // back to winter
});

test('late-evening UTC belongs to the NEXT local calendar day', () => {
    assert.equal(localDate('2026-09-22 22:30:00'), '2026-09-23'); // 01:30 local
    assert.equal(localDate('2026-09-22 20:59:59'), '2026-09-22'); // 23:59:59 local
});

test('ISO strings with a zone are honoured; garbage is null', () => {
    assert.equal(localDateTime('2026-09-23T08:27:25.744Z'), '2026-09-23 11:27:25');
    assert.equal(localDateTime('2026-09-23T11:27:25+03:00'), '2026-09-23 11:27:25');
    assert.equal(toDate('not a date'), null);
    assert.equal(localDate(null), null);
});

test('localDateOffset counts whole local calendar days, across month ends', () => {
    const now = new Date('2026-03-01T01:00:00Z'); // 03:00 on 1 March locally
    assert.equal(localDateOffset(0, now), '2026-03-01');
    assert.equal(localDateOffset(-1, now), '2026-02-28');
    assert.equal(localDateOffset(-30, now), '2026-01-30');
});

test('the local_date() SQL function groups by the server-local day', () => {
    const row = db.prepare("SELECT local_date('2026-09-22 22:30:00') AS local, date('2026-09-22 22:30:00') AS utc").get();
    assert.equal(row.local, '2026-09-23');
    assert.equal(row.utc, '2026-09-22');
});
