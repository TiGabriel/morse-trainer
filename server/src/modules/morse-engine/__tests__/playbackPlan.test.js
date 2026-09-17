const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlaybackPlan, planTotalDurationMs } = require('../playbackPlan');
const { computeTiming, computeSequenceDurationMs } = require('../timingService');
const { textToMorse } = require('../textToMorse');
const { MorseEngineError } = require('../errors');

test('buildPlaybackPlan: SOS at 20 WPM produces the expected segment sequence', () => {
    const timing = computeTiming({ wpm: 20 }); // dotMs=60, dashMs=180, gaps 60/180/420
    const plan = buildPlaybackPlan('... --- ...', timing);

    const expected = [
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'inter-char', durationMs: 180 },
        { type: 'tone', symbol: '-', durationMs: 180 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '-', durationMs: 180 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '-', durationMs: 180 },
        { type: 'gap', kind: 'inter-char', durationMs: 180 },
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '.', durationMs: 60 },
    ];

    assert.deepEqual(plan, expected);
});

test('buildPlaybackPlan: includes an inter-word gap segment between words, none trailing', () => {
    const timing = computeTiming({ wpm: 20 });
    const { morse } = textToMorse('HI THERE');
    const plan = buildPlaybackPlan(morse, timing);

    const wordGaps = plan.filter((seg) => seg.kind === 'inter-word');
    assert.equal(wordGaps.length, 1);
    assert.equal(wordGaps[0].durationMs, timing.interWordGapMs);

    // Plan never starts or ends with a gap segment.
    assert.equal(plan[0].type, 'tone');
    assert.equal(plan[plan.length - 1].type, 'tone');
});

test('buildPlaybackPlan: total duration always matches computeSequenceDurationMs for the same input', () => {
    const timing = computeTiming({ wpm: 15, farnsworthWpm: 8 });
    const { morse } = textToMorse('THE QUICK BROWN FOX 42');
    const plan = buildPlaybackPlan(morse, timing);

    assert.equal(planTotalDurationMs(plan), computeSequenceDurationMs(morse, timing));
});

test('buildPlaybackPlan: empty Morse string produces an empty plan', () => {
    const timing = computeTiming({ wpm: 20 });
    assert.deepEqual(buildPlaybackPlan('', timing), []);
    assert.deepEqual(buildPlaybackPlan('   ', timing), []);
});

test('buildPlaybackPlan: requires a timing profile from computeTiming()', () => {
    assert.throws(() => buildPlaybackPlan('...', null), MorseEngineError);
    assert.throws(() => buildPlaybackPlan('...', {}), MorseEngineError);
});

test('buildPlaybackPlan: rejects non-string Morse input', () => {
    assert.throws(() => buildPlaybackPlan(123, computeTiming({ wpm: 20 })), TypeError);
});

test('planTotalDurationMs: sums every segment', () => {
    const plan = [
        { type: 'tone', symbol: '.', durationMs: 60 },
        { type: 'gap', kind: 'intra-char', durationMs: 60 },
        { type: 'tone', symbol: '-', durationMs: 180 },
    ];
    assert.equal(planTotalDurationMs(plan), 300);
});
