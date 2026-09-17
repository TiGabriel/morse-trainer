const { MorseEngineError } = require('./errors');
const { parseMorseWords } = require('./morseParse');

/**
 * ===========================================================================
 * MORSE TIMING MODEL — documented reference
 * ===========================================================================
 *
 * Speed is measured in WPM (words per minute) using the standard
 * "PARIS" reference word. "PARIS " (including one trailing word space)
 * takes exactly 50 "dot units" to send at constant speed:
 *
 *   P .--.   P=1+1+3+1+3+1+1 = wait, computed unit-by-unit below.
 *
 * Rather than re-derive letter-by-letter, the standard, universally used
 * result is simply: at N words per minute, one dot ("unit") lasts
 *
 *   dotMs = 1200 / N
 *
 * (equivalently: 60000 ms/min / (N words/min * 50 units/word) = 1200/N).
 * All other durations are small integer multiples of that one unit, per
 * the international Morse timing standard:
 *
 *   dot (dit)                       = 1 unit
 *   dash (dah)                      = 3 units
 *   gap between symbols in a char   = 1 unit   (intra-character gap)
 *   gap between characters in a word= 3 units  (inter-character gap)
 *   gap between words               = 7 units  (inter-word gap)
 *
 * ---------------------------------------------------------------------------
 * FARNSWORTH TIMING
 * ---------------------------------------------------------------------------
 * Farnsworth timing keeps individual dots/dashes sounding "fast and
 * crisp" (sent at the normal character speed) while stretching only the
 * *spacing* between characters and words, so the overall receiving speed
 * is slower. This is the standard technique for teaching beginners to
 * recognize character *sound shapes* at full speed without being
 * overwhelmed by high overall throughput.
 *
 * Given:
 *   Wc = character speed (WPM)         — dot/dash length is fixed by this
 *   Wf = Farnsworth/effective speed (WPM), Wf <= Wc — the *overall* speed
 *
 * The standard derivation (using the 50-unit PARIS word, of which 31
 * units are "content" — the dots, dashes, and gaps *within* a character —
 * and the remaining 19 units are inter-character/inter-word spacing:
 * 4 inter-character gaps of 3 units = 12, plus 1 inter-word gap of
 * 7 units = 7; 12 + 7 = 19):
 *
 *   Tc              = 1200 / Wc                  (content unit length, ms)
 *   totalWordMs      = 60000 / Wf                 (target total time for one word at Wf)
 *   contentMs        = 31 * Tc                    (time spent on the 31 "fixed" content units)
 *   spacingUnitMs     = (totalWordMs - contentMs) / 19
 *
 * Then:
 *   interCharGapMs = 3 * spacingUnitMs
 *   interWordGapMs = 7 * spacingUnitMs
 *
 * intraCharGapMs and dot/dash length are NOT affected by Farnsworth —
 * they always use Tc (the character speed), which is the entire point.
 *
 * If Wf >= Wc, Farnsworth has no effect (spacing is just the standard
 * 3/7-unit spacing at character speed) — there's nothing to stretch.
 * spacingUnitMs is clamped to never go *below* Tc (which would happen if
 * Wf were requested higher than Wc after all, or via a degenerate input);
 * standard spacing is the floor, since Farnsworth only ever slows things
 * down, never speeds them up.
 * ===========================================================================
 */

const CONTENT_UNITS = 31;
const SPACING_UNITS = 19; // 4 * 3 (inter-char) + 1 * 7 (inter-word)
const STANDARD_INTER_CHAR_UNITS = 3;
const STANDARD_INTER_WORD_UNITS = 7;

/**
 * Computes every timing value needed to render or schedule Morse audio.
 *
 * @param {object} options
 * @param {number} options.wpm - character speed, in words per minute. Required, > 0.
 * @param {number} [options.farnsworthWpm] - effective/overall speed. Defaults to `wpm` (no Farnsworth stretching).
 * @param {number} [options.toneFrequencyHz=600] - tone metadata only; the timing engine does not generate audio.
 * @returns {{
 *   wpm: number,
 *   farnsworthWpm: number,
 *   toneFrequencyHz: number,
 *   dotMs: number,
 *   dashMs: number,
 *   intraCharGapMs: number,
 *   interCharGapMs: number,
 *   interWordGapMs: number,
 * }}
 */
