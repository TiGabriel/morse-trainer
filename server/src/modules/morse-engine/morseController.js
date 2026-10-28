const engine = require('./index');
const userRepository = require('../users/userRepository');
const classMorseRepository = require('../classes/classMorseRepository');

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

/** Speed/tone the Morse Alphabet page's click-to-hear samples are rendered at. */
const ALPHABET_SAMPLE_WPM = 15;

/**
 * GET /api/morse/alphabet — any authenticated user (teacher or student).
 * The Morse Alphabet reference page, generated straight from the
 * canonical CHARSETS/CHAR_TO_MORSE tables (morseMap.js) — the same ones
 * every exercise, test and decoder in the app uses — so the page can
 * never drift from what the application actually supports. Each entry
 * also carries a ready-to-play playback plan from the existing
 * buildPlaybackPlan (the same data shape /preview returns), so the
 * client's existing MorseAudioPlayer can play it with no second Morse
 * audio/timing implementation.
 *
 * Role-aware, enforced HERE rather than in the client:
 *   - teacher -> the complete alphabet (restricted: false).
 *   - student -> ONLY the characters their current class allows
 *     (class_morse_characters), looked up fresh from the database on
 *     every request so a class move or a teacher's edit applies on the
 *     next reload. Unauthorized characters are never included in the
 *     response in any form; no class / nothing configured -> empty
 *     lists (configured: false), never the full alphabet as a fallback.
 */
function alphabet(req, res) {
    const timing = engine.computeTiming({ wpm: ALPHABET_SAMPLE_WPM, toneFrequencyHz: DEFAULT_TONE_FREQUENCY_HZ });
    const toEntries = (chars) =>
        chars.map((char) => {
            const morse = engine.CHAR_TO_MORSE[char];
            const plan = engine.buildPlaybackPlan(morse, timing);
            return { char, morse, plan, durationMs: engine.planTotalDurationMs(plan) };
        });

    let allowed = null; // null = unrestricted (teacher)
    if (req.user.role !== 'teacher') {
        const row = userRepository.findById(req.user.id);
        const classId = row ? row.class_id : null;
        allowed = new Set(classId ? classMorseRepository.listForClass(classId) : []);
    }
    const visible = (chars) => (allowed ? chars.filter((ch) => allowed.has(ch)) : chars);

    return res.json({
        wpm: ALPHABET_SAMPLE_WPM,
        toneFrequencyHz: DEFAULT_TONE_FREQUENCY_HZ,
        restricted: allowed !== null,
        configured: allowed === null || allowed.size > 0,
        letters: toEntries(visible(engine.CHARSETS.letters)),
        numbers: toEntries(visible(engine.CHARSETS.numbers)),
        punctuation: toEntries(visible(engine.CHARSETS.punctuation)),
    });
}

module.exports = { preview, randomText, alphabet };
