const { MORSE_TO_CHAR } = require('./morseMap');
const { MorseEngineError } = require('./errors');

/**
 * Converts Morse code back to plain text. Accepts the same convention
 * produced by textToMorse: characters separated by single spaces, words
 * separated by "/" (with or without surrounding spaces — both "A / B"
 * and "A/B" are accepted for leniency when parsing hand-typed Morse).
 *
 * Unrecognized Morse tokens are, by default, replaced with "#" and
 * reported in `invalidTokens` (lenient mode). Pass `{ strict: true }` to
 * throw instead.
 *
 * @param {string} morse
 * @param {{ strict?: boolean }} [options]
 * @returns {{ text: string, invalidTokens: Array<{ token: string, wordIndex: number, charIndex: number }> }}
 */
function morseToText(morse, options = {}) {
    if (typeof morse !== 'string') {
        throw new TypeError('morseToText expects a string.');
    }
    const { strict = false } = options;

    const trimmed = morse.trim();
    if (trimmed.length === 0) {
        return { text: '', invalidTokens: [] };
    }

    // Normalize "/" word separators (with or without surrounding spaces)
    // to a single canonical delimiter before splitting into words.
    const normalized = trimmed.replace(/\s*\/\s*/g, ' / ');
    const words = normalized.split(' / ').map((w) => w.trim()).filter((w) => w.length > 0);

    const invalidTokens = [];
    const textWords = words.map((word, wordIndex) => {
        const tokens = word.split(/\s+/).filter((t) => t.length > 0);
        const chars = tokens.map((token, charIndex) => {
            const char = MORSE_TO_CHAR[token];
            if (char !== undefined) return char;

            invalidTokens.push({ token, wordIndex, charIndex });
            if (strict) {
                throw new MorseEngineError(`Unrecognized Morse token "${token}".`);
            }
            return '#';
        });
        return chars.join('');
    });

    return { text: textWords.join(' '), invalidTokens };
}

module.exports = { morseToText };
