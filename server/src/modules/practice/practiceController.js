const engine = require('../morse-engine');
const { buildExercise } = require('./practiceEngine');
const { buildRadiogram } = require('./radiogramEngine');
const { buildCharacterTrainingSession } = require('./characterTrainingEngine');
const practiceRepository = require('./practiceRepository');
const logger = require('../../logger');

function toNumberOrUndefined(v) {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * POST /api/practice/exercises
 * Generates a new exercise and returns exactly what the client needs to
 * render/play it — deliberately NOT the expected answer. The client
 * echoes every field back verbatim on submission so the server can
 * regenerate the identical exercise from its seed.
 */
function generateExercise(req, res) {
    const body = req.body || {};

    let exercise;
    try {
        exercise = buildExercise({
            mode: body.mode,
            difficulty: body.difficulty || undefined,
            length: toNumberOrUndefined(body.length),
            characters: body.characters || undefined,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const response = {
        mode: exercise.mode,
        seed: exercise.seed,
        difficulty: exercise.difficulty,
        wpm: exercise.wpm,
        farnsworthWpm: exercise.farnsworthWpm,
        toneFrequencyHz: exercise.toneFrequencyHz,
        length: exercise.length,
        durationMs: exercise.durationMs,
    };

    // Reveal only what each mode is supposed to show — never the answer.
    if (exercise.mode === 'audio_to_text' || exercise.mode === 'character_recognition') {
        response.plan = exercise.plan;
    } else if (exercise.mode === 'morse_to_text') {
        response.promptMorse = exercise.morse;
    } else if (exercise.mode === 'text_to_morse') {
        response.promptText = exercise.text;
    }

    return res.json(response);
}

/**
 * POST /api/practice/attempts
 * Regenerates the exact exercise from the echoed seed/params, scores the
 * submitted answer against it, saves the attempt to the student's own
 * practice history, and returns full feedback (including the correct
 * answer, now that the exercise is over).
 */
function submitAttempt(req, res) {
    const body = req.body || {};

    if (typeof body.submittedAnswer !== 'string') {
        return res.status(400).json({ error: 'submittedAnswer is required.' });
    }
    if (body.seed === undefined || body.seed === null || body.seed === '') {
        return res.status(400).json({ error: 'seed is required (use the value returned by /api/practice/exercises).' });
    }

    let exercise;
    try {
        exercise = buildExercise({
            mode: body.mode,
            difficulty: body.difficulty || undefined,
            length: toNumberOrUndefined(body.length),
            characters: body.characters || undefined,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const score = engine.scoreAnswer(exercise.expectedAnswer, body.submittedAnswer);

    const saved = practiceRepository.insertAttempt({
        studentId: req.user.id,
        exerciseType: exercise.mode,
        difficulty: exercise.difficulty,
        wpm: exercise.wpm,
        farnsworthWpm: exercise.farnsworthWpm,
        toneFrequencyHz: exercise.toneFrequencyHz,
        promptText: exercise.text,
        promptMorse: exercise.morse,
        expectedAnswer: exercise.expectedAnswer,
        submittedAnswer: body.submittedAnswer,
        correctCount: score.correctCount,
        incorrectCount: score.incorrectCount,
        missingCount: score.missingCount,
        extraCount: score.extraCount,
        accuracyPercent: score.accuracyPercent,
        durationMs: toNumberOrUndefined(body.durationMs),
    });

    logger.info(
        `Practice attempt saved: student="${req.user.username}" mode=${exercise.mode} accuracy=${score.accuracyPercent}%`
    );

    return res.status(201).json({
        attemptId: saved.id,
        mode: exercise.mode,
        promptText: exercise.text,
        promptMorse: exercise.morse,
        expectedAnswer: exercise.expectedAnswer,
        submittedAnswer: body.submittedAnswer,
        score,
        createdAt: saved.createdAt,
    });
}

/**
 * GET /api/practice/history?limit=&offset=
 * Returns only the CURRENT user's own practice attempts — this is
 * self-practice history, not a teacher-facing report, so there is no id
 * parameter to look up someone else's attempts.
 */
function listHistory(req, res) {
    const limit = Math.min(Math.max(toNumberOrUndefined(req.query.limit) || 20, 1), 100);
    const offset = Math.max(toNumberOrUndefined(req.query.offset) || 0, 0);

    const attempts = practiceRepository.listForStudent(req.user.id, { limit, offset });
    const total = practiceRepository.countForStudent(req.user.id);

    return res.json({ attempts, total, limit, offset });
}

/**
 * GET /api/practice/charsets
 * Exposes the engine's base character categories (letters/numbers/
 * punctuation) so the client can build a character-pool picker without
 * duplicating the canonical Morse character map.
 */
function getCharsets(req, res) {
    return res.json({
        letters: engine.CHARSETS.letters,
        numbers: engine.CHARSETS.numbers,
        punctuation: engine.CHARSETS.punctuation,
    });
}

/**
 * POST /api/practice/radiograms
 * Generates a full 3x10x4 radiogram from a caller-chosen character pool.
 * No answer is withheld — Part 1 of the redesigned Individual Training
 * flow is generate -> display -> play only, with no scoring yet.
 */
function generateRadiogram(req, res) {
    const body = req.body || {};

    let radiogram;
    try {
        radiogram = buildRadiogram({
            characters: body.characters,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    return res.json(radiogram);
}

/**
 * POST /api/practice/radiograms/analyze
 * Regenerates the exact radiogram from the echoed seed/params (the same
 * "never trust the client's copy of the answer" pattern submitAttempt
 * uses) and scores the student's transcription against it with the same
 * alignment-based scoreAnswer used everywhere else in the app. Group
 * spacing is stripped from both sides first so formatting differences
 * (extra/missing spaces between groups) are never counted as character
 * errors — only the 120-character sequence itself is compared.
 *
 * Stateless: unlike submitAttempt, this does not persist to practice
 * history (radiogram_training/character_training have no DB-backed
 * "attempt" type — see the CHECK constraint on practice_attempts).
 */
function analyzeRadiogram(req, res) {
    const body = req.body || {};

    if (typeof body.submittedAnswer !== 'string') {
        return res.status(400).json({ error: 'submittedAnswer is required.' });
    }
    if (body.seed === undefined || body.seed === null || body.seed === '') {
        return res.status(400).json({ error: 'seed is required (use the value returned by /api/practice/radiograms).' });
    }

    let radiogram;
    try {
        radiogram = buildRadiogram({
            characters: body.characters,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const reference = radiogram.text.replace(/\s+/g, '');
    const submitted = body.submittedAnswer.replace(/\s+/g, '');
    const score = engine.scoreAnswer(reference, submitted);

    return res.json({
        seed: radiogram.seed,
        reference,
        referenceGroups: radiogram.groups,
        referenceRows: radiogram.rows,
        groupSize: radiogram.groupSize,
        submittedAnswer: body.submittedAnswer,
        score,
    });
}

/**
 * POST /api/practice/character-training/sessions
 * Generates a full Character Training session: a flat sequence of
 * single-character Morse rounds, each with its own playback plan, drawn
 * only from the caller-chosen character pool. No answer is withheld —
 * gameplay reveals the correct character right after each keypress.
 */
function generateCharacterTrainingSession(req, res) {
    const body = req.body || {};

    let session;
    try {
        session = buildCharacterTrainingSession({
            characters: body.characters,
            length: toNumberOrUndefined(body.length),
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    return res.json(session);
}

module.exports = {
    generateExercise,
    submitAttempt,
    listHistory,
    getCharsets,
    generateRadiogram,
    analyzeRadiogram,
    generateCharacterTrainingSession,
};
