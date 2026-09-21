/**
 * Pure-logic tests for the hidden Morse Receiver's timing/decoding core.
 *
 * These `require()` the ACTUAL production file the browser loads
 * (client/public/js/morse-receiver-core.js) rather than a duplicated
 * copy of the logic — see that file's own header for why it's written
 * to be dual browser-global / CommonJS-requireable. This is the
 * "deterministic audio testing" path the feature spec calls for: raw
 * tone/silence DURATIONS are fed straight into MorseTimingDecoder, with
 * no microphone, no AudioContext, and no fake audio samples involved
 * anywhere. The real production receiver only ever gets its input from
 * actual analyzed microphone audio (see morseReceiverToneDetection.test.js
 * for the separate hysteresis/noise-floor layer that sits between raw
 * signal and these durations).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { MorseTimingDecoder, MorseCharacterDecoder } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-core.js'));
const { CHAR_TO_MORSE } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-map.js'));

const WPM = 20;
const UNIT_MS = 1200 / WPM;

/** Wires a fresh timing decoder + character decoder pair together, exactly like ReceiverState does, and collects every decoded character. */
function makePipeline(overrides = {}) {
    const decodedChars = [];
    const morseSnapshots = [];
    const characterDecoder = new MorseCharacterDecoder({
        onSequenceChange: (buf) => morseSnapshots.push(buf),
        onCharacterDecoded: ({ char }) => decodedChars.push(char),
    });
    const timingDecoder = new MorseTimingDecoder({
        wpm: WPM,
        toleranceFactor: 0.35,
        onSymbol: (s) => characterDecoder.addSymbol(s),
        onCharacterBoundary: () => characterDecoder.finalizeCharacter(),
        onWordBoundary: () => decodedChars.push(' '),
        ...overrides,
    });
    return { timingDecoder, characterDecoder, decodedChars, morseSnapshots };
}

/** Feeds one Morse character's dots/dashes (with 1-unit element gaps between symbols), NOT including the trailing character gap — caller decides how long to wait after. */
function sendSymbols(timingDecoder, morse, unitMs = UNIT_MS) {
    [...morse].forEach((sym, i) => {
        timingDecoder.feedTone(sym === '.' ? unitMs : 3 * unitMs);
        if (i < morse.length - 1) timingDecoder.feedSilence(unitMs);
    });
}

/** Feeds a full plain-text string (letters/digits/spaces), converting via the app's own canonical CHAR_TO_MORSE table, with proper 3-unit character gaps and 7-unit word gaps. */
function sendText(timingDecoder, text, unitMs = UNIT_MS) {
    const words = text.split(' ');
    words.forEach((word, wordIndex) => {
        [...word].forEach((ch, charIndex) => {
            const morse = CHAR_TO_MORSE[ch.toUpperCase()];
            assert.ok(morse, `test setup: "${ch}" has no Morse mapping`);
            sendSymbols(timingDecoder, morse, unitMs);
            const isLastCharOfWord = charIndex === word.length - 1;
            const isLastWord = wordIndex === words.length - 1;
            if (!isLastCharOfWord) {
                timingDecoder.feedSilence(3 * unitMs); // character gap
            } else if (!isLastWord) {
                timingDecoder.feedSilence(7 * unitMs); // word gap
            } else {
                timingDecoder.feedSilence(3 * unitMs); // trailing gap to finalize the very last character
            }
        });
    });
}

// ---------------------------------------------------------------------
// Individual reference characters
// ---------------------------------------------------------------------
const REFERENCE_CHARS = {
    E: '.', T: '-', A: '.-', N: '-.', S: '...', O: '---', R: '.-.', K: '-.-',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
    5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
};

Object.entries(REFERENCE_CHARS).forEach(([char, morse]) => {
    test(`decodes reference character ${char} (${morse})`, () => {
        const { timingDecoder, decodedChars } = makePipeline();
        sendSymbols(timingDecoder, morse);
        timingDecoder.feedSilence(3 * UNIT_MS); // character gap finalizes it
        assert.deepEqual(decodedChars, [char]);
    });
});

// ---------------------------------------------------------------------
// Words / phrases
// ---------------------------------------------------------------------
['SOS', 'CQ', 'HELLO', '12345'].forEach((word) => {
    test(`decodes the word "${word}"`, () => {
        const { timingDecoder, decodedChars } = makePipeline();
        sendText(timingDecoder, word);
        assert.equal(decodedChars.join(''), word);
    });
});

test('decodes "CQ CQ" with a word gap producing a space, not a merged/garbled word', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendText(timingDecoder, 'CQ CQ');
    assert.equal(decodedChars.join(''), 'CQ CQ');
});

test('decodes "TEST 123" (letters, a word gap, then digits)', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendText(timingDecoder, 'TEST 123');
    assert.equal(decodedChars.join(''), 'TEST 123');
});

// ---------------------------------------------------------------------
// Timing element classification
// ---------------------------------------------------------------------
test('dot timing: a tone at ~1 unit classifies as a dot', () => {
    const { timingDecoder, morseSnapshots } = makePipeline();
    timingDecoder.feedTone(1 * UNIT_MS);
    assert.equal(morseSnapshots.at(-1), '.');
});

test('dash timing: a tone at ~3 units classifies as a dash', () => {
    const { timingDecoder, morseSnapshots } = makePipeline();
    timingDecoder.feedTone(3 * UNIT_MS);
    assert.equal(morseSnapshots.at(-1), '-');
});

