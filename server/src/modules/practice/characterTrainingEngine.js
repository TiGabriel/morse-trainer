/**
 * Builds a Character Training session: a flat sequence of single-character
 * Morse "rounds" drawn only from a caller-supplied character pool. Each
 * round gets its own ready-to-schedule playback plan, computed with the
 * same engine pipeline used everywhere else (generateRandomText ->
 * textToMorse -> computeTiming -> buildPlaybackPlan) — a training round is
 * just a length-1 Morse item, not a second Morse system.
 *
 * Unlike a radiogram, gameplay reveals the correct character immediately
 * after each keypress (see Part 2 of the Individual Training redesign),
 * so there is nothing to withhold: the full session (every character,
 * its Morse, and its plan) is returned in one response and stepped
 * through client-side.
 */
const engine = require('../morse-engine');
const { MorseEngineError } = require('../morse-engine/errors');

const MIN_LENGTH = 1;
const MAX_LENGTH = 500;

/**
 * @param {object} options
 * @param {string|string[]} options.characters - the exact character pool to draw from. Required, must resolve to at least one character.
 * @param {number} options.length - number of rounds (characters) in the session. Required, 1-500.
 * @param {number} options.wpm - character speed. Required, > 0.
 * @param {number} [options.farnsworthWpm] - effective/overall speed (defaults to wpm).
 * @param {number} [options.toneFrequencyHz=600] - oscillator tone frequency.
 * @param {number|string} [options.seed] - reproducibility seed. Omit for a fresh random one (returned in the result).
 */
function buildCharacterTrainingSession({ characters, length, wpm, farnsworthWpm, toneFrequencyHz, seed }) {
    if (!wpm) {
        throw new MorseEngineError('wpm is required.');
    }
    if (!characters || (Array.isArray(characters) && characters.length === 0)) {
        throw new MorseEngineError('characters is required and must be a non-empty character pool.');
    }
    if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
        throw new MorseEngineError(`length must be an integer between ${MIN_LENGTH} and ${MAX_LENGTH}.`);
    }

    const gen = engine.generateRandomText({ characters, length, groupSize: null, seed });
    const resolvedToneFrequencyHz = toneFrequencyHz || 600;
    const timing = engine.computeTiming({ wpm, farnsworthWpm, toneFrequencyHz: resolvedToneFrequencyHz });

    const items = gen.text.split('').map((char) => {
        const { morse } = engine.textToMorse(char);
        const plan = engine.buildPlaybackPlan(morse, timing);
        const durationMs = engine.planTotalDurationMs(plan);
        return { char, morse, plan, durationMs };
    });

    return {
        seed: gen.seed,
        characters: gen.characters,
        length,
        timing,
        items,
    };
}

module.exports = { buildCharacterTrainingSession, MIN_LENGTH, MAX_LENGTH };
