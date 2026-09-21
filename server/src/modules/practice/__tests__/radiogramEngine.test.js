const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRadiogram, buildCharacterReveal, ROWS, GROUPS_PER_ROW, GROUP_SIZE, TOTAL_LENGTH } = require('../radiogramEngine');
const { MorseEngineError } = require('../../morse-engine/errors');
const engine = require('../../morse-engine');

test('buildRadiogram: shape is fixed at 3 rows x 10 groups x 4 characters', () => {
    const result = buildRadiogram({ characters: 'letters', wpm: 15, seed: 1 });
    assert.equal(ROWS, 3);
    assert.equal(GROUPS_PER_ROW, 10);
    assert.equal(GROUP_SIZE, 4);
    assert.equal(TOTAL_LENGTH, 120);

    assert.equal(result.groups.length, 30);
    assert.equal(result.rows.length, 3);
    result.groups.forEach((g) => assert.equal(g.length, 4));
    result.rows.forEach((row) => assert.equal(row.split(' ').length, 10));
    assert.equal(result.text.replace(/ /g, '').length, 120);
});

test('buildRadiogram: only uses characters from the selected custom pool', () => {
    const result = buildRadiogram({ characters: ['A', 'B', '1'], wpm: 15, seed: 2 });
    for (const ch of result.text.replace(/ /g, '')) {
        assert.ok(['A', 'B', '1'].includes(ch), `"${ch}" should be in the selected pool`);
    }
});

test('buildRadiogram: same seed => identical radiogram', () => {
    const a = buildRadiogram({ characters: 'letters', wpm: 15, seed: 'fixed' });
    const b = buildRadiogram({ characters: 'letters', wpm: 15, seed: 'fixed' });
    assert.equal(a.text, b.text);
    assert.deepEqual(a.rows, b.rows);
});

test('buildRadiogram: produces a Morse plan whose total duration matches the timing profile', () => {
    const result = buildRadiogram({ characters: 'numbers', wpm: 20, farnsworthWpm: 12, toneFrequencyHz: 700, seed: 3 });
    assert.equal(result.timing.wpm, 20);
    assert.equal(result.timing.toneFrequencyHz, 700);
    assert.ok(result.plan.length > 0);
    const summed = result.plan.reduce((sum, seg) => sum + seg.durationMs, 0);
    assert.equal(summed, result.durationMs);
});

test('buildRadiogram: requires wpm', () => {
    assert.throws(() => buildRadiogram({ characters: 'letters' }), MorseEngineError);
});

test('buildRadiogram: requires a non-empty character pool', () => {
    assert.throws(() => buildRadiogram({ characters: [], wpm: 15 }), MorseEngineError);
});

test('buildRadiogram: charReveal has one entry per character, in transmission order, matching the text', () => {
    const result = buildRadiogram({ characters: 'letters', wpm: 15, seed: 42 });
    const flatChars = result.text.replace(/ /g, '').split('');
    assert.equal(result.charReveal.length, 120);
    assert.deepEqual(result.charReveal.map((r) => r.char), flatChars);
});

test('buildRadiogram: charReveal offsets are strictly increasing and the last one lands exactly on durationMs', () => {
    const result = buildRadiogram({ characters: 'numbers', wpm: 18, seed: 7 });
    for (let i = 1; i < result.charReveal.length; i += 1) {
        assert.ok(
            result.charReveal[i].atMs > result.charReveal[i - 1].atMs,
            `offset ${i} should be strictly after offset ${i - 1}`
        );
    }
    const last = result.charReveal[result.charReveal.length - 1];
    assert.equal(last.atMs, result.durationMs);
});

test('buildCharacterReveal: a single short word reveals each character at the end of its own tones', () => {
    const timing = engine.computeTiming({ wpm: 20 });
    const reveal = buildCharacterReveal('EI', timing);
    // E = "." , I = ".."
    assert.equal(reveal.length, 2);
    assert.equal(reveal[0].char, 'E');
    assert.equal(reveal[0].atMs, timing.dotMs);
    assert.equal(reveal[1].char, 'I');
    assert.equal(reveal[1].atMs, timing.dotMs + timing.interCharGapMs + timing.dotMs + timing.intraCharGapMs + timing.dotMs);
});
