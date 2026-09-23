const test = require('node:test');
const assert = require('node:assert/strict');
const sessionEngine = require('../sessionEngine');

test('nextStatus: created --open--> waiting', () => {
    assert.equal(sessionEngine.nextStatus('created', 'open'), 'waiting');
});

test('nextStatus: waiting --start--> running', () => {
    assert.equal(sessionEngine.nextStatus('waiting', 'start'), 'running');
});

test('nextStatus: running --pause--> paused, paused --resume--> running', () => {
    assert.equal(sessionEngine.nextStatus('running', 'pause'), 'paused');
    assert.equal(sessionEngine.nextStatus('paused', 'resume'), 'running');
});

test('nextStatus: running/paused --stop--> finished', () => {
    assert.equal(sessionEngine.nextStatus('running', 'stop'), 'finished');
    assert.equal(sessionEngine.nextStatus('paused', 'stop'), 'finished');
});

test('nextStatus: cancel is legal from every non-terminal status', () => {
    for (const status of ['created', 'waiting', 'running', 'paused']) {
        assert.equal(sessionEngine.nextStatus(status, 'cancel'), 'cancelled');
    }
});

test('nextStatus: throws on an illegal transition', () => {
    assert.throws(() => sessionEngine.nextStatus('created', 'start'), sessionEngine.SessionError);
    assert.throws(() => sessionEngine.nextStatus('waiting', 'pause'), sessionEngine.SessionError);
});

test('nextStatus: terminal statuses accept no further actions', () => {
    for (const status of sessionEngine.TERMINAL_STATUSES) {
        assert.deepEqual(sessionEngine.availableActions(status), []);
        assert.throws(() => sessionEngine.nextStatus(status, 'open'));
        assert.throws(() => sessionEngine.nextStatus(status, 'cancel'));
    }
});

test('availableActions: matches what the schema/UI expect per status', () => {
    assert.deepEqual(sessionEngine.availableActions('created').sort(), ['cancel', 'open']);
    assert.deepEqual(sessionEngine.availableActions('waiting').sort(), ['cancel', 'start']);
    assert.deepEqual(sessionEngine.availableActions('running').sort(), ['cancel', 'pause', 'stop']);
    assert.deepEqual(sessionEngine.availableActions('paused').sort(), ['cancel', 'resume', 'stop']);
});

test('generateItems: produces the requested count, each with a distinct expected answer', () => {
    const { items } = sessionEngine.generateItems({
        exerciseMode: 'audio_to_text',
        difficulty: 'easy',
        exerciseCount: 5,
    });
    assert.equal(items.length, 5);
    items.forEach((item, i) => {
        assert.equal(item.orderIndex, i);
        assert.ok(item.exercise.text.length > 0);
        assert.ok(item.exercise.plan.length > 0);
        assert.ok(item.exercise.durationMs > 0);
    });
    const uniqueTexts = new Set(items.map((i) => i.exercise.text));
    assert.equal(uniqueTexts.size, items.length, 'items should not all be identical');
});

test('generateItems: is fully reproducible from the same baseSeed', () => {
    const a = sessionEngine.generateItems({ exerciseMode: 'morse_to_text', difficulty: 'medium', exerciseCount: 3, baseSeed: 'fixed-seed' });
    const b = sessionEngine.generateItems({ exerciseMode: 'morse_to_text', difficulty: 'medium', exerciseCount: 3, baseSeed: 'fixed-seed' });
    assert.deepEqual(
        a.items.map((i) => i.exercise.text),
        b.items.map((i) => i.exercise.text)
    );
});

test('generateItems: rejects a non-positive exerciseCount', () => {
    assert.throws(() => sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 0 }), sessionEngine.SessionError);
});

// ---------------------------------------------------------------------
// Group Session character-pool override (Group Session settings UI reuse
// of Individual Training's pool picker).
// ---------------------------------------------------------------------

