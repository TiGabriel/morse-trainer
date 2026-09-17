const test = require('node:test');
const assert = require('node:assert/strict');
const { validateText, validateMorse } = require('../validator');
const { isSupportedChar } = require('../morseMap');

test('isSupportedChar: recognizes letters, numbers, punctuation', () => {
    assert.equal(isSupportedChar('A'), true);
    assert.equal(isSupportedChar('a'), true); // case-insensitive
    assert.equal(isSupportedChar('5'), true);
    assert.equal(isSupportedChar('!'), true);
});

test('isSupportedChar: rejects unsupported characters', () => {
    assert.equal(isSupportedChar('#'), false);
    assert.equal(isSupportedChar('€'), false);
    assert.equal(isSupportedChar('ñ'), false);
});

test('validateText: valid text reports valid=true with no invalid characters', () => {
    const result = validateText('Hello World 123!');
    assert.equal(result.valid, true);
    assert.deepEqual(result.invalidCharacters, []);
});

test('validateText: whitespace is never reported as invalid', () => {
    const result = validateText('A   B\tC\nD');
    assert.equal(result.valid, true);
});

test('validateText: reports every invalid character with its index', () => {
    const result = validateText('A#B€C');
    assert.equal(result.valid, false);
    assert.equal(result.invalidCharacters.length, 2);
    assert.equal(result.invalidCharacters[0].char, '#');
    assert.equal(result.invalidCharacters[0].index, 1);
    assert.equal(result.invalidCharacters[1].char, '€');
    assert.equal(result.invalidCharacters[1].index, 3);
});

test('validateMorse: accepts dots, dashes, spaces, and slashes', () => {
    const result = validateMorse('... --- ... / --- -.-');
    assert.equal(result.valid, true);
});

test('validateMorse: rejects any other character', () => {
    const result = validateMorse('... x ---');
    assert.equal(result.valid, false);
    assert.equal(result.invalidPositions[0].char, 'x');
});
