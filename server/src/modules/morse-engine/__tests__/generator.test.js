const test = require('node:test');
const assert = require('node:assert/strict');
const { generateRandomText, generateFromDifficulty } = require('../generator');
const { DIFFICULTY_PRESETS, findDifficultyPreset } = require('../difficultyPresets');
const { CHARSETS, isSupportedChar } = require('../morseMap');
const { MorseEngineError } = require('../errors');

test('generateRandomText: produces the requested length', () => {
    const { text } = generateRandomText({ characters: 'letters', length: 15, seed: 1 });
    assert.equal(text.length, 15);
});

test('generateRandomText: only uses characters from the requested pool', () => {
    const { text } = generateRandomText({ characters: 'numbers', length: 50, seed: 2 });
    for (const ch of text) {
        assert.ok(CHARSETS.numbers.includes(ch), `"${ch}" should be a number character`);
    }
});

test('generateRandomText: every generated character is a supported Morse character', () => {
    const { text } = generateRandomText({ characters: 'all', length: 100, seed: 3 });
    for (const ch of text) {
        assert.ok(isSupportedChar(ch));
    }
});

test('generateRandomText: same seed => identical output (reproducibility)', () => {
    const a = generateRandomText({ characters: 'letters', length: 30, seed: 'fixed-seed' });
    const b = generateRandomText({ characters: 'letters', length: 30, seed: 'fixed-seed' });
    assert.equal(a.text, b.text);
    assert.equal(a.seed, b.seed);
});

test('generateRandomText: same numeric seed => identical output', () => {
    const a = generateRandomText({ characters: 'letters', length: 30, seed: 12345 });
    const b = generateRandomText({ characters: 'letters', length: 30, seed: 12345 });
    assert.equal(a.text, b.text);
});

test('generateRandomText: different seeds usually produce different output', () => {
    const a = generateRandomText({ characters: 'letters', length: 30, seed: 'seed-A' });
    const b = generateRandomText({ characters: 'letters', length: 30, seed: 'seed-B' });
    assert.notEqual(a.text, b.text);
});

test('generateRandomText: omitting a seed still returns one that can be reused for reproduction', () => {
    const a = generateRandomText({ characters: 'letters', length: 10 });
    assert.equal(typeof a.seed, 'number');
    const b = generateRandomText({ characters: 'letters', length: 10, seed: a.seed });
    assert.equal(a.text, b.text);
});

test('generateRandomText: groupSize chunks output into space-separated groups', () => {
    const { text } = generateRandomText({ characters: 'letters', length: 12, groupSize: 4, seed: 4 });
    const groups = text.split(' ');
    assert.deepEqual(groups.map((g) => g.length), [4, 4, 4]);
    assert.equal(groups.join(''), text.replace(/ /g, ''));
});

test('generateRandomText: groupSize does not evenly divide length -> final short group', () => {
    const { text } = generateRandomText({ characters: 'letters', length: 10, groupSize: 4, seed: 5 });
    const groups = text.split(' ');
    assert.deepEqual(groups.map((g) => g.length), [4, 4, 2]);
});

test('generateRandomText: accepts a literal string of custom characters', () => {
    const { text } = generateRandomText({ characters: 'AB', length: 20, seed: 6 });
    for (const ch of text) {
        assert.ok(ch === 'A' || ch === 'B');
    }
});

test('generateRandomText: rejects an empty character pool', () => {
    assert.throws(() => generateRandomText({ characters: '', length: 5 }), MorseEngineError);
});

test('generateRandomText: rejects a non-positive length', () => {
    assert.throws(() => generateRandomText({ characters: 'letters', length: 0 }), MorseEngineError);
    assert.throws(() => generateRandomText({ characters: 'letters', length: -3 }), MorseEngineError);
});

// -----------------------------------------------------------------------
// Difficulty presets are DATA, driven through one generic function.
// -----------------------------------------------------------------------

test('DIFFICULTY_PRESETS: every preset has the fields the generator depends on', () => {
    for (const preset of DIFFICULTY_PRESETS) {
        assert.ok(preset.id);
        assert.ok(preset.characters);
        assert.ok(Array.isArray(preset.wpmRange) && preset.wpmRange.length === 2);
        assert.ok(Array.isArray(preset.lengthRange) && preset.lengthRange.length === 2);
    }
});

test('findDifficultyPreset: finds a known preset and returns null for an unknown one', () => {
    assert.equal(findDifficultyPreset('easy').id, 'easy');
    assert.equal(findDifficultyPreset('nonexistent-difficulty'), null);
});

test('generateFromDifficulty: resolves wpm and length within the preset\'s configured ranges', () => {
    const preset = findDifficultyPreset('medium');
    for (let seed = 0; seed < 20; seed += 1) {
        const result = generateFromDifficulty('medium', { seed });
        assert.ok(result.wpm >= preset.wpmRange[0] && result.wpm <= preset.wpmRange[1]);
        assert.ok(result.length >= preset.lengthRange[0] && result.length <= preset.lengthRange[1]);
        assert.equal(result.text.replace(/ /g, '').length, result.length);
    }
});

test('generateFromDifficulty: same seed => fully reproducible result (text, wpm, and length together)', () => {
    const a = generateFromDifficulty('hard', { seed: 999 });
    const b = generateFromDifficulty('hard', { seed: 999 });
    assert.deepEqual(a, b);
});

test('generateFromDifficulty: resolved values (wpm/length/farnsworthWpm) do not depend on WHICH subset of fields happens to be overridden, only on the seed — regression test for a draw-order bug', () => {
    // Call 1: only wpm overridden.
    const call1 = generateFromDifficulty('easy', { seed: 424242, wpm: 15 });
    // Call 2: same seed, but ALSO explicitly echoes back call1's own
    // resolved length (as a real client would do between a "generate"
    // and a later "submit" call). Before the fix, this changed how many
    // RNG draws preceded the farnsworthWpm draw, silently producing a
    // different farnsworthWpm (and would have risked a different
    // character sequence with a less careful fix).
    const call2 = generateFromDifficulty('easy', { seed: 424242, wpm: 15, length: call1.length });
    assert.deepEqual(call1, call2);
});

test('generateFromDifficulty: overrides win over preset defaults', () => {
    const result = generateFromDifficulty('easy', { seed: 1, wpm: 42, length: 7 });
    assert.equal(result.wpm, 42);
    assert.equal(result.length, 7);
    assert.equal(result.text.replace(/ /g, '').length, 7);
});

test('generateFromDifficulty: throws for an unknown difficulty id', () => {
    assert.throws(() => generateFromDifficulty('legendary'), MorseEngineError);
});

test('generateFromDifficulty: characters generated respect the preset\'s character pool', () => {
    const beginner = findDifficultyPreset('beginner');
    const result = generateFromDifficulty('beginner', { seed: 7, length: 40 });
    for (const ch of result.text) {
        assert.ok(beginner.characters.includes(ch));
    }
});
