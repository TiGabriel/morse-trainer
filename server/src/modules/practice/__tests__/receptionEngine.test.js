const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReceptionExercise, MIN_GROUP_SIZE, MAX_GROUP_SIZE, MIN_GROUP_COUNT, MAX_GROUP_COUNT } = require('../receptionEngine');
const { MorseEngineError } = require('../../morse-engine/errors');
const engine = require('../../morse-engine');

test('buildReceptionExercise: grouped shape matches groupSize x groupCount', () => {
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 10, wpm: 15, seed: 1 });
    assert.equal(result.totalCharacters, 50);
    assert.equal(result.text.replace(/ /g, '').length, 50);
    assert.equal(result.groups.length, 10);
    result.groups.forEach((g) => assert.equal(g.length, 5));
});

test('buildReceptionExercise: 120-character exercise (classic radiogram size, via groups)', () => {
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 4, groupCount: 30, wpm: 18, seed: 2 });
    assert.equal(result.totalCharacters, 120);
});

test('buildReceptionExercise: short exercise (a single small group)', () => {
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 1, wpm: 15, seed: 3 });
    assert.equal(result.totalCharacters, 5);
    assert.equal(result.groups.length, 1);
});

test('buildReceptionExercise: groupSize 0 produces one continuous ungrouped run', () => {
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 0, groupCount: 12, wpm: 15, seed: 4 });
    assert.equal(result.groupSize, null);
    assert.equal(result.totalCharacters, 12);
    assert.equal(result.groups.length, 1);
    assert.equal(result.text.includes(' '), false);
});

test('buildReceptionExercise: letters-only pool never produces numbers', () => {
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 20, wpm: 15, seed: 5 });
    for (const ch of result.text.replace(/ /g, '')) {
        assert.ok(/[A-Z]/.test(ch));
    }
});

test('buildReceptionExercise: numbers-only pool never produces letters', () => {
    const result = buildReceptionExercise({ characters: 'numbers', groupSize: 5, groupCount: 20, wpm: 15, seed: 6 });
    for (const ch of result.text.replace(/ /g, '')) {
        assert.ok(/[0-9]/.test(ch));
    }
});

test('buildReceptionExercise: letters+numbers pool only produces those, and (with enough draws) uses both', () => {
    const result = buildReceptionExercise({ characters: ['A', 'B', '1', '2'], groupSize: 5, groupCount: 20, wpm: 15, seed: 7 });
    const chars = result.text.replace(/ /g, '');
    for (const ch of chars) assert.ok(['A', 'B', '1', '2'].includes(ch));
    assert.ok(/[A-Z]/.test(chars), 'expected at least one letter across 100 draws');
    assert.ok(/[0-9]/.test(chars), 'expected at least one number across 100 draws');
});

test('buildReceptionExercise: same seed => identical exercise (replay/restart never regenerates the answer)', () => {
    const a = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 10, wpm: 15, seed: 'fixed-reception' });
    const b = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 10, wpm: 15, seed: 'fixed-reception' });
    assert.equal(a.text, b.text);
    assert.deepEqual(a.groups, b.groups);
    assert.equal(a.morse, b.morse);
});

test('buildReceptionExercise: honors configurable WPM/Farnsworth/tone frequency', () => {
    const result = buildReceptionExercise({ characters: 'numbers', groupSize: 5, groupCount: 4, wpm: 20, farnsworthWpm: 12, toneFrequencyHz: 700, seed: 8 });
    assert.equal(result.timing.wpm, 20);
    assert.equal(result.timing.farnsworthWpm, 12);
    assert.equal(result.timing.toneFrequencyHz, 700);
    const summed = result.plan.reduce((sum, seg) => sum + seg.durationMs, 0);
    assert.ok(Math.abs(summed - result.durationMs) < 1);
});

test('buildReceptionExercise: rejects missing wpm/characters/groupCount', () => {
    assert.throws(() => buildReceptionExercise({ characters: 'letters', groupCount: 5 }), MorseEngineError);
    assert.throws(() => buildReceptionExercise({ wpm: 15, groupCount: 5 }), MorseEngineError);
    assert.throws(() => buildReceptionExercise({ characters: 'letters', wpm: 15 }), MorseEngineError);
});

test('buildReceptionExercise: rejects groupCount/groupSize out of bounds', () => {
    assert.throws(() => buildReceptionExercise({ characters: 'letters', wpm: 15, groupCount: MAX_GROUP_COUNT + 1 }), MorseEngineError);
    assert.throws(() => buildReceptionExercise({ characters: 'letters', wpm: 15, groupCount: MIN_GROUP_COUNT - 1 }), MorseEngineError);
    assert.throws(() => buildReceptionExercise({ characters: 'letters', wpm: 15, groupCount: 5, groupSize: MAX_GROUP_SIZE + 1 }), MorseEngineError);
    assert.doesNotThrow(() => buildReceptionExercise({ characters: 'letters', wpm: 15, groupCount: 5, groupSize: MIN_GROUP_SIZE }));
});

test('buildReceptionExercise: the reference (grouped) text scores identically to a spacing-normalized submission', () => {
    // Confirms the same normalize-before-scoring approach used elsewhere
    // (strip group-separator whitespace from both sides) produces a
    // perfect score even when the student's own spacing differs from the
    // reference's group layout.
    const result = buildReceptionExercise({ characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 9 });
    const reference = result.text.replace(/\s+/g, '');
    const differentlySpaced = reference.match(/.{1,3}/g).join('  '); // re-group into 3s with double spaces
    const score = engine.scoreAnswer(reference, differentlySpaced.replace(/\s+/g, ''));
    assert.equal(score.accuracyPercent, 100);
});
