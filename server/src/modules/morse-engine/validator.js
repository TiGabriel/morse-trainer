const { isSupportedChar } = require('./morseMap');

/**
 * Checks a plain-text string against the supported character set.
 * Whitespace is always allowed (it becomes word spacing) and is never
 * reported as invalid.
 *
 * @param {string} text
 * @returns {{ valid: boolean, invalidCharacters: Array<{char: string, index: number}> }}
 */
function validateText(text) {
    if (typeof text !== 'string') {
        throw new TypeError('validateText expects a string.');
    }

    const invalidCharacters = [];
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (/\s/.test(char)) continue; // whitespace always OK — becomes word spacing
        if (!isSupportedChar(char)) {
            invalidCharacters.push({ char, index: i });
        }
    }

    return { valid: invalidCharacters.length === 0, invalidCharacters };
}

/**
 * Checks that a Morse string only uses valid symbols: '.', '-', single
 * spaces (intra-word character separator), and '/' (word separator,
 * optionally surrounded by spaces).
 */
function validateMorse(morse) {
    if (typeof morse !== 'string') {
        throw new TypeError('validateMorse expects a string.');
    }
    const invalidPositions = [];
    for (let i = 0; i < morse.length; i += 1) {
        const ch = morse[i];
        if (ch === '.' || ch === '-' || ch === ' ' || ch === '/') continue;
        invalidPositions.push({ char: ch, index: i });
    }
    return { valid: invalidPositions.length === 0, invalidPositions };
}

module.exports = { validateText, validateMorse };
