const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, escapeCsvField } = require('../csv');

test('escapeCsvField: plain values pass through unchanged', () => {
    assert.equal(escapeCsvField('Ann Smith'), 'Ann Smith');
    assert.equal(escapeCsvField(42), '42');
    assert.equal(escapeCsvField(0), '0');
});

test('escapeCsvField: null/undefined become an empty field, not the literal string "null"', () => {
    assert.equal(escapeCsvField(null), '');
    assert.equal(escapeCsvField(undefined), '');
});

test('escapeCsvField: quotes a field containing a comma', () => {
    assert.equal(escapeCsvField('Smith, Ann'), '"Smith, Ann"');
});

test('escapeCsvField: quotes a field containing a newline', () => {
    assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
});

test('escapeCsvField: doubles embedded quotes and wraps the whole field', () => {
    assert.equal(escapeCsvField('She said "hi"'), '"She said ""hi"""');
});

test('toCsv: produces a header row, one row per record, CRLF line endings, and a leading BOM for Excel', () => {
    const csv = toCsv(['Name', 'Score'], [
        ['Ann Smith', 90],
        ['Bob, Jones', 100],
    ]);
    assert.ok(csv.startsWith('﻿'), 'must start with a UTF-8 BOM so Excel detects encoding correctly');
    const withoutBom = csv.slice(1);
    const lines = withoutBom.split('\r\n');
    assert.equal(lines[0], 'Name,Score');
    assert.equal(lines[1], 'Ann Smith,90');
    assert.equal(lines[2], '"Bob, Jones",100');
});

test('toCsv: an empty row set still produces a valid header-only CSV', () => {
    const csv = toCsv(['A', 'B'], []);
    assert.equal(csv, '﻿A,B\r\n');
});
