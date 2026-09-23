/**
 * Builds a Morse Transmission target: a configurable-size sequence of
 * characters the student must key in themselves (Space bar -> dots/
 * dashes), grouped into student-chosen group size/count or one
 * continuous run — the exact same generation shape as receptionEngine.js
 * (which this deliberately mirrors), reusing engine.generateRandomText
 * rather than a third copy of that logic.
 *
 * Unlike Reception, the target text is meant to be VISIBLE to the
 * student the whole time (see practiceController.generateTransmissionExercise
 * — nothing is withheld): the exercise here is "reproduce this text in
 * Morse", not blind copy, so there's no audio/playback-plan generation
 * at all, only the target text itself.
 */
const engine = require('../morse-engine');
const { MorseEngineError } = require('../morse-engine/errors');

const MIN_GROUP_SIZE = 1;
const MAX_GROUP_SIZE = 10;
const MIN_GROUP_COUNT = 1;
const MAX_GROUP_COUNT = 60;

/**
 * @param {object} options
 * @param {string|string[]} options.characters - the exact character pool to draw from. Required, must resolve to at least one character.
 * @param {number} [options.groupSize=1] - characters per group. 1-10. Set 0/null for one continuous ungrouped run.
 * @param {number} options.groupCount - number of groups (or, when groupSize is 0/null, the total character count). Required, 1-60.
 * @param {number|string} [options.seed] - reproducibility seed. Omit for a fresh random one (returned in the result).
 */
function buildTransmissionTarget({ characters, groupSize = 1, groupCount, seed }) {
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
    const { morse } = engine.textToMorse(gen.text);

    return {
        seed: gen.seed,
        characters: gen.characters,
        text: gen.text,
        groups,
        groupSize: effectiveGroupSize,
        groupCount,
        totalCharacters: totalLength,
        morse,
    };
}

module.exports = { buildTransmissionTarget, MIN_GROUP_SIZE, MAX_GROUP_SIZE, MIN_GROUP_COUNT, MAX_GROUP_COUNT };
