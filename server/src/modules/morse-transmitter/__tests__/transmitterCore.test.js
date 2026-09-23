/**
 * Pure-logic tests for the Morse Transmitter's timing/decoding/feedback
 * core (Phase: Morse Transmission). Same "require the actual production
 * file the browser loads" approach as
 * server/src/modules/morse-receiver/__tests__/morseReceiverDecoding.test.js
 * — client/public/js/morse-transmitter-core.js is exercised directly,
 * with raw key-press/gap DURATIONS fed straight in. No DOM, no
 * keyboard events, no timers: deterministic millisecond values only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { TransmissionEngine, analyzeElementLog, classifyAgainstIdeal } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));
const { CHAR_TO_MORSE } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-map.js'));

const WPM = 20;
const UNIT_MS = 1200 / WPM; // 60ms at 20 WPM

function makeEngine(overrides = {}) {
    const feedback = [];
    const decoded = [];
    const engine = new TransmissionEngine({
        wpm: WPM,
        toleranceFactor: 0.35,
        onFeedback: (f) => feedback.push(f),
        onCharacterDecoded: (c) => decoded.push(c),
        ...overrides,
    });
    return { engine, feedback, decoded };
}

/** Feeds one character's dots/dashes with 1-unit element gaps between symbols (no trailing gap — caller decides). */
function sendChar(engine, morse) {
    [...morse].forEach((sym, i) => {
        engine.feedTone(sym === '.' ? UNIT_MS : 3 * UNIT_MS);
        if (i < morse.length - 1) engine.feedGap(UNIT_MS);
    });
}

/** Feeds a full plain-text string via the app's own canonical CHAR_TO_MORSE table, with proper 3-unit character gaps and 7-unit word gaps. */
function sendText(engine, text) {
    const words = text.split(' ');
    words.forEach((word, wordIndex) => {
        [...word].forEach((ch, charIndex) => {
            const morse = CHAR_TO_MORSE[ch.toUpperCase()];
            assert.ok(morse, `test setup: "${ch}" has no Morse mapping`);
            sendChar(engine, morse);
            if (charIndex < word.length - 1) engine.feedGap(3 * UNIT_MS);
        });
        if (wordIndex < words.length - 1) engine.feedGap(7 * UNIT_MS);
    });
    engine.flush();
}

// ---------------------------------------------------------------------
// 1. Space key as Morse manipulator: short/long press classification
// ---------------------------------------------------------------------

test('short Space press classifies as a dot', () => {
    const { engine, feedback } = makeEngine();
    engine.feedTone(UNIT_MS);
    assert.equal(engine.dotDurations.length, 1);
    assert.equal(engine.dashDurations.length, 0);
    assert.equal(feedback[0].kind, 'dot');
    assert.equal(feedback[0].verdict, 'correct');
    assert.equal(feedback[0].message, 'Correct');
});

test('long Space press classifies as a dash', () => {
    const { engine, feedback } = makeEngine();
    engine.feedTone(3 * UNIT_MS);
    assert.equal(engine.dashDurations.length, 1);
    assert.equal(engine.dotDurations.length, 0);
    assert.equal(feedback[0].kind, 'dash');
    assert.equal(feedback[0].verdict, 'correct');
});

test('classification thresholds are configurable via toleranceFactor', () => {
    // A press at 1.5x the ideal dot length: rejected as "too long" under a
    // tight tolerance, accepted as "correct" under a looser one — same
    // duration, different verdict, purely from the configured threshold.
    const tight = makeEngine({ toleranceFactor: 0.1 });
    tight.engine.feedTone(UNIT_MS * 1.5);
    assert.equal(tight.feedback[0].verdict, 'too-long');

    const loose = makeEngine({ toleranceFactor: 0.6 });
    loose.engine.feedTone(UNIT_MS * 1.5);
    assert.equal(loose.feedback[0].verdict, 'correct');
});

test('classifyAgainstIdeal is exported and symmetric around the ideal', () => {
    assert.equal(classifyAgainstIdeal(1.0, 1, 0.35), 'correct');
    assert.equal(classifyAgainstIdeal(0.5, 1, 0.35), 'too-short');
    assert.equal(classifyAgainstIdeal(1.5, 1, 0.35), 'too-long');
});

// ---------------------------------------------------------------------
// 4. Real-time technical feedback
// ---------------------------------------------------------------------

test('feedback: dot too short / too long', () => {
    const { engine, feedback } = makeEngine();
    engine.feedTone(UNIT_MS * 0.3); // way under 1 unit
    assert.equal(feedback[0].message, 'Dot too short');
    engine.feedTone(UNIT_MS * 1.9); // still under the dot/dash boundary (2 units) but over-long for a dot
    assert.equal(feedback[1].message, 'Dot too long');
});

