const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreAnswer } = require('../scoring');

test('scoreAnswer: perfect match scores 100% with only correct characters', () => {
    const s = scoreAnswer('HELLO', 'HELLO');
    assert.equal(s.correctCount, 5);
    assert.equal(s.incorrectCount, 0);
    assert.equal(s.missingCount, 0);
    assert.equal(s.extraCount, 0);
    assert.equal(s.accuracyPercent, 100);
    assert.equal(s.errorCount, 0);
});

test('scoreAnswer: is case-insensitive by default', () => {
    const s = scoreAnswer('HELLO', 'hello');
    assert.equal(s.correctCount, 5);
    assert.equal(s.accuracyPercent, 100);
});

test('scoreAnswer: caseSensitive option treats case differences as substitutions', () => {
    const s = scoreAnswer('HELLO', 'hello', { caseSensitive: true });
    assert.equal(s.correctCount, 0);
    assert.equal(s.incorrectCount, 5);
});

test('scoreAnswer: a single substitution is reported as one incorrect character, not a cascade', () => {
    const s = scoreAnswer('HELLO', 'HXLLO');
    assert.equal(s.correctCount, 4);
    assert.equal(s.incorrectCount, 1);
    assert.equal(s.missingCount, 0);
    assert.equal(s.extraCount, 0);
    const sub = s.ops.find((o) => o.type === 'substitution');
    assert.equal(sub.expectedChar, 'E');
    assert.equal(sub.submittedChar, 'X');
});

test('scoreAnswer: a dropped character in the middle is one "missing", not cascading errors', () => {
    // Expected "HELLO", student typed "HELO" (dropped the second L).
    const s = scoreAnswer('HELLO', 'HELO');
    assert.equal(s.correctCount, 4); // H, E, L, O all still align correctly
    assert.equal(s.missingCount, 1);
    assert.equal(s.incorrectCount, 0);
    assert.equal(s.extraCount, 0);
    assert.equal(s.ops.find((o) => o.type === 'missing').expectedChar, 'L');
});

test('scoreAnswer: an extra inserted character is reported as "extra", not cascading errors', () => {
    // Expected "CAT", student typed "CHAT" (extra H).
    const s = scoreAnswer('CAT', 'CHAT');
    assert.equal(s.correctCount, 3);
    assert.equal(s.extraCount, 1);
    assert.equal(s.incorrectCount, 0);
    assert.equal(s.missingCount, 0);
    assert.equal(s.ops.find((o) => o.type === 'extra').submittedChar, 'H');
});

test('scoreAnswer: completely wrong answer of the same length is all substitutions', () => {
    const s = scoreAnswer('ABC', 'XYZ');
    assert.equal(s.correctCount, 0);
    assert.equal(s.incorrectCount, 3);
    assert.equal(s.accuracyPercent, 0);
});

test('scoreAnswer: empty submission scores 0% with everything missing', () => {
    const s = scoreAnswer('SOS', '');
    assert.equal(s.correctCount, 0);
    assert.equal(s.missingCount, 3);
    assert.equal(s.accuracyPercent, 0);
    assert.equal(s.totalSubmitted, 0);
});

test('scoreAnswer: empty expected answer with a non-empty submission is all extra, 0% (not divide-by-zero NaN)', () => {
    const s = scoreAnswer('', 'ABC');
    assert.equal(s.extraCount, 3);
    assert.equal(s.accuracyPercent, 0);
});

test('scoreAnswer: both empty scores 100% (nothing to get wrong)', () => {
    const s = scoreAnswer('', '');
    assert.equal(s.accuracyPercent, 100);
    assert.equal(s.errorCount, 0);
});

test('scoreAnswer: accuracy is relative to the expected answer\'s length', () => {
    // 8 of 10 expected characters correct -> 80%.
    const s = scoreAnswer('ABCDEFGHIJ', 'ABCDEFGH');
    assert.equal(s.correctCount, 8);
    assert.equal(s.missingCount, 2);
    assert.equal(s.accuracyPercent, 80);
});

test('scoreAnswer: works on Morse strings (dots/dashes/spaces), not just letters', () => {
    const s = scoreAnswer('... --- ...', '... --- ...');
    assert.equal(s.correctCount, 11); // includes the two space characters
    assert.equal(s.accuracyPercent, 100);
});

test('scoreAnswer: rejects non-string input', () => {
    assert.throws(() => scoreAnswer(123, 'ABC'), TypeError);
    assert.throws(() => scoreAnswer('ABC', null), TypeError);
});

test('scoreAnswer: rejects excessively long input', () => {
    const long = 'A'.repeat(2001);
    assert.throws(() => scoreAnswer(long, 'A'));
});

test('scoreAnswer: ops array covers every expected and submitted character exactly once', () => {
    const expected = 'HELLO WORLD';
    const submitted = 'HELO WRLD';
    const s = scoreAnswer(expected, submitted);

    const expectedIndicesCovered = s.ops
        .filter((o) => o.expectedIndex !== undefined)
        .map((o) => o.expectedIndex)
        .sort((x, y) => x - y);
    const submittedIndicesCovered = s.ops
        .filter((o) => o.submittedIndex !== undefined)
        .map((o) => o.submittedIndex)
        .sort((x, y) => x - y);

    assert.deepEqual(expectedIndicesCovered, [...Array(expected.length).keys()]);
    assert.deepEqual(submittedIndicesCovered, [...Array(submitted.length).keys()]);
});
