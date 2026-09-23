/**
 * Builds a Reception (Audio -> Text) exercise: a configurable-size block
 * of Morse — grouped into student-chosen group size/count, or one
 * continuous run when groupSize is 0/null — drawn from a caller-supplied
 * character pool. Reuses the exact same generation/conversion/timing/
 * playback-plan pipeline as every other exercise in the app (see
 * radiogramEngine.js/characterTrainingEngine.js) — this is not a second
 * Morse system, just a differently-shaped generateRandomText() call.
 *
 * Unlike radiogramEngine (which reveals the transmitted text live, as a
 * copy-along aid), Reception is a blind-copy assessment: the caller-
 * facing generation step withholds `text`/`groups`/`morse` entirely (see
 * practiceController.generateReceptionExercise) so nothing about the
 * answer leaks before the student submits — only buildReceptionExercise
 * itself (called again server-side from the echoed seed, at submission
 * time) ever has the real text.
 */
const engine = require('../morse-engine');
const { MorseEngineError } = require('../morse-engine/errors');

const MIN_GROUP_SIZE = 1;
const MAX_GROUP_SIZE = 10;
const MIN_GROUP_COUNT = 1;
const MAX_GROUP_COUNT = 60; // groupSize(10) * groupCount(60) = 600 chars, well under scoreAnswer's 2000-char guard

/**
 * @param {object} options
 * @param {string|string[]} options.characters - the exact character pool to draw from (a CHARSETS name, a string, or an array). Required, must resolve to at least one character.
 * @param {number} [options.groupSize=5] - characters per group (classic 5-letter grouping). 1-10. Set 0/null for one continuous ungrouped run.
 * @param {number} options.groupCount - number of groups (or, when groupSize is 0/null, the total character count). Required, 1-60.
 * @param {number} options.wpm - character speed. Required, > 0.
 * @param {number} [options.farnsworthWpm] - effective/overall speed (defaults to wpm).
 * @param {number} [options.toneFrequencyHz=600] - oscillator tone frequency.
 * @param {number|string} [options.seed] - reproducibility seed. Omit for a fresh random one (returned in the result).
 */
function buildReceptionExercise({ characters, groupSize = 5, groupCount, wpm, farnsworthWpm, toneFrequencyHz, seed }) {
    if (!wpm) {
        throw new MorseEngineError('wpm is required.');
    }
    if (!characters || (Array.isArray(characters) && characters.length === 0)) {
        throw new MorseEngineError('characters is required and must be a non-empty character pool.');
    }
    const resolvedGroupSize = groupSize === undefined || groupSize === null ? 0 : Number(groupSize);
    if (!Number.isInteger(resolvedGroupSize) || resolvedGroupSize < 0 || resolvedGroupSize > MAX_GROUP_SIZE) {
        throw new MorseEngineError(`groupSize must be an integer between 0 (ungrouped) and ${MAX_GROUP_SIZE}.`);
    }
    if (!Number.isInteger(groupCount) || groupCount < MIN_GROUP_COUNT || groupCount > MAX_GROUP_COUNT) {
        throw new MorseEngineError(`groupCount must be an integer between ${MIN_GROUP_COUNT} and ${MAX_GROUP_COUNT}.`);
    }

    const effectiveGroupSize = resolvedGroupSize >= MIN_GROUP_SIZE ? resolvedGroupSize : null;
    const totalLength = effectiveGroupSize ? effectiveGroupSize * groupCount : groupCount;

    const gen = engine.generateRandomText({ characters, length: totalLength, groupSize: effectiveGroupSize, seed });
    const groups = effectiveGroupSize ? gen.text.split(' ') : [gen.text];

    const resolvedToneFrequencyHz = toneFrequencyHz || 600;
    const { morse } = engine.textToMorse(gen.text);
    const timing = engine.computeTiming({ wpm, farnsworthWpm, toneFrequencyHz: resolvedToneFrequencyHz });
    const plan = engine.buildPlaybackPlan(morse, timing);
    const durationMs = engine.planTotalDurationMs(plan);

    return {
        seed: gen.seed,
        characters: gen.characters,
        text: gen.text,
        groups,
        groupSize: effectiveGroupSize,
        groupCount,
        totalCharacters: totalLength,
        morse,
        timing,
        plan,
        durationMs,
    };
}

module.exports = { buildReceptionExercise, MIN_GROUP_SIZE, MAX_GROUP_SIZE, MIN_GROUP_COUNT, MAX_GROUP_COUNT };
