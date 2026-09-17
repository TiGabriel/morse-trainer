const { MorseEngineError } = require('./errors');
const { parseMorseWords } = require('./morseParse');

/**
 * Converts a Morse string + a timing profile (from computeTiming) into a
 * flat, ordered list of segments describing exactly what to play and for
 * how long. This is pure data — no audio APIs involved — so it can be
 * computed once on the server (or anywhere) and handed to any playback
 * engine (this phase's browser Web Audio player, or something else
 * entirely later) to schedule ahead of time rather than deciding what to
 * play moment-to-moment.
 *
 * Segment shape:
 *   { type: 'tone', symbol: '.'|'-', durationMs: number }
 *   { type: 'gap', kind: 'intra-char'|'inter-char'|'inter-word', durationMs: number }
 *
 * Summing every segment's durationMs reproduces exactly what
 * computeSequenceDurationMs(morse, timing) returns (both are built on
 * the same parseMorseWords helper, so they can never disagree).
 *
 * @param {string} morse
 * @param {ReturnType<typeof import('./timingService').computeTiming>} timing
 * @returns {Array<{type: 'tone', symbol: string, durationMs: number} | {type: 'gap', kind: string, durationMs: number}>}
 */
function buildPlaybackPlan(morse, timing) {
    if (typeof morse !== 'string') {
        throw new TypeError('buildPlaybackPlan expects a Morse string.');
    }
    if (!timing || typeof timing.dotMs !== 'number') {
        throw new MorseEngineError('buildPlaybackPlan requires a timing profile from computeTiming().');
    }

    const words = parseMorseWords(morse);
    const plan = [];

    words.forEach((chars, wordIndex) => {
        chars.forEach((char, charIndex) => {
            for (let i = 0; i < char.length; i += 1) {
                const symbol = char[i];
                const durationMs = symbol === '.' ? timing.dotMs : symbol === '-' ? timing.dashMs : 0;
                if (durationMs > 0) {
                    plan.push({ type: 'tone', symbol, durationMs });
                }
                if (i < char.length - 1) {
                    plan.push({ type: 'gap', kind: 'intra-char', durationMs: timing.intraCharGapMs });
                }
            }
            if (charIndex < chars.length - 1) {
                plan.push({ type: 'gap', kind: 'inter-char', durationMs: timing.interCharGapMs });
            }
        });

        if (wordIndex < words.length - 1) {
            plan.push({ type: 'gap', kind: 'inter-word', durationMs: timing.interWordGapMs });
        }
    });

    return plan;
}

/** Sums a plan's segment durations — should always equal computeSequenceDurationMs for the same input. */
function planTotalDurationMs(plan) {
    return plan.reduce((sum, seg) => sum + seg.durationMs, 0);
}

module.exports = { buildPlaybackPlan, planTotalDurationMs };
