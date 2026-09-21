/**
 * Morse <-> character table for the hidden Morse Receiver, mirrored
 * character-for-character from the server's canonical table
 * (server/src/modules/morse-engine/morseMap.js). This is deliberately a
 * COPY, not a shared import — the client has no build step / module
 * bundler to share code with the server — but it must stay in sync with
 * that file rather than becoming a second, diverging Morse alphabet. If
 * the server table ever changes, update this one to match.
 *
 * Dual-environment export: a plain `window` global in the browser (this
 * app's usual pattern, see morse-audio-player.js), and a CommonJS export
 * when loaded via `require()` from the automated tests under
 * server/src/modules/morse-receiver/__tests__/, so the tests exercise
 * this exact production file rather than a duplicated copy of the table.
 */
(function (root) {
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

    const CHAR_TO_MORSE = { ...LETTERS, ...NUMBERS, ...PUNCTUATION };
    const MORSE_TO_CHAR = Object.fromEntries(Object.entries(CHAR_TO_MORSE).map(([ch, code]) => [code, ch]));

    const api = { CHAR_TO_MORSE, MORSE_TO_CHAR };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.MorseReceiverMap = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