test('generateItems: an explicit characters override restricts every item (audio_to_text radiogram) to that pool', () => {
    const { items } = sessionEngine.generateItems({
        exerciseMode: 'audio_to_text',
        difficulty: 'hard', // pool would otherwise be letters+numbers+punctuation
        exerciseCount: 2,
        characters: ['A', 'B', 'C'],
    });
    items.forEach((item) => {
        const usedChars = new Set(item.exercise.text.replace(/\s+/g, '').split(''));
        usedChars.forEach((ch) => assert.ok(['A', 'B', 'C'].includes(ch), `unexpected character "${ch}" outside the selected pool`));
    });
});

test('generateItems: an explicit characters override restricts every item (non-radiogram mode) to that pool', () => {
    const { items } = sessionEngine.generateItems({
        exerciseMode: 'morse_to_text',
        difficulty: 'hard',
        exerciseCount: 2,
        characters: ['X', 'Y', 'Z'],
    });
    items.forEach((item) => {
        const usedChars = new Set(item.exercise.text.replace(/\s+/g, '').split(''));
        usedChars.forEach((ch) => assert.ok(['X', 'Y', 'Z'].includes(ch), `unexpected character "${ch}" outside the selected pool`));
    });
});

test('generateItems: an empty/omitted characters override falls back to the difficulty preset pool unchanged', () => {
    const withEmpty = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, characters: [], baseSeed: 'same' });
    const withoutField = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, baseSeed: 'same' });
    assert.equal(withEmpty.items[0].exercise.text, withoutField.items[0].exercise.text);
});

// ---------------------------------------------------------------------
// Group Session radiograms: same 3x10x4 shape as Individual Training's
// Radiogram Training, plus a VVVV preamble ahead of playback only.
// ---------------------------------------------------------------------

test('generateItems: audio_to_text items are exactly the Individual Training radiogram shape (3 rows x 10 groups x 4 chars = 120)', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'medium', exerciseCount: 2 });

    items.forEach((item) => {
        const { exercise } = item;
        assert.equal(exercise.rowCount, 3);
        assert.equal(exercise.groupsPerRow, 10);
        assert.equal(exercise.groupSize, 4);
        assert.equal(exercise.totalCharacters, 120);
        assert.equal(exercise.rows.length, 3);
        assert.equal(exercise.groups.length, 30);
        exercise.groups.forEach((g) => assert.equal(g.length, 4));

        // The stored/expected/displayed answer is the 120-character
        // radiogram alone — group-spaced, but with no VVVV in it anywhere.
        assert.equal(exercise.expectedAnswer.replace(/\s+/g, '').length, 120);
        assert.equal(exercise.text, exercise.expectedAnswer);
        assert.ok(!exercise.text.toUpperCase().startsWith('VVVV'));
    });
});

test('generateItems: audio_to_text items ignore a length override — a radiogram is always the fixed shape', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, length: 9 });
    assert.equal(items[0].exercise.expectedAnswer.replace(/\s+/g, '').length, 120);
});

test('generateItems: audio_to_text playback plan transmits VVVV (preamble) before the radiogram, and nothing else changes about the radiogram content', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, wpm: 15 });
    const exercise = items[0].exercise;

    // Reconstruct the plan's actual transmitted symbol sequence (tone
    // segments only — gaps carry no letter) and decode it back to
    // characters via the same CHAR_TO_MORSE map the rest of the app uses,
    // to assert on *content*, not on plan-array bookkeeping.
    const engine = require('../../morse-engine');
    const MORSE_TO_CHAR = Object.fromEntries(Object.entries(engine.CHAR_TO_MORSE).map(([ch, m]) => [m, ch]));

    // Split the plan back into per-character runs using inter-char/inter-word gaps as boundaries.
    const chars = [];
    let currentSymbols = '';
    exercise.plan.forEach((seg) => {
        if (seg.type === 'tone') {
            currentSymbols += seg.symbol;
        } else if (seg.type === 'gap' && seg.kind !== 'intra-char') {
            if (currentSymbols) chars.push(MORSE_TO_CHAR[currentSymbols]);
            currentSymbols = '';
        }
    });
    if (currentSymbols) chars.push(MORSE_TO_CHAR[currentSymbols]);

    assert.deepEqual(chars.slice(0, 4), ['V', 'V', 'V', 'V'], 'first four transmitted characters must be V V V V');
    // The very next transmitted character is the radiogram's own first character — not another V, not a gap artifact.
    assert.equal(chars[4], exercise.text.replace(/\s+/g, '')[0]);
    assert.equal(chars.length, 4 + 120, 'exactly 4 preamble + 120 radiogram characters were actually transmitted');

    // The preamble must never leak into what's stored/scored/displayed.
    assert.equal(exercise.expectedAnswer.replace(/\s+/g, '').length, 120);
    assert.ok(!exercise.expectedAnswer.toUpperCase().includes('VVVV'));
});

