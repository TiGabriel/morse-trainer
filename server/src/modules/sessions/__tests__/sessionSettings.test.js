const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../morse-engine');
const sessionEngine = require('../sessionEngine');
const { normalizeAnswer, formatIntoGroups } = require('../../practice/answerFormat');

test('computeTiming: standard PARIS timing — 18 WPM is a 66.7 ms dot, 7-dot group gap', () => {
    const timing = engine.computeTiming({ wpm: 18 });
    assert.ok(Math.abs(timing.dotMs - 1200 / 18) < 1e-9);
    assert.ok(Math.abs(timing.interWordGapMs - 7 * (1200 / 18)) < 1e-9);
    assert.equal(timing.groupPauseMs, null);
});

test('computeTiming: groupPauseMs replaces only the gap between groups', () => {
    const base = engine.computeTiming({ wpm: 12 });
    const timing = engine.computeTiming({ wpm: 12, groupPauseMs: 1500 });
    assert.equal(timing.interWordGapMs, 1500);
    assert.equal(timing.groupPauseMs, 1500);
    assert.equal(timing.dotMs, base.dotMs);
    assert.equal(timing.interCharGapMs, base.interCharGapMs);
});

test('computeTiming: groupPauseMs never shorter than the gap between characters', () => {
    const timing = engine.computeTiming({ wpm: 5, groupPauseMs: 10 });
    assert.equal(timing.interWordGapMs, timing.interCharGapMs);
});

test('computeTiming: rejects a non-positive groupPauseMs', () => {
    assert.throws(() => engine.computeTiming({ wpm: 10, groupPauseMs: 0 }));
    assert.throws(() => engine.computeTiming({ wpm: 10, groupPauseMs: -5 }));
});

test('answerFormat: strips spaces, uppercases, caps length, re-spaces every group', () => {
    assert.equal(normalizeAnswer('ab cd  efgh ij', 8), 'ABCDEFGH');
    assert.equal(formatIntoGroups('ABCDEFGHIJ', 4), 'ABCD EFGH IJ');
    assert.equal(formatIntoGroups('ABCDEFGH', 0), 'ABCDEFGH');
    assert.equal(normalizeAnswer('abc', 0), 'ABC');
});

test('generateItems: no difficulty needed — radiogram uses the teacher WPM exactly, never a random draw', () => {
    const { items } = sessionEngine.generateItems({ baseSeed: 'x', exerciseMode: 'audio_to_text', wpm: 8, exerciseCount: 3 });
    items.forEach(({ exercise }) => {
        assert.equal(exercise.wpm, 8);
        assert.equal(exercise.totalCharacters, 120);
        assert.equal(exercise.groupSize, 4);
    });
});

test('generateItems: blank WPM falls back to the fixed default, blank pool to letters', () => {
    const { items } = sessionEngine.generateItems({ baseSeed: 'y', exerciseMode: 'audio_to_text', exerciseCount: 1 });
    const ex = items[0].exercise;
    assert.equal(ex.wpm, sessionEngine.DEFAULT_SESSION_WPM);
    assert.match(ex.expectedAnswer.replace(/\s+/g, ''), /^[A-Z]{120}$/);
});

test('generateItems: group pause lengthens every gap between radiogram groups in the played plan', () => {
    const { items } = sessionEngine.generateItems({ baseSeed: 'z', exerciseMode: 'audio_to_text', wpm: 10, groupPauseMs: 2000, exerciseCount: 1 });
    const wordGaps = items[0].exercise.plan.filter((seg) => seg.type === 'gap' && seg.kind === 'inter-word');
    assert.equal(wordGaps.length, 30); // VVVV -> first group, then 29 between the 30 groups
    wordGaps.forEach((g) => assert.equal(g.durationMs, 2000));
});

test('generateItems: Morse -> Text honours item length and group size', () => {
    const { items } = sessionEngine.generateItems({
        baseSeed: 'm',
        exerciseMode: 'morse_to_text',
        wpm: 10,
        length: 12,
        groupSize: 4,
        characters: ['A', 'B', 'C'],
        exerciseCount: 1,
    });
    assert.match(items[0].exercise.expectedAnswer, /^[ABC]{4} [ABC]{4} [ABC]{4}$/);
});

test('normalizeSubmission: radiogram answer is capped at 120 and grouped every 4 characters', () => {
    const { items } = sessionEngine.generateItems({ baseSeed: 'n', exerciseMode: 'audio_to_text', wpm: 10, exerciseCount: 1 });
    const ex = items[0].exercise;
    const reference = ex.expectedAnswer.replace(/\s+/g, '');
    const typed = (reference + 'EXTRA').toLowerCase(); // no spaces, too long
    const normalized = sessionEngine.normalizeSubmission(ex, typed);
    assert.equal(normalized, ex.expectedAnswer);
    assert.equal(sessionEngine.gradeSubmission(ex, normalized).accuracyPercent, 100);
    assert.equal(sessionEngine.answerCharacterLimit(ex), 120);
});

test('normalizeSubmission: Text -> Morse and Transmission answers are left untouched', () => {
    const tm = sessionEngine.generateItems({ baseSeed: 't', exerciseMode: 'text_to_morse', wpm: 10, exerciseCount: 1 }).items[0].exercise;
    assert.equal(sessionEngine.normalizeSubmission(tm, '.- -...'), '.- -...');
    assert.equal(sessionEngine.answerCharacterLimit(tm), null);
});
