const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCharacterTrainingSession, MIN_LENGTH, MAX_LENGTH } = require('../characterTrainingEngine');
const { MorseEngineError } = require('../../morse-engine/errors');

test('buildCharacterTrainingSession: produces exactly `length` single-character rounds', () => {
    const session = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 20, seed: 1 });
    assert.equal(session.items.length, 20);
    session.items.forEach((item) => {
        assert.equal(item.char.length, 1);
        assert.ok(item.morse.length > 0);
        assert.ok(Array.isArray(item.plan) && item.plan.length > 0);
        assert.ok(item.durationMs > 0);
    });
});

test('buildCharacterTrainingSession: only uses characters from the selected custom pool', () => {
    const session = buildCharacterTrainingSession({ characters: ['A', 'B', '1'], wpm: 15, length: 40, seed: 2 });
    session.items.forEach((item) => {
        assert.ok(['A', 'B', '1'].includes(item.char), `"${item.char}" should be in the selected pool`);
    });
});

test('buildCharacterTrainingSession: each round\'s plan matches the session timing profile', () => {
    const session = buildCharacterTrainingSession({ characters: 'numbers', wpm: 20, farnsworthWpm: 10, toneFrequencyHz: 700, seed: 3, length: 10 });
    assert.equal(session.timing.wpm, 20);
    assert.equal(session.timing.toneFrequencyHz, 700);
    session.items.forEach((item) => {
        const summed = item.plan.reduce((sum, seg) => sum + seg.durationMs, 0);
        assert.equal(summed, item.durationMs);
    });
});

test('buildCharacterTrainingSession: same seed => identical session', () => {
    const a = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 15, seed: 'fixed' });
    const b = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 15, seed: 'fixed' });
    assert.deepEqual(a.items.map((i) => i.char), b.items.map((i) => i.char));
});

test('buildCharacterTrainingSession: supports session lengths at both ends of a realistic range (10 and 120)', () => {
    const short = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 10, seed: 4 });
    const long = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 120, seed: 5 });
    assert.equal(short.items.length, 10);
    assert.equal(long.items.length, 120);
});

test('buildCharacterTrainingSession: requires wpm', () => {
    assert.throws(() => buildCharacterTrainingSession({ characters: 'letters', length: 10 }), MorseEngineError);
});

test('buildCharacterTrainingSession: requires a non-empty character pool', () => {
    assert.throws(() => buildCharacterTrainingSession({ characters: [], wpm: 15, length: 10 }), MorseEngineError);
});

test('buildCharacterTrainingSession: rejects an out-of-range length', () => {
    assert.throws(() => buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 0 }), MorseEngineError);
    assert.throws(() => buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: MAX_LENGTH + 1 }), MorseEngineError);
    assert.throws(() => buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: 1.5 }), MorseEngineError);
});

test('buildCharacterTrainingSession: MIN_LENGTH is honored', () => {
    const session = buildCharacterTrainingSession({ characters: 'letters', wpm: 15, length: MIN_LENGTH, seed: 6 });
    assert.equal(session.items.length, MIN_LENGTH);
});
