const test = require('node:test');
const assert = require('node:assert/strict');
const { morseToText } = require('../morseToText');
const { textToMorse } = require('../textToMorse');

test('morseToText: basic letters', () => {
    assert.equal(morseToText('... --- ...').text, 'SOS');
});

test('morseToText: numbers', () => {
    assert.equal(morseToText('.---- ..--- ...--').text, '123');
});

test('morseToText: punctuation', () => {
    assert.equal(morseToText('-.-.--').text, '!');
});

test('morseToText: word separator "/" (with surrounding spaces)', () => {
    assert.equal(morseToText('... --- ... / --- -.-').text, 'SOS OK');
});

test('morseToText: word separator "/" without surrounding spaces is also accepted', () => {
    // Build ground truth with the engine's own (fully spaced) convention...
    const spaced = '... --- ... / --- -.-'; // "SOS OK"
    // ...then verify a compact variant with no spaces touching the "/" parses identically.
    const compact = '... --- .../--- -.-';
    assert.equal(morseToText(compact).text, morseToText(spaced).text);
    assert.equal(morseToText(spaced).text, 'SOS OK');
});

test('morseToText: extra/irregular whitespace between symbols is tolerated', () => {
    assert.equal(morseToText('...   ---   ...').text, 'SOS');
});

test('morseToText: empty string produces empty text', () => {
    const { text, invalidTokens } = morseToText('');
    assert.equal(text, '');
    assert.deepEqual(invalidTokens, []);
});

test('morseToText: unrecognized token becomes "#" and is reported (lenient mode, default)', () => {
    const { text, invalidTokens } = morseToText('... ......... ---');
    assert.equal(text, 'S#O');
    assert.equal(invalidTokens.length, 1);
    assert.equal(invalidTokens[0].token, '.........');
});

test('morseToText: strict mode throws on the first unrecognized token', () => {
    assert.throws(() => morseToText('... .........', { strict: true }), /Unrecognized Morse token/);
});

test('morseToText: round-trips with textToMorse for a full sentence', () => {
    const original = 'THE QUICK BROWN FOX JUMPS OVER 13 LAZY DOGS';
    const { morse } = textToMorse(original);
    const { text } = morseToText(morse);
    assert.equal(text, original);
});

test('morseToText: non-string input throws a TypeError', () => {
    assert.throws(() => morseToText(null), TypeError);
});