test('feedback: dash too short / too long', () => {
    // A tight toleranceFactor (0.15) is used here so that the "too-short"
    // dash band (down to 3*(1-0.15)=2.55 units) sits ABOVE the dot/dash
    // classification boundary (2*(1+0.15)=2.3 units) — with the default
    // 0.35 tolerance those two would overlap in a way that makes a
    // too-short dash unreachable (anything long enough to be classified
    // a dash at all would already be a long-enough dash).
    const { engine, feedback } = makeEngine({ toleranceFactor: 0.15 });
    engine.feedTone(UNIT_MS * 2.4); // past the 2.3-unit dot/dash boundary -> dash, but short of the 2.55-unit "correct" floor
    assert.equal(feedback[0].kind, 'dash');
    assert.equal(feedback[0].message, 'Dash too short');
    engine.feedTone(UNIT_MS * 5); // way over 3 units
    assert.equal(feedback[1].message, 'Dash too long');
});

test('feedback: character gap too short / correct / too long', () => {
    // Same tight-tolerance reasoning as the dash test above, applied to
    // the element/character gap boundary vs. the character gap's own
    // "too-short" floor.
    const { engine, feedback } = makeEngine({ toleranceFactor: 0.15 });
    engine.feedTone(UNIT_MS); // a dot, to have something pending
    feedback.length = 0;

    engine.feedGap(UNIT_MS * 2.4); // past the 2.3-unit element/character boundary, short of the 2.55-unit "correct" floor
    assert.equal(feedback[0].kind, 'character');
    assert.equal(feedback[0].message, 'Character gap too short');

    engine.feedTone(UNIT_MS);
    feedback.length = 0;
    engine.feedGap(3 * UNIT_MS); // exactly the ideal 3-unit character gap
    assert.equal(feedback[0].message, 'Correct');

    engine.feedTone(UNIT_MS);
    feedback.length = 0;
    engine.feedGap(4 * UNIT_MS); // long, but still under the character/word boundary (5*1.15=5.75 units)
    assert.equal(feedback[0].message, 'Character gap too long');
});

test('feedback: group/word gap too short / correct / too long', () => {
    const { engine, feedback } = makeEngine({ toleranceFactor: 0.15 });
    engine.feedTone(UNIT_MS);
    feedback.length = 0;

    engine.feedGap(7 * UNIT_MS); // exactly the ideal 7-unit word gap
    assert.equal(feedback[0].kind, 'word');
    assert.equal(feedback[0].message, 'Correct');
    assert.equal(engine.decodedText.endsWith(' '), true, 'a word gap must append a space to the decoded text');

    engine.feedTone(UNIT_MS);
    feedback.length = 0;
    engine.feedGap(5.85 * UNIT_MS); // past the 5.75-unit character/word boundary, short of the 5.95-unit "correct" floor
    assert.equal(feedback[0].message, 'Group/word gap too short');

    engine.feedTone(UNIT_MS);
    feedback.length = 0;
    engine.feedGap(12 * UNIT_MS); // way over 7 units
    assert.equal(feedback[0].message, 'Group/word gap too long');
});

test('feedback: an intra-character element gap does not emit its own message (only tracked for stats)', () => {
    const { engine, feedback } = makeEngine();
    engine.feedTone(UNIT_MS);
    feedback.length = 0;
    engine.feedGap(UNIT_MS); // ideal 1-unit element gap — still inside the same character
    assert.equal(feedback.length, 0);
    assert.equal(engine.elementGapDurations.length, 1);
});

test('feedback: irregular rhythm is flagged when recent element timing is inconsistent', () => {
    const { engine, feedback } = makeEngine();
    // Alternately short and long dots — wildly inconsistent relative to
    // the unit length (coefficient of variation ~0.39, well over the
    // 0.3 default threshold), but each individually still inside the
    // dot/dash boundary so this is purely a rhythm problem, not a
    // decoding one.
    [0.7, 1.6, 0.7, 1.6, 0.7, 1.6].forEach((ratio) => engine.feedTone(UNIT_MS * ratio));
    assert.ok(feedback.some((f) => f.message === 'Irregular rhythm'), 'expected at least one Irregular rhythm flag from inconsistent timing');
});

test('feedback: steady, consistent timing never triggers Irregular rhythm', () => {
    const { engine, feedback } = makeEngine();
    for (let i = 0; i < 10; i += 1) engine.feedTone(UNIT_MS);
    assert.ok(!feedback.some((f) => f.message === 'Irregular rhythm'));
});

// ---------------------------------------------------------------------
// 2. Real-time decoding — dots/dashes -> character, appended sequentially
// ---------------------------------------------------------------------

test('decodes a single character from its symbol sequence (example: . - . . -> L)', () => {
    const { engine } = makeEngine();
    sendChar(engine, '.-..'); // L
    engine.flush();
    assert.equal(engine.decodedText, 'L');
});

test('decodes multiple characters in sequence, separated by character gaps', () => {
    const { engine } = makeEngine();
    sendText(engine, 'SOS');
    assert.equal(engine.decodedText, 'SOS');
});

test('decodes a complete multi-character target sequence with group/word gaps preserved', () => {
    const { engine } = makeEngine();
    sendText(engine, 'RKM 7A');
    assert.equal(engine.decodedText, 'RKM 7A');
});