function computeTiming({ wpm, farnsworthWpm, toneFrequencyHz = 600 } = {}) {
    if (typeof wpm !== 'number' || !Number.isFinite(wpm) || wpm <= 0) {
        throw new MorseEngineError('wpm must be a positive number.');
    }
    if (farnsworthWpm !== undefined && (typeof farnsworthWpm !== 'number' || !Number.isFinite(farnsworthWpm) || farnsworthWpm <= 0)) {
        throw new MorseEngineError('farnsworthWpm must be a positive number when provided.');
    }
    if (typeof toneFrequencyHz !== 'number' || !Number.isFinite(toneFrequencyHz) || toneFrequencyHz <= 0) {
        throw new MorseEngineError('toneFrequencyHz must be a positive number.');
    }

    const dotMs = 1200 / wpm;
    const dashMs = 3 * dotMs;
    const intraCharGapMs = dotMs;

    const effectiveFarnsworthWpm = farnsworthWpm === undefined ? wpm : farnsworthWpm;

    let interCharGapMs = STANDARD_INTER_CHAR_UNITS * dotMs;
    let interWordGapMs = STANDARD_INTER_WORD_UNITS * dotMs;

    if (effectiveFarnsworthWpm < wpm) {
        const totalWordMs = 60000 / effectiveFarnsworthWpm;
        const contentMs = CONTENT_UNITS * dotMs;
        let spacingUnitMs = (totalWordMs - contentMs) / SPACING_UNITS;

        // Farnsworth only ever slows spacing down, never speeds it up —
        // if the math ever works out below the standard unit (e.g. a
        // Farnsworth speed requested too close to/above character
        // speed), fall back to standard spacing rather than producing
        // gaps shorter than normal.
        if (spacingUnitMs < dotMs) {
            spacingUnitMs = dotMs;
        }

        interCharGapMs = STANDARD_INTER_CHAR_UNITS * spacingUnitMs;
        interWordGapMs = STANDARD_INTER_WORD_UNITS * spacingUnitMs;
    }

    return {
        wpm,
        farnsworthWpm: effectiveFarnsworthWpm,
        toneFrequencyHz,
        dotMs,
        dashMs,
        intraCharGapMs,
        interCharGapMs,
        interWordGapMs,
    };
}

/**
 * Computes the total time (ms) it would take to send a Morse string
 * (in the "." "-" space "/" convention used throughout this module)
 * given a timing profile from computeTiming(). Does not play any audio
 * — this is pure arithmetic, useful for progress bars, session-length
 * estimates, and (in a later phase) playback scheduling.
 *
 * @param {string} morse
 * @param {ReturnType<typeof computeTiming>} timing
 * @returns {number} total duration in milliseconds
 */
function computeSequenceDurationMs(morse, timing) {
    if (typeof morse !== 'string') {
        throw new TypeError('computeSequenceDurationMs expects a Morse string.');
    }
    if (!timing || typeof timing.dotMs !== 'number') {
        throw new MorseEngineError('computeSequenceDurationMs requires a timing profile from computeTiming().');
    }

    const words = parseMorseWords(morse);
    if (words.length === 0) return 0;

    let totalMs = 0;

    words.forEach((chars, wordIndex) => {
        chars.forEach((char, charIndex) => {
            for (let i = 0; i < char.length; i += 1) {
                const symbol = char[i];
                if (symbol === '.') totalMs += timing.dotMs;
                else if (symbol === '-') totalMs += timing.dashMs;
                // Gap after every symbol except the last one in the character.
                if (i < char.length - 1) totalMs += timing.intraCharGapMs;
            }
            // Gap after every character except the last one in the word.
            if (charIndex < chars.length - 1) totalMs += timing.interCharGapMs;
        });

        // Gap after every word except the last one in the sequence.
        if (wordIndex < words.length - 1) totalMs += timing.interWordGapMs;
    });

    return totalMs;
}

module.exports = { computeTiming, computeSequenceDurationMs };
