const engine = require('./index');

const DEFAULT_TONE_FREQUENCY_HZ = 600;

function parsePositiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * POST /api/morse/preview — teacher-only.
 * Body: { text, wpm, farnsworthWpm?, toneFrequencyHz? }
 *
 * Converts arbitrary text to Morse and returns everything a client-side
 * audio player needs to play it: the Morse string, the resolved timing
 * profile, a ready-to-schedule playback plan (see playbackPlan.js), and
 * the total duration. No audio is generated server-side — this is pure
 * data prepared ahead of playback, per this phase's design.
 */
function preview(req, res) {
    const { text, farnsworthWpm } = req.body || {};
    const wpm = parsePositiveNumber(req.body?.wpm, 15);
    const toneFrequencyHz = parsePositiveNumber(req.body?.toneFrequencyHz, DEFAULT_TONE_FREQUENCY_HZ);

    if (typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ error: 'text is required.' });
    }
    if (text.length > 500) {
        return res.status(400).json({ error: 'text must be 500 characters or fewer for a preview.' });
    }

    let timing;
    try {
        timing = engine.computeTiming({
            wpm,
            farnsworthWpm: farnsworthWpm !== undefined ? parsePositiveNumber(farnsworthWpm, undefined) : undefined,
            toneFrequencyHz,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const { morse, invalidCharacters } = engine.textToMorse(text);
    const plan = engine.buildPlaybackPlan(morse, timing);
    const durationMs = engine.planTotalDurationMs(plan);

    return res.json({ text, morse, timing, plan, durationMs, invalidCharacters });
}

/**
 * GET /api/morse/random?difficulty=easy&seed=... — teacher-only.
 * Generates a random training string from a difficulty preset (Phase 5
 * engine) so the preview tool can also demonstrate "generated" Morse
 * audio, not just manually typed text.
 */
function randomText(req, res) {
    const { difficulty = 'easy', seed } = req.query;

    let result;
    try {
        result = engine.generateFromDifficulty(difficulty, seed !== undefined ? { seed } : {});
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    return res.json(result);
}

module.exports = { preview, randomText };
