/**
 * Builds a full radiogram exercise: a fixed 3-row x 10-group x 4-character
 * block (30 groups / 120 characters total), drawn only from a caller-
 * supplied character pool. This deliberately reuses the same generation,
 * conversion, timing, and playback-plan pipeline as every other exercise
 * in the app (see practiceEngine.js) — a radiogram is just a fixed-shape
 * generateRandomText() call (groupSize=4) fed through the existing engine.
 *
 * Unlike practiceEngine's buildExercise(), a radiogram has no "expected
 * answer" to withhold yet (Part 1 is generate + display + play only), so
 * the full generated text/groups/morse are returned directly.
 */
const engine = require('../morse-engine');
const { MorseEngineError } = require('../morse-engine/errors');

const ROWS = 3;
const GROUPS_PER_ROW = 10;
const GROUP_SIZE = 4;
const TOTAL_GROUPS = ROWS * GROUPS_PER_ROW; // 30
const TOTAL_LENGTH = TOTAL_GROUPS * GROUP_SIZE; // 120

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * @param {object} options
 * @param {string|string[]} options.characters - the exact character pool to draw from (a CHARSETS name, a string, or an array of characters). Required, must resolve to at least one character.
 * @param {number} options.wpm - character speed. Required, > 0.
 * @param {number} [options.farnsworthWpm] - effective/overall speed (defaults to wpm — no Farnsworth stretching).
 * @param {number} [options.toneFrequencyHz=600] - oscillator tone frequency.
 * @param {number|string} [options.seed] - reproducibility seed. Omit for a fresh random one (returned in the result).
 */
function buildRadiogram({ characters, wpm, farnsworthWpm, toneFrequencyHz, seed }) {
    if (!wpm) {
        throw new MorseEngineError('wpm is required.');
    }
    if (!characters || (Array.isArray(characters) && characters.length === 0)) {
        throw new MorseEngineError('characters is required and must be a non-empty character pool.');
    }

    const gen = engine.generateRandomText({ characters, length: TOTAL_LENGTH, groupSize: GROUP_SIZE, seed });
    const groups = gen.text.split(' ');
    const rows = chunk(groups, GROUPS_PER_ROW).map((rowGroups) => rowGroups.join(' '));

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
        rows,
        rowCount: ROWS,
        groupsPerRow: GROUPS_PER_ROW,
        groupSize: GROUP_SIZE,
        totalCharacters: TOTAL_LENGTH,
        morse,
        timing,
        plan,
        durationMs,
    };
}

module.exports = { buildRadiogram, ROWS, GROUPS_PER_ROW, GROUP_SIZE, TOTAL_LENGTH };