test('an unrecognized symbol sequence decodes to "?" rather than crashing or being silently dropped', () => {
    const { engine } = makeEngine();
    sendChar(engine, '.......'); // not a valid Morse character
    engine.flush();
    assert.equal(engine.decodedText, '?');
});

// ---------------------------------------------------------------------
// 3. Timing analysis / 7. Transmission results (stats)
// ---------------------------------------------------------------------

test('getStats: perfect transmission reports zero timing errors and full rhythm consistency', () => {
    const { engine } = makeEngine();
    sendText(engine, 'SOS');
    const stats = engine.getStats();
    assert.equal(stats.timingErrorCount, 0);
    assert.equal(stats.rhythmConsistencyPercent, 100);
    assert.equal(stats.targetWpm, WPM);
    assert.ok(stats.actualWpm > 0);
    assert.ok(Math.abs(stats.actualWpm - WPM) < 1, 'actual WPM should closely match the target WPM for perfectly-timed input');
});

test('getStats: records average dot/dash/gap durations and total duration', () => {
    const { engine } = makeEngine();
    sendText(engine, 'AB'); // A = .- , B = -...
    const stats = engine.getStats();
    assert.ok(stats.avgDotMs > 0);
    assert.ok(stats.avgDashMs > 0);
    assert.ok(stats.avgCharacterGapMs > 0);
    assert.ok(stats.totalDurationMs > 0);
    assert.equal(stats.dotCount + stats.dashCount, engine.dotDurations.length + engine.dashDurations.length);
});

test('getStats: counts timing errors when dots/dashes are mistimed', () => {
    const { engine } = makeEngine();
    engine.feedTone(UNIT_MS * 0.2); // dot too short
    engine.feedGap(UNIT_MS);
    engine.feedTone(UNIT_MS * 10); // dash way too long
    engine.flush();
    const stats = engine.getStats();
    assert.ok(stats.timingErrorCount >= 2);
    assert.ok(stats.feedbackCounts['Dot too short'] >= 1);
    assert.ok(stats.feedbackCounts['Dash too long'] >= 1);
});

// ---------------------------------------------------------------------
// analyzeElementLog — the server's authoritative re-derivation path
// ---------------------------------------------------------------------

test('analyzeElementLog: replays a raw element log and reproduces the same decoded text (this is what the server uses to never trust a client-reported decoding)', () => {
    const { engine } = makeEngine();
    sendText(engine, 'RKM 7A');
    const { decodedText, stats } = analyzeElementLog(engine.elementLog, { wpm: WPM, toleranceFactor: 0.35 });
    assert.equal(decodedText, 'RKM 7A');
    assert.equal(stats.timingErrorCount, 0);
});

test('analyzeElementLog: a tampered/incorrect element log decodes to whatever it actually represents, not whatever the client might separately claim', () => {
    // Simulates a client trying to submit garbage timings but claim a
    // perfect decodedText separately — the server only ever trusts the
    // raw log, so it must re-derive the true (wrong) decoding.
    const log = [
        { type: 'tone', durationMs: UNIT_MS }, // dot
        { type: 'gap', durationMs: 3 * UNIT_MS }, // character gap (only one dot -> "E")
    ];
    const { decodedText } = analyzeElementLog(log, { wpm: WPM });
    assert.equal(decodedText, 'E');
});

// ---------------------------------------------------------------------
// keyDown/keyUp wall-clock convenience wrapper
// ---------------------------------------------------------------------

test('keyDown/keyUp: derives the same tone/gap durations as feedTone/feedGap from raw timestamps', () => {
    const { engine } = makeEngine();
    let t = 1000;
    engine.keyDown(t); // press starts
    t += UNIT_MS;
    engine.keyUp(t); // dot
    t += 3 * UNIT_MS;
    engine.keyDown(t); // gap was 3 units (character gap), then press
    t += 3 * UNIT_MS;
    engine.keyUp(t); // dash
    engine.flush();

    assert.equal(engine.dotDurations.length, 1);
    assert.equal(engine.dashDurations.length, 1);
    assert.equal(Math.round(engine.dotDurations[0]), Math.round(UNIT_MS));
    assert.equal(Math.round(engine.dashDurations[0]), Math.round(3 * UNIT_MS));
});

test('keyDown: ignores key-repeat (a second keyDown before keyUp)', () => {
    const { engine } = makeEngine();
    engine.keyDown(1000);
    engine.keyDown(1010); // OS key-repeat while still held — must not be treated as a release+press
    engine.keyUp(1000 + UNIT_MS);
    assert.equal(engine.dotDurations.length, 1);
});

test('reset(): clears all accumulated state', () => {
    const { engine } = makeEngine();
    sendText(engine, 'SOS');
    engine.reset();
    assert.equal(engine.decodedText, '');
    assert.equal(engine.dotDurations.length, 0);
    assert.equal(engine.dashDurations.length, 0);
    assert.equal(engine.elementLog.length, 0);
    assert.deepEqual(engine.getStats().feedbackCounts, {});
});
