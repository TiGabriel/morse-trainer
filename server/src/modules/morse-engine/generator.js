const { CHARSETS } = require('./morseMap');
const { MorseEngineError } = require('./errors');
const { createRng } = require('./rng');
const { findDifficultyPreset } = require('./difficultyPresets');

/** Resolves a "characters" input (a CHARSETS name, an array, or a string) to a deduplicated array of uppercase single characters. */
function resolveCharacterPool(characters) {
    let pool;
    if (typeof characters === 'string' && Object.prototype.hasOwnProperty.call(CHARSETS, characters)) {
        pool = CHARSETS[characters];
    } else if (typeof characters === 'string') {
        pool = characters.split('');
    } else if (Array.isArray(characters)) {
        pool = characters;
    } else {
        throw new MorseEngineError('characters must be a CHARSETS name, a string of characters, or an array of characters.');
    }

    const unique = [...new Set(pool.map((c) => String(c).toUpperCase()).filter((c) => c.length === 1))];
    if (unique.length === 0) {
        throw new MorseEngineError('No usable characters were resolved from the given character pool.');
    }
    return unique;
}

/** Picks an integer within an inclusive [min, max] range using the given RNG. */
function pickIntInRange(rngNext, [min, max]) {
    if (min === max) return min;
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return lo + Math.floor(rngNext() * (hi - lo + 1));
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * Generates a random training string from an explicit character pool.
 *
 * @param {object} options
 * @param {string|string[]} options.characters - a CHARSETS name (e.g. "letters"), a literal string of characters, or an array of characters.
 * @param {number} [options.length=20] - number of characters to generate (excluding group-separating spaces).
 * @param {number|null} [options.groupSize=null] - if set, output is chunked into space-separated groups of this size (classic Morse practice format). If null/0, output is one continuous string.
 * @param {number|string} [options.seed] - reproducibility seed. Omit for a fresh random seed (returned in the result so it can be reused later).
 * @returns {{ text: string, characters: string[], length: number, groupSize: number|null, seed: number }}
 */
function generateRandomText({ characters, length = 20, groupSize = null, seed } = {}) {
    if (!Number.isInteger(length) || length <= 0) {
        throw new MorseEngineError('length must be a positive integer.');
    }
    if (groupSize !== null && groupSize !== undefined && (!Number.isInteger(groupSize) || groupSize <= 0)) {
        throw new MorseEngineError('groupSize must be a positive integer or null.');
    }

    const pool = resolveCharacterPool(characters);
    const rng = createRng(seed);

    const chars = [];
    for (let i = 0; i < length; i += 1) {
        chars.push(pool[Math.floor(rng.next() * pool.length)]);
    }

    const text = groupSize ? chunk(chars, groupSize).map((g) => g.join('')).join(' ') : chars.join('');

    return { text, characters: pool, length, groupSize: groupSize || null, seed: rng.seed };
}

/**
 * Generates a random training string AND resolves WPM/length from a
 * named difficulty preset (see difficultyPresets.js). All randomness
 * (character selection, and picking concrete wpm/length values from
 * their ranges) is driven from the single seed, so the entire result —
 * text, wpm, and length — is reproducible together.
 *
 * @param {string} difficultyId - one of DIFFICULTY_PRESETS' ids (e.g. "easy").
 * @param {object} [overrides] - override any resolved field: characters, length, groupSize, wpm, farnsworthWpm, seed.
 * @returns {{ text: string, wpm: number, farnsworthWpm: number|undefined, length: number, groupSize: number|null, difficulty: string, seed: number }}
 */
function generateFromDifficulty(difficultyId, overrides = {}) {
    const preset = findDifficultyPreset(difficultyId);
    if (!preset) {
        throw new MorseEngineError(`Unknown difficulty preset "${difficultyId}".`);
    }

    const rng = createRng(overrides.seed);

    // IMPORTANT: draw all three values from the RNG UNCONDITIONALLY, in a
    // fixed order, then apply overrides afterward — never skip a draw
    // just because an override was supplied. If a draw were skipped
    // whenever a field is overridden, the RNG cursor position ahead of
    // it (and therefore everything drawn after, including the character
    // sequence's sub-seed) would depend on *which* fields happened to be
    // overridden on a given call. That would silently break
    // reproducibility for a very real use case: a caller that generates
    // an exercise with only `wpm` overridden, then re-generates the same
    // exercise later with `wpm` AND `length` overridden (e.g. echoing
    // back a previously-resolved length) — those two calls must produce
    // the identical result for the same seed, regardless of which
    // fields were explicitly passed either time.
    const drawnLength = pickIntInRange(rng.next, preset.lengthRange);
    const drawnWpm = pickIntInRange(rng.next, preset.wpmRange);
    const drawnFarnsworthWpm = preset.farnsworthWpmRange ? pickIntInRange(rng.next, preset.farnsworthWpmRange) : undefined;

    const length = overrides.length ?? drawnLength;
    const wpm = overrides.wpm ?? drawnWpm;
    const farnsworthWpm = overrides.farnsworthWpm ?? drawnFarnsworthWpm;
    const groupSize = overrides.groupSize !== undefined ? overrides.groupSize : preset.groupSize;
    const characters = overrides.characters ?? preset.characters;

    // Derive a decorrelated sub-seed for character selection from the
    // same base seed (fixed odd constant mix), so the whole result is
    // still 100% reproducible from one seed, without the character
    // sequence merely replaying the same draws used for wpm/length.
    const charSeed = (rng.seed ^ 0x9e3779b9) >>> 0;
    const charResult = generateRandomText({ characters, length, groupSize, seed: charSeed });

    return {
        text: charResult.text,
        wpm,
        farnsworthWpm,
        length,
        groupSize: groupSize || null,
        difficulty: difficultyId,
        seed: rng.seed,
    };
}

module.exports = { generateRandomText, generateFromDifficulty, resolveCharacterPool };
