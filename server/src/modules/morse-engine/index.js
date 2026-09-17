/**
 * Morse Engine — public API.
 *
 * This is the ONLY module the rest of the application should import for
 * anything Morse-related (conversion, timing, validation, or random
 * training-text generation). Internal files (morseMap.js, generator.js,
 * etc.) are implementation details and may change shape; this file's
 * exports are the stable contract.
 *
 * NOTE: this phase deliberately stops at generating Morse *data* and
 * *timing numbers*. It does not play audio — that's a later phase.
 */
const { CHAR_TO_MORSE, MORSE_TO_CHAR, CHARSETS, isSupportedChar } = require('./morseMap');
const { textToMorse } = require('./textToMorse');
const { morseToText } = require('./morseToText');
const { validateText, validateMorse } = require('./validator');
const { computeTiming, computeSequenceDurationMs } = require('./timingService');
const { buildPlaybackPlan, planTotalDurationMs } = require('./playbackPlan');
const { generateRandomText, generateFromDifficulty } = require('./generator');
const { scoreAnswer } = require('./scoring');
const { DIFFICULTY_PRESETS, findDifficultyPreset } = require('./difficultyPresets');
const { MorseEngineError } = require('./errors');

module.exports = {
    // Reference data
    CHAR_TO_MORSE,
    MORSE_TO_CHAR,
    CHARSETS,
    DIFFICULTY_PRESETS,

    // Conversion
    textToMorse,
    morseToText,

    // Validation
    isSupportedChar,
    validateText,
    validateMorse,

    // Timing
    computeTiming,
    computeSequenceDurationMs,
    buildPlaybackPlan,
    planTotalDurationMs,

    // Random generation
    generateRandomText,
    generateFromDifficulty,
    findDifficultyPreset,

    // Scoring
    scoreAnswer,

    // Errors
    MorseEngineError,
};
