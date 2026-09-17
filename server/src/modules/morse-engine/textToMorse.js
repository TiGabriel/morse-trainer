const { CHAR_TO_MORSE, isSupportedChar } = require('./morseMap');
const { MorseEngineError } = require('./errors');

/**
 * Converts plain text to Morse code.
 *
 * Formatting convention used throughout this application:
 *   - Symbols within one character are separated by nothing ("...").
 *   - Characters within a word are separated by a single space (" ").
 *   - Words are separated by " / " (space, slash, space) — the common
 *     written convention for representing Morse word breaks in text form.
 *
 * Unsupported characters are, by default, skipped and reported in
 * `invalidCharacters` (lenient mode) so a caller can decide how to
 * surface them. Pass `{ strict: true }` to throw instead.
 *
 * @param {string} text
 * @param {{ strict?: boolean }} [options]
 * @returns {{ morse: string, invalidCharacters: Array<{char: string, index: number}> }}
 */
function textToMorse(text, options = {}) {
    if (typeof text !== 'string') {
        throw new TypeError('textToMorse expects a string.');
    }
    const { strict = false } = options;

    const invalidCharacters = [];
    // Split on runs of whitespace so multiple spaces still just mean "new word".
    const words = text.trim().length === 0 ? [] : text.trim().split(/\s+/);

    const morseWords = words.map((word) => {
        const symbols = [];
        for (let i = 0; i < word.length; i += 1) {
            const char = word[i];
            const upper = char.toUpperCase();
            if (isSupportedChar(upper)) {
                symbols.push(CHAR_TO_MORSE[upper]);
            } else {
                invalidCharacters.push({ char, index: i });
                if (strict) {
                    throw new MorseEngineError(`Unsupported character "${char}" at position ${i}.`);
                }
                // Lenient mode: silently drop the unsupported character
                // from the output rather than corrupting the Morse stream.
            }
        }
        return symbols.join(' ');
    });

    return { morse: morseWords.filter((w) => w.length > 0).join(' / '), invalidCharacters };
}

module.exports = { textToMorse };
