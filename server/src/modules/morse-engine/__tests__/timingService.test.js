const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTiming, computeSequenceDurationMs } = require('../timingService');
const { textToMorse } = require('../textToMorse');

test('computeTiming: standard PARIS formula at 20 WPM', () => {
    const t = computeTiming({ wpm: 20 });
    assert.equal(t.dotMs, 60); // 1200 / 20
    assert.equal(t.dashMs, 180); // 3x dot
    assert.equal(t.intraCharGapMs, 60); // 1x dot
    assert.equal(t.interCharGapMs, 180); // 3x dot, no Farnsworth
    assert.equal(t.interWordGapMs, 420); // 7x dot, no Farnsworth
    assert.equal(t.farnsworthWpm, 20); // defaults to wpm when omitted
});

test('computeTiming: dot length halves when WPM doubles', () => {
    const slow = computeTiming({ wpm: 10 });
    const fast = computeTiming({ wpm: 20 });
    assert.equal(slow.dotMs, fast.dotMs * 2);
});

test('computeTiming: tone frequency metadata is passed through, defaulting to 600 Hz', () => {
    assert.equal(computeTiming({ wpm: 20 }).toneFrequencyHz, 600);
    assert.equal(computeTiming({ wpm: 20, toneFrequencyHz: 700 }).toneFrequencyHz, 700);
});

test('computeTiming: Farnsworth stretches inter-character/inter-word gaps but NOT dot/dash length', () => {
    const standard = computeTiming({ wpm: 20 });
    const farnsworth = computeTiming({ wpm: 20, farnsworthWpm: 10 });

    // Character speed (dot/dash/intra-char gap) is unaffected by Farnsworth.
    assert.equal(farnsworth.dotMs, standard.dotMs);
    assert.equal(farnsworth.dashMs, standard.dashMs);
    assert.equal(farnsworth.intraCharGapMs, standard.intraCharGapMs);

    // Spacing is stretched (Farnsworth is slower overall => bigger gaps).
    assert.ok(farnsworth.interCharGapMs > standard.interCharGapMs);
    assert.ok(farnsworth.interWordGapMs > standard.interWordGapMs);
});

test('computeTiming: Farnsworth spacing matches the documented 31/19-unit PARIS derivation', () => {
    // wpm=20 (char speed), farnsworthWpm=10 (effective speed)
    const t = computeTiming({ wpm: 20, farnsworthWpm: 10 });
    const dotMs = 1200 / 20; // 60
    const totalWordMs = 60000 / 10; // 6000
    const contentMs = 31 * dotMs; // 1860
    const spacingUnitMs = (totalWordMs - contentMs) / 19; // 217.894736...
    assert.ok(Math.abs(t.interCharGapMs - 3 * spacingUnitMs) < 1e-9);
    assert.ok(Math.abs(t.interWordGapMs - 7 * spacingUnitMs) < 1e-9);
});

test('computeTiming: a full PARIS word takes exactly 60000/farnsworthWpm ms end-to-end', () => {
    // Sanity check the whole model against the 50-unit-per-word definition
    // of WPM, including the trailing inter-word gap.
    const wpm = 20;
    const farnsworthWpm = 12;
    const t = computeTiming({ wpm, farnsworthWpm });
    const { morse } = textToMorse('PARIS');
    // Add one trailing inter-word gap manually, since computeSequenceDurationMs
    // never charges a gap after the very last word.
    const durationMs = computeSequenceDurationMs(morse, t) + t.interWordGapMs;
    const expectedMs = 60000 / farnsworthWpm;
    assert.ok(Math.abs(durationMs - expectedMs) < 1e-6);
});

test('computeTiming: farnsworthWpm >= wpm has no effect (falls back to standard spacing)', () => {
    const standard = computeTiming({ wpm: 15 });
    const noOp = computeTiming({ wpm: 15, farnsworthWpm: 15 });
    const higher = computeTiming({ wpm: 15, farnsworthWpm: 25 });
    assert.equal(noOp.interCharGapMs, standard.interCharGapMs);
    assert.equal(noOp.interWordGapMs, standard.interWordGapMs);
    assert.equal(higher.interCharGapMs, standard.interCharGapMs);
    assert.equal(higher.interWordGapMs, standard.interWordGapMs);
});

test('computeTiming: rejects invalid wpm', () => {
    assert.throws(() => computeTiming({ wpm: 0 }));
    assert.throws(() => computeTiming({ wpm: -5 }));
    assert.throws(() => computeTiming({}));
});

test('computeTiming: rejects invalid farnsworthWpm / toneFrequencyHz', () => {
    assert.throws(() => computeTiming({ wpm: 20, farnsworthWpm: -1 }));
    assert.throws(() => computeTiming({ wpm: 20, toneFrequencyHz: 0 }));
});

test('computeSequenceDurationMs: SOS at 20 WPM matches hand-calculated duration', () => {
    const t = computeTiming({ wpm: 20 }); // dotMs=60
    // S=... O=--- S=...
    // S: 3 dots + 2 intra gaps = 3*60 + 2*60 = 300
    // O: 3 dashes + 2 intra gaps = 3*180 + 2*60 = 660
    // S: 300
    // + 2 inter-char gaps (180 each) = 360
    const expected = 300 + 660 + 300 + 2 * 180;
    assert.equal(computeSequenceDurationMs('... --- ...', t), expected);
});

test('computeSequenceDurationMs: empty string is zero duration', () => {
    const t = computeTiming({ wpm: 20 });
    assert.equal(computeSequenceDurationMs('', t), 0);
    assert.equal(computeSequenceDurationMs('   ', t), 0);
});

test('computeSequenceDurationMs: multi-word sequence includes inter-word gaps between words only', () => {
    const t = computeTiming({ wpm: 20 });
    const oneWord = computeSequenceDurationMs('... --- ...', t);
    const twoWords = computeSequenceDurationMs('... --- ... / ...', t);
    // Second sequence = first word + one inter-word gap + "S" (3 dots + 2 gaps)
    const expectedExtra = t.interWordGapMs + (3 * t.dotMs + 2 * t.intraCharGapMs);
    assert.ok(Math.abs(twoWords - oneWord - expectedExtra) < 1e-9);
});

test('computeSequenceDurationMs: requires a timing profile from computeTiming()', () => {
    assert.throws(() => computeSequenceDurationMs('...', null));
    assert.throws(() => computeSequenceDurationMs('...', {}));
});