test('element gap (~1 unit) does not finalize the character', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    timingDecoder.feedTone(1 * UNIT_MS);
    timingDecoder.feedSilence(1 * UNIT_MS);
    timingDecoder.feedTone(1 * UNIT_MS);
    assert.deepEqual(decodedChars, [], 'no character should have been finalized yet');
});

test('character gap (~3 units) finalizes exactly one character', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendSymbols(timingDecoder, '...'); // S
    timingDecoder.feedSilence(3 * UNIT_MS);
    assert.deepEqual(decodedChars, ['S']);
});

test('word gap (~7 units) finalizes the character AND inserts a space', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendSymbols(timingDecoder, '...'); // S
    timingDecoder.feedSilence(7 * UNIT_MS);
    assert.deepEqual(decodedChars, ['S', ' ']);
});

test('reasonable timing variation (+/-15%) around the nominal unit still classifies correctly', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    // Slightly short dot, slightly long dash, slightly long gaps — real
    // hand-sent Morse is never perfectly on-ratio.
    timingDecoder.feedTone(0.85 * UNIT_MS);
    timingDecoder.feedSilence(1.1 * UNIT_MS);
    timingDecoder.feedTone(3.3 * UNIT_MS);
    timingDecoder.feedSilence(3.2 * UNIT_MS); // character gap, slightly long
    assert.deepEqual(decodedChars, ['A']); // .-
});

// ---------------------------------------------------------------------
// Final character / flush
// ---------------------------------------------------------------------
test('the final character is not lost when transmission simply stops (flush)', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendSymbols(timingDecoder, '.-.'); // R, but no trailing gap is ever sent
    assert.deepEqual(decodedChars, [], 'nothing finalized yet — this is the scenario flush() exists for');
    timingDecoder.flush();
    assert.deepEqual(decodedChars, ['R']);
});

// ---------------------------------------------------------------------
// Invalid / unsupported Morse
// ---------------------------------------------------------------------
test('an unrecognized Morse sequence decodes to null rather than crashing', () => {
    const { timingDecoder, decodedChars } = makePipeline();
    sendSymbols(timingDecoder, '.......'); // not a real character in the table
    timingDecoder.feedSilence(3 * UNIT_MS);
    assert.deepEqual(decodedChars, [null]);
});

test('MorseCharacterDecoder never throws on an unsupported sequence', () => {
    const decoder = new MorseCharacterDecoder();
    decoder.addSymbol('.');
    decoder.addSymbol('.');
    decoder.addSymbol('.');
    decoder.addSymbol('.');
    decoder.addSymbol('.');
    decoder.addSymbol('.'); // six dots — not in the table
    assert.doesNotThrow(() => decoder.finalizeCharacter());
});

test('finalizing with an empty buffer is a safe no-op (no phantom characters)', () => {
    const { decodedChars } = makePipeline();
    const decoder = new MorseCharacterDecoder({ onCharacterDecoded: () => decodedChars.push('SHOULD_NOT_HAPPEN') });
    const result = decoder.finalizeCharacter();
    assert.equal(result, null);
    assert.deepEqual(decodedChars, []);
});

// ---------------------------------------------------------------------
// Reset behavior
// ---------------------------------------------------------------------
test('MorseCharacterDecoder.reset() clears a partially-received character without decoding it', () => {
    const { decodedChars } = { decodedChars: [] };
    const decoder = new MorseCharacterDecoder({ onCharacterDecoded: ({ char }) => decodedChars.push(char) });
    decoder.addSymbol('.');
    decoder.addSymbol('-');
    assert.equal(decoder.buffer, '.-');
    decoder.reset();
    assert.equal(decoder.buffer, '');
    decoder.finalizeCharacter();
    assert.deepEqual(decodedChars, [], 'reset must discard the pending buffer, not decode it');
});

test('a new session does not inherit stale timing state after reset', () => {
    const { timingDecoder, characterDecoder, decodedChars } = makePipeline();
    sendSymbols(timingDecoder, '.-'); // A, mid-character
    characterDecoder.reset();
    // Now send a clean "T" (-) from scratch — it must decode as just "T",
    // not get contaminated by the discarded ".-" fragment.
    timingDecoder.feedTone(3 * UNIT_MS);
    timingDecoder.feedSilence(3 * UNIT_MS);
    assert.deepEqual(decodedChars, ['T']);
});

// ---------------------------------------------------------------------
// WPM changes timing interpretation
// ---------------------------------------------------------------------
test('setWpm() changes what duration counts as a dot vs a dash', () => {
    const { timingDecoder, characterDecoder, morseSnapshots } = makePipeline();
    timingDecoder.setWpm(10); // unit = 120ms
    timingDecoder.feedTone(120); // exactly 1 unit at 10 WPM
    assert.equal(morseSnapshots.at(-1), '.');

    characterDecoder.reset(); // isolate the second check from the first symbol's leftover buffer
    timingDecoder.setWpm(40); // unit = 30ms; that same 120ms tone is now ~4 units -> a dash
    timingDecoder.feedTone(120);
    assert.equal(morseSnapshots.at(-1), '-');
});

test('an invalid WPM (0, negative, non-finite) is rejected and the previous timing keeps working', () => {
    const { timingDecoder, morseSnapshots } = makePipeline();
    timingDecoder.setWpm(0);
    timingDecoder.setWpm(-5);
    timingDecoder.setWpm(NaN);
    timingDecoder.feedTone(1 * UNIT_MS); // still using the original 20 WPM unit
    assert.equal(morseSnapshots.at(-1), '.');
});
