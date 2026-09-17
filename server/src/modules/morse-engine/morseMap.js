/**
 * The single, canonical text <-> Morse mapping for the whole application.
 * Every other module (text->Morse, Morse->text, validation, generation)
 * reads from this table — nothing elsewhere in the codebase should ever
 * hardcode a dot/dash pattern.
 *
 * Source: International Morse Code (ITU-R M.1677-1). Letters and digits
 * are the internationally standardized patterns; punctuation is the
 * common ITU set plus a couple of widely-used extras (e.g. "!") that
 * most training software includes even though they're not in the
 * original ITU table.
 */

const LETTERS = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
    G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
    M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
    S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
    Y: '-.--', Z: '--..',
};

const NUMBERS = {
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
    5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
};

const PUNCTUATION = {
    '.': '.-.-.-',
    ',': '--..--',
    '?': '..--..',
    "'": '.----.',
    '!': '-.-.--',
    '/': '-..-.',
    '(': '-.--.',
    ')': '-.--.-',
    '&': '.-...',
    ':': '---...',
    ';': '-.-.-.',
    '=': '-...-',
    '+': '.-.-.',
    '-': '-....-',
    _: '..--.-',
    '"': '.-..-.',
    $: '...-..-',
    '@': '.--.-.',
};

/** The complete character -> Morse map (uppercase keys only). */
const CHAR_TO_MORSE = { ...LETTERS, ...NUMBERS, ...PUNCTUATION };

/** The reverse map: Morse pattern -> character. */
const MORSE_TO_CHAR = Object.fromEntries(Object.entries(CHAR_TO_MORSE).map(([ch, code]) => [code, ch]));

/**
 * Named character sets, usable directly or referenced by name from a
 * difficulty preset / API caller. Each is an array of single characters.
 */
const CHARSETS = {
    letters: Object.keys(LETTERS),
    numbers: Object.keys(NUMBERS),
    punctuation: Object.keys(PUNCTUATION),
    alphanumeric: [...Object.keys(LETTERS), ...Object.keys(NUMBERS)],
    all: [...Object.keys(LETTERS), ...Object.keys(NUMBERS), ...Object.keys(PUNCTUATION)],
};

function isSupportedChar(char) {
    if (typeof char !== 'string' || char.length !== 1) return false;
    return Object.prototype.hasOwnProperty.call(CHAR_TO_MORSE, char.toUpperCase());
}

module.exports = { CHAR_TO_MORSE, MORSE_TO_CHAR, CHARSETS, isSupportedChar };
