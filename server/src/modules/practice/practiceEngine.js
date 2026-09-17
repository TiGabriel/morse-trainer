/**
 * Builds a training exercise for one of the four individual-practice
 * modes, entirely by composing the (already tested) Morse engine — no
 * Morse mapping, timing, or generation logic is duplicated here.
 *
 * Determinism is the key design idea: given the same {mode, seed,
 * difficulty, wpm, length, characters}, this always produces the exact
 * same exercise. That means the server never has to persist a "pending
 * exercise" row — it hands the client a seed at generation time, the
 * client echoes it back at submission time, and the server regenerates
 * the identical exercise to compute the canonical expected answer. The
 * Phase 5 engine's seeded reproducibility is what makes this possible.
 */
const engine = require('../morse-engine');
const { MorseEngineError } = require('../morse-engine/errors');

const VALID_MODES = ['audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition'];

function buildExercise({ mode, difficulty, length, characters, wpm, farnsworthWpm, toneFrequencyHz, seed }) {
    if (!VALID_MODES.includes(mode)) {
        throw new MorseEngineError(`mode must be one of: ${VALID_MODES.join(', ')}`);
    }

    // Character recognition is always a single-character drill,
    // regardless of what length was requested.
    const effectiveLength = mode === 'character_recognition' ? 1 : length;

    let generated;
    if (difficulty) {
        const overrides = { seed };
        if (effectiveLength) overrides.length = effectiveLength;
        if (wpm) overrides.wpm = wpm;
        if (farnsworthWpm) overrides.farnsworthWpm = farnsworthWpm;
        if (characters) overrides.characters = characters;
        generated = engine.generateFromDifficulty(difficulty, overrides);
    } else {
        if (!wpm) {
            throw new MorseEngineError('wpm is required when no difficulty preset is given.');
        }
        if (!characters) {
            throw new MorseEngineError('characters is required when no difficulty preset is given.');
        }
        const gen = engine.generateRandomText({ characters, length: effectiveLength || 10, seed });
        generated = { text: gen.text, wpm, farnsworthWpm, length: gen.length, seed: gen.seed, difficulty: null };
    }

    const text = generated.text;
    const resolvedWpm = generated.wpm ?? wpm;
    const resolvedFarnsworthWpm = generated.farnsworthWpm ?? farnsworthWpm;
    const resolvedToneFrequencyHz = toneFrequencyHz || 600;

    const { morse } = engine.textToMorse(text);
    const timing = engine.computeTiming({ wpm: resolvedWpm, farnsworthWpm: resolvedFarnsworthWpm, toneFrequencyHz: resolvedToneFrequencyHz });
    const plan = engine.buildPlaybackPlan(morse, timing);
    const durationMs = engine.planTotalDurationMs(plan);

    // What the student is actually being asked to produce, per mode:
    //   audio_to_text / character_recognition / morse_to_text -> plain text
    //   text_to_morse                                          -> Morse code
    const expectedAnswer = mode === 'text_to_morse' ? morse : text;

    return {
        mode,
        seed: generated.seed,
        difficulty: difficulty || null,
        wpm: resolvedWpm,
        farnsworthWpm: resolvedFarnsworthWpm,
        toneFrequencyHz: resolvedToneFrequencyHz,
        length: generated.length ?? effectiveLength,
        text,
        morse,
        timing,
        plan,
        durationMs,
        expectedAnswer,
    };
}

module.exports = { buildExercise, VALID_MODES };
