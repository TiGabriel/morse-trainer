const test = require('node:test');
const assert = require('node:assert/strict');
const { textToMorse } = require('../textToMorse');

test('textToMorse: basic letters', () => {
    const { morse, invalidCharacters } = textToMorse('SOS');
    assert.equal(morse, '... --- ...');
    assert.deepEqual(invalidCharacters, []);
});

test('textToMorse: is case-insensitive', () => {
    assert.equal(textToMorse('sos').morse, textToMorse('SOS').morse);
});

test('textToMorse: numbers', () => {
    const { morse } = textToMorse('123');
    assert.equal(morse, '.---- ..--- ...--');
});

test('textToMorse: punctuation', () => {
    const { morse } = textToMorse('!');
    assert.equal(morse, '-.-.--');
});

test('textToMorse: multiple words become word-separated with " / "', () => {
    const { morse } = textToMorse('HI THERE');
    const parts = morse.split(' / ');
    assert.equal(parts.length, 2);
    assert.equal(parts[0], textToMorse('HI').morse);
    assert.equal(parts[1], textToMorse('THERE').morse);
});

test('textToMorse: collapses runs of multiple spaces into a single word break', () => {
    const a = textToMorse('HI    THERE').morse;
    const b = textToMorse('HI THERE').morse;
    assert.equal(a, b);
});

test('textToMorse: leading/trailing whitespace is ignored', () => {
    assert.equal(textToMorse('  SOS  ').morse, textToMorse('SOS').morse);
});

test('textToMorse: empty string produces empty morse with no invalid chars', () => {
    const { morse, invalidCharacters } = textToMorse('');
    assert.equal(morse, '');
    assert.deepEqual(invalidCharacters, []);
});

test('textToMorse: unsupported characters are reported and skipped (lenient mode, default)', () => {
    const { morse, invalidCharacters } = textToMorse('A#B');
    assert.equal(morse, textToMorse('AB').morse);
    assert.equal(invalidCharacters.length, 1);
    assert.equal(invalidCharacters[0].char, '#');
    assert.equal(invalidCharacters[0].index, 1);
});

test('textToMorse: strict mode throws on the first unsupported character', () => {
    assert.throws(() => textToMorse('A#B', { strict: true }), /Unsupported character/);
});

test('textToMorse: non-string input throws a TypeError', () => {
    assert.throws(() => textToMorse(12345), TypeError);
});