test('gradeSubmission: group-spacing differences between expected and submitted are never scored as errors (radiogram convention)', () => {
    const exercise = { expectedAnswer: 'ABCD EFGH IJKL' };
    const spacedSame = sessionEngine.gradeSubmission(exercise, 'ABCD EFGH IJKL');
    const noSpaces = sessionEngine.gradeSubmission(exercise, 'ABCDEFGHIJKL');
    const differentSpacing = sessionEngine.gradeSubmission(exercise, 'AB CDEFG HIJKL');
    assert.equal(spacedSame.accuracyPercent, 100);
    assert.equal(noSpaces.accuracyPercent, 100);
    assert.equal(differentSpacing.accuracyPercent, 100);
});

test('gradeSubmission: reuses the engine scoring — perfect match is 100%', () => {
    const exercise = { expectedAnswer: 'PARIS' };
    const score = sessionEngine.gradeSubmission(exercise, 'PARIS');
    assert.equal(score.accuracyPercent, 100);
});

test('computeGrade: null threshold means ungraded (no pass/fail)', () => {
    assert.equal(sessionEngine.computeGrade(95, null), null);
    assert.equal(sessionEngine.computeGrade(95, undefined), null);
});

test('computeGrade: pass/fail against a configured threshold', () => {
    assert.equal(sessionEngine.computeGrade(80, 70), 'pass');
    assert.equal(sessionEngine.computeGrade(60, 70), 'fail');
    assert.equal(sessionEngine.computeGrade(70, 70), 'pass'); // exactly at threshold passes
});

// ---------------------------------------------------------------------
// Formal Test / Group Session integration of Morse Transmission
// ---------------------------------------------------------------------
const path = require('path');
const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { TransmissionEngine } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));
const { CHAR_TO_MORSE } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-map.js'));

/** Perfectly keys `text` at the given WPM and returns the raw element log, JSON-stringified — exactly the shape a real student submission carries as `submittedAnswer` for a 'transmission' item. */
function keyTextPerfectlyAsJson(text, wpm) {
    const engine = new TransmissionEngine({ wpm, toleranceFactor: 0.35 });
    const unitMs = 1200 / wpm;
    [...text].forEach((ch, charIndex) => {
        const morse = CHAR_TO_MORSE[ch.toUpperCase()];
        [...morse].forEach((sym, i) => {
            engine.feedTone(sym === '.' ? unitMs : 3 * unitMs);
            if (i < morse.length - 1) engine.feedGap(unitMs);
        });
        if (charIndex < text.length - 1) engine.feedGap(3 * unitMs);
    });
    engine.flush();
    return JSON.stringify(engine.elementLog);
}

test('generateItems: transmission items expose a visible target (never withheld) built via transmissionEngine, not a second generator', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 2 });
    assert.equal(items.length, 2);
    items.forEach((item) => {
        const { exercise } = item;
        assert.equal(exercise.mode, 'transmission');
        assert.ok(exercise.text.length > 0);
        assert.equal(exercise.text, exercise.expectedAnswer);
        assert.equal(exercise.durationMs, 0, 'no audio playback phase for transmission');
        assert.ok(exercise.wpm > 0);
        assert.equal(exercise.toleranceFactor, sessionEngine.DEFAULT_TRANSMISSION_TOLERANCE_FACTOR);
    });
});

test('generateItems: an explicit toleranceFactor overrides the default for transmission items (teacher-configurable timing tolerance)', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, toleranceFactor: 0.5 });
    assert.equal(items[0].exercise.toleranceFactor, 0.5);
    assert.notEqual(0.5, sessionEngine.DEFAULT_TRANSMISSION_TOLERANCE_FACTOR);
});

