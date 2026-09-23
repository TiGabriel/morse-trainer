const test = require('node:test');
const assert = require('node:assert/strict');
const { CHAR_TO_MORSE, KOCH_ORDER, learnedLettersPool } = require('../morseMap');

test('KOCH_ORDER: every entry is a real, supported character (no typos in the learning order)', () => {
    KOCH_ORDER.forEach((ch) => {
        assert.ok(Object.prototype.hasOwnProperty.call(CHAR_TO_MORSE, ch), `"${ch}" in KOCH_ORDER is not a valid CHAR_TO_MORSE key`);
    });
});

test('KOCH_ORDER: has no duplicate characters', () => {
    assert.equal(new Set(KOCH_ORDER).size, KOCH_ORDER.length);
});

test('learnedLettersPool: returns the first N characters of the learning order, in order', () => {
    assert.deepEqual(learnedLettersPool(5), KOCH_ORDER.slice(0, 5));
    assert.deepEqual(learnedLettersPool(1), [KOCH_ORDER[0]]);
});

test('learnedLettersPool: clamps below 0 and above the full order length', () => {
    assert.deepEqual(learnedLettersPool(0), []);
    assert.deepEqual(learnedLettersPool(-5), []);
    assert.deepEqual(learnedLettersPool(KOCH_ORDER.length + 100), KOCH_ORDER);
});

test('learnedLettersPool: a larger count is always a superset of a smaller count (monotonic progression)', () => {
    const small = learnedLettersPool(5);
    const larger = learnedLettersPool(10);
    small.forEach((ch) => assert.ok(larger.includes(ch)));
});