test('generateItems: an invalid toleranceFactor (0, negative, non-finite) falls back to the default rather than producing an unusable classifier', () => {
    for (const bad of [0, -0.1, NaN, undefined]) {
        const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, toleranceFactor: bad });
        assert.equal(items[0].exercise.toleranceFactor, sessionEngine.DEFAULT_TRANSMISSION_TOLERANCE_FACTOR);
    }
});

test('generateItems: transmission honors an explicit characters override and item length', () => {
    const { items } = sessionEngine.generateItems({
        exerciseMode: 'transmission',
        difficulty: 'easy',
        exerciseCount: 1,
        characters: ['A', 'B'],
        length: 6,
    });
    const { exercise } = items[0];
    assert.equal(exercise.text.length, 6);
    for (const ch of exercise.text) assert.ok(['A', 'B'].includes(ch));
});

test('gradeSubmission (transmission): a perfectly-keyed target scores 100%', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, characters: ['A', 'B', 'C'], length: 5 });
    const { exercise } = items[0];
    const submittedAnswer = keyTextPerfectlyAsJson(exercise.text, exercise.wpm);

    const score = sessionEngine.gradeSubmission(exercise, submittedAnswer);
    assert.equal(score.accuracyPercent, 100);
    assert.equal(score.decodedText, exercise.text);
    assert.equal(score.timingStats.timingErrorCount, 0);
});

test('gradeSubmission (transmission): categorizes wrong, missing, and extra characters', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, characters: ['A', 'B', 'C', 'D', 'E'], length: 5 });
    const { exercise } = items[0];

    const wrong = sessionEngine.gradeSubmission(exercise, keyTextPerfectlyAsJson('Z'.repeat(exercise.text.length), exercise.wpm));
    assert.equal(wrong.correctCount, 0);
    assert.equal(wrong.incorrectCount, exercise.text.length);

    const missing = sessionEngine.gradeSubmission(exercise, keyTextPerfectlyAsJson(exercise.text.slice(0, -1), exercise.wpm));
    assert.equal(missing.missingCount, 1);
    assert.equal(missing.correctCount, exercise.text.length - 1);

    const extra = sessionEngine.gradeSubmission(exercise, keyTextPerfectlyAsJson(`${exercise.text}Q`, exercise.wpm));
    assert.equal(extra.extraCount, 1);
    assert.equal(extra.correctCount, exercise.text.length);
});

test('gradeSubmission (transmission): timing errors are detected and counted from real mistimed presses', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, characters: ['E'], length: 1 });
    const { exercise } = items[0]; // "E" = a single dot
    const unitMs = 1200 / exercise.wpm;
    const badLog = JSON.stringify([{ type: 'tone', durationMs: unitMs * 0.1 }]); // way too short
    const score = sessionEngine.gradeSubmission(exercise, badLog);
    assert.ok(score.timingStats.timingErrorCount >= 1);
});

test('gradeSubmission (transmission): never trusts a client-reported decoding — re-derives it from the raw element log', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, characters: ['E', 'T'], length: 3 });
    const { exercise } = items[0];
    // Garbage timings that do not spell the target, wrapped exactly like
    // a real submission (raw element log only — there is no field for a
    // client to separately claim its own decoded text at all).
    const garbage = JSON.stringify([{ type: 'tone', durationMs: 1 }]);
    const score = sessionEngine.gradeSubmission(exercise, garbage);
    assert.notEqual(score.decodedText, exercise.text);
});

test('gradeSubmission (transmission): grade calculation flows through computeGrade like every other mode', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'transmission', difficulty: 'easy', exerciseCount: 1, characters: ['S', 'O'], length: 4 });
    const { exercise } = items[0];
    const score = sessionEngine.gradeSubmission(exercise, keyTextPerfectlyAsJson(exercise.text, exercise.wpm));
    assert.equal(sessionEngine.computeGrade(score.accuracyPercent, 70), 'pass');
    assert.equal(sessionEngine.computeGrade(0, 70), 'fail');
});
