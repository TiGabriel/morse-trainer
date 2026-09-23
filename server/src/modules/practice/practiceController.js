const engine = require('../morse-engine');
const { buildExercise } = require('./practiceEngine');
const { buildRadiogram } = require('./radiogramEngine');
const { buildCharacterTrainingSession } = require('./characterTrainingEngine');
const { buildReceptionExercise } = require('./receptionEngine');
const { buildTransmissionTarget } = require('./transmissionEngine');
const { analyzeElementLog } = require('./transmissionDecoding');
const practiceRepository = require('./practiceRepository');
const gradingService = require('../grading/gradingService');
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
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });

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
        characterGrade,
        createdAt: saved.createdAt,
    });
}

const VALID_HISTORY_EXERCISE_TYPES = [
    'audio_to_text',
    'morse_to_text',
    'text_to_morse',
    'character_recognition',
    'radiogram_training',
    'character_training',
];

/**
 * GET /api/practice/history?limit=&offset=&exerciseType=&direction=&since=&until=&minWpm=&maxWpm=
 * Returns only the CURRENT user's own practice attempts — this is
 * self-practice history, not a teacher-facing report, so there is no id
 * parameter to look up someone else's attempts. Filters are all optional
 * and combine with AND; an invalid exerciseType/direction is ignored
 * (falls back to "no filter") rather than erroring, since this backs a
 * student-facing history/progress view where a stale or malformed filter
 * value should just show everything, not break the page.
 */
function listHistory(req, res) {
    const limit = Math.min(Math.max(toNumberOrUndefined(req.query.limit) || 20, 1), 200);
    const offset = Math.max(toNumberOrUndefined(req.query.offset) || 0, 0);
    const exerciseType = VALID_HISTORY_EXERCISE_TYPES.includes(req.query.exerciseType) ? req.query.exerciseType : undefined;
    const direction = req.query.direction === 'reception' || req.query.direction === 'transmission' ? req.query.direction : undefined;
    const since = typeof req.query.since === 'string' && req.query.since ? req.query.since : undefined;
    const until = typeof req.query.until === 'string' && req.query.until ? req.query.until : undefined;
    const minWpm = toNumberOrUndefined(req.query.minWpm);
    const maxWpm = toNumberOrUndefined(req.query.maxWpm);

    const filters = { exerciseType, direction, since, until, minWpm, maxWpm };
    const attempts = practiceRepository.listForStudent(req.user.id, { limit, offset, ...filters });
    const total = practiceRepository.countForStudent(req.user.id, filters);

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
        // The standard Koch-method learning order (see morseMap.js) —
        // one source of truth for every "Learned Letters" pool preset,
        // never duplicated client-side.
        koch: engine.KOCH_ORDER,
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
 * Persists the result to the student's practice history (exercise_type
 * 'radiogram_training'), same as every other individual-practice mode —
 * this used to be stateless, which meant every Radiogram Training result
 * was lost on navigation/refresh and invisible to teachers.
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
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });

    const saved = practiceRepository.insertAttempt({
        studentId: req.user.id,
        exerciseType: 'radiogram_training',
        difficulty: null,
        wpm: radiogram.timing.wpm,
        farnsworthWpm: radiogram.timing.farnsworthWpm,
        toneFrequencyHz: radiogram.timing.toneFrequencyHz,
        promptText: radiogram.text,
        promptMorse: radiogram.morse,
        expectedAnswer: reference,
        submittedAnswer: body.submittedAnswer,
        correctCount: score.correctCount,
        incorrectCount: score.incorrectCount,
        missingCount: score.missingCount,
        extraCount: score.extraCount,
        accuracyPercent: score.accuracyPercent,
        durationMs: toNumberOrUndefined(body.durationMs),
    });

    logger.info(
        `Radiogram attempt saved: student="${req.user.username}" accuracy=${score.accuracyPercent}%`
    );

    return res.json({
        attemptId: saved.id,
        seed: radiogram.seed,
        reference,
        referenceGroups: radiogram.groups,
        referenceRows: radiogram.rows,
        groupSize: radiogram.groupSize,
        submittedAnswer: body.submittedAnswer,
        score,
        characterGrade,
        createdAt: saved.createdAt,
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

/**
 * POST /api/practice/character-training/attempts
 * Regenerates the exact Character Training session from the echoed
 * seed/params (same pattern as submitAttempt/analyzeRadiogram — never
 * trust a client's claim of which rounds were correct) and scores the
 * student's per-round answers against the canonical character sequence
 * with the same alignment-based scoreAnswer used everywhere else, then
 * persists one summary row to the student's practice history
 * (exercise_type 'character_training').
 *
 * `submittedAnswer` is the sequence of characters the student actually
 * pressed, in round order (e.g. "ABXDE" for a 5-round session) — the
 * same shape client/practice.js already builds from ctResults for the
 * in-browser results screen.
 */
function submitCharacterTrainingAttempt(req, res) {
    const body = req.body || {};

    if (typeof body.submittedAnswer !== 'string') {
        return res.status(400).json({ error: 'submittedAnswer is required.' });
    }
    if (body.seed === undefined || body.seed === null || body.seed === '') {
        return res.status(400).json({ error: 'seed is required (use the value returned by /api/practice/character-training/sessions).' });
    }

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

    const expectedAnswer = session.items.map((item) => item.char).join('');
    const promptMorse = session.items.map((item) => item.morse).join(' ');
    const score = engine.scoreAnswer(expectedAnswer, body.submittedAnswer);
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });

    const saved = practiceRepository.insertAttempt({
        studentId: req.user.id,
        exerciseType: 'character_training',
        difficulty: null,
        wpm: session.timing.wpm,
        farnsworthWpm: session.timing.farnsworthWpm,
        toneFrequencyHz: session.timing.toneFrequencyHz,
        promptText: expectedAnswer,
        promptMorse,
        expectedAnswer,
        submittedAnswer: body.submittedAnswer,
        correctCount: score.correctCount,
        incorrectCount: score.incorrectCount,
        missingCount: score.missingCount,
        extraCount: score.extraCount,
        accuracyPercent: score.accuracyPercent,
        durationMs: toNumberOrUndefined(body.durationMs),
    });

    logger.info(
        `Character Training attempt saved: student="${req.user.username}" accuracy=${score.accuracyPercent}%`
    );

    return res.status(201).json({
        attemptId: saved.id,
        seed: session.seed,
        expectedAnswer,
        submittedAnswer: body.submittedAnswer,
        score,
        characterGrade,
        createdAt: saved.createdAt,
    });
}

/**
 * POST /api/practice/reception/exercises
 * Generates a Reception (Audio -> Text) exercise and returns only what's
 * needed to play it — deliberately withholding `text`/`groups`/`morse`,
 * same "nothing about the answer leaks before submission" contract as
 * the original buildExercise('audio_to_text') flow. The client echoes
 * every field back verbatim at submission time so the server can
 * regenerate the identical exercise from its seed (see receptionEngine.js).
 */
function generateReceptionExercise(req, res) {
    const body = req.body || {};

    let exercise;
    try {
        exercise = buildReceptionExercise({
            characters: body.characters,
            groupSize: body.groupSize === undefined ? undefined : toNumberOrUndefined(body.groupSize),
            groupCount: toNumberOrUndefined(body.groupCount),
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    return res.json({
        seed: exercise.seed,
        characters: exercise.characters,
        groupSize: exercise.groupSize,
        groupCount: exercise.groupCount,
        totalCharacters: exercise.totalCharacters,
        timing: exercise.timing,
        plan: exercise.plan,
        durationMs: exercise.durationMs,
    });
}

/**
 * POST /api/practice/reception/attempts
 * Regenerates the exact Reception exercise from the echoed seed/params
 * (never trusts a client's copy of the answer — same pattern as every
 * other submit endpoint in this file) and scores the student's
 * transcription with the same alignment-based scoreAnswer used
 * everywhere else. Group-separator whitespace is stripped from both
 * sides before scoring so formatting differences (extra/missing spaces
 * between groups) are never counted as character errors — the raw
 * `submittedAnswer` the student actually typed is still stored verbatim,
 * never silently corrected. Persists to practice history as
 * 'audio_to_text', the exercise type this mode has always used.
 */
function submitReceptionAttempt(req, res) {
    const body = req.body || {};

    if (typeof body.submittedAnswer !== 'string') {
        return res.status(400).json({ error: 'submittedAnswer is required.' });
    }
    if (body.seed === undefined || body.seed === null || body.seed === '') {
        return res.status(400).json({ error: 'seed is required (use the value returned by /api/practice/reception/exercises).' });
    }

    let exercise;
    try {
        exercise = buildReceptionExercise({
            characters: body.characters,
            groupSize: body.groupSize === undefined ? undefined : toNumberOrUndefined(body.groupSize),
            groupCount: toNumberOrUndefined(body.groupCount),
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const reference = exercise.text.replace(/\s+/g, '');
    const submitted = body.submittedAnswer.replace(/\s+/g, '');
    const score = engine.scoreAnswer(reference, submitted);
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });

    const saved = practiceRepository.insertAttempt({
        studentId: req.user.id,
        exerciseType: 'audio_to_text',
        difficulty: null,
        wpm: exercise.timing.wpm,
        farnsworthWpm: exercise.timing.farnsworthWpm,
        toneFrequencyHz: exercise.timing.toneFrequencyHz,
        promptText: exercise.text,
        promptMorse: exercise.morse,
        expectedAnswer: reference,
        submittedAnswer: body.submittedAnswer,
        correctCount: score.correctCount,
        incorrectCount: score.incorrectCount,
        missingCount: score.missingCount,
        extraCount: score.extraCount,
        accuracyPercent: score.accuracyPercent,
        durationMs: toNumberOrUndefined(body.durationMs),
    });

    logger.info(
        `Reception attempt saved: student="${req.user.username}" accuracy=${score.accuracyPercent}%`
    );

    return res.status(201).json({
        attemptId: saved.id,
        seed: exercise.seed,
        reference,
        referenceGroups: exercise.groups,
        groupSize: exercise.groupSize,
        submittedAnswer: body.submittedAnswer,
        score,
        characterGrade,
        createdAt: saved.createdAt,
    });
}

const MAX_ELEMENT_LOG_LENGTH = 5000; // generous for even a very long, very slow transmission; guards analyzeElementLog's O(n) walk from abuse
const MAX_ELEMENT_DURATION_MS = 60000; // no single key press or gap in a real exercise is ever a full minute long

function isValidElementLog(elementLog) {
    if (!Array.isArray(elementLog) || elementLog.length === 0 || elementLog.length > MAX_ELEMENT_LOG_LENGTH) return false;
    return elementLog.every(
        (el) =>
            el &&
            (el.type === 'tone' || el.type === 'gap') &&
            Number.isFinite(el.durationMs) &&
            el.durationMs > 0 &&
            el.durationMs <= MAX_ELEMENT_DURATION_MS
    );
}

/**
 * POST /api/practice/transmission/exercises
 * Generates a Morse Transmission target and returns it in full — unlike
 * Reception, nothing is withheld: the student is meant to see the
 * target text the whole time and reproduce it themselves via the Space
 * key (see morse-transmitter-core.js for the keying/decoding engine).
 */
function generateTransmissionExercise(req, res) {
    const body = req.body || {};

    let target;
    try {
        target = buildTransmissionTarget({
            characters: body.characters,
            groupSize: body.groupSize === undefined ? undefined : toNumberOrUndefined(body.groupSize),
            groupCount: toNumberOrUndefined(body.groupCount),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    return res.json(target);
}

/**
 * POST /api/practice/transmission/attempts
 * Regenerates the exact target from the echoed seed/params (never trusts
 * the client's own copy) AND, critically, never trusts a client-reported
 * "transmittedText" string either: it re-derives the transmitted text
 * itself from the student's raw key-press/gap element log via
 * analyzeElementLog (the same MorseTimingDecoder/MorseCharacterDecoder
 * pipeline the hidden Morse Receiver uses for audio, reused verbatim —
 * see transmissionDecoding.js). Scores transmitted-vs-target with the
 * same alignment-based scoreAnswer used everywhere else, grades via the
 * centralized gradingService, and persists the per-keystroke timing
 * statistics alongside the result.
 */
function submitTransmissionAttempt(req, res) {
    const body = req.body || {};

    if (!isValidElementLog(body.elementLog)) {
        return res.status(400).json({ error: 'elementLog is required: a non-empty array of {type: "tone"|"gap", durationMs} entries.' });
    }
    if (body.seed === undefined || body.seed === null || body.seed === '') {
        return res.status(400).json({ error: 'seed is required (use the value returned by /api/practice/transmission/exercises).' });
    }
    const wpm = toNumberOrUndefined(body.wpm);
    if (!wpm || wpm <= 0) {
        return res.status(400).json({ error: 'wpm is required.' });
    }

    let target;
    try {
        target = buildTransmissionTarget({
            characters: body.characters,
            groupSize: body.groupSize === undefined ? undefined : toNumberOrUndefined(body.groupSize),
            groupCount: toNumberOrUndefined(body.groupCount),
            seed: body.seed,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    const toleranceFactor = toNumberOrUndefined(body.toleranceFactor);
    const { decodedText, stats } = analyzeElementLog(body.elementLog, { wpm, toleranceFactor });

    const reference = target.text.replace(/\s+/g, '');
    const transmitted = decodedText.replace(/\s+/g, '');
    const score = engine.scoreAnswer(reference, transmitted);
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });

    const saved = practiceRepository.insertAttempt({
        studentId: req.user.id,
        exerciseType: 'text_to_morse',
        difficulty: null,
        wpm: stats.targetWpm,
        promptText: target.text,
        promptMorse: target.morse,
        expectedAnswer: reference,
        submittedAnswer: decodedText,
        correctCount: score.correctCount,
        incorrectCount: score.incorrectCount,
        missingCount: score.missingCount,
        extraCount: score.extraCount,
        accuracyPercent: score.accuracyPercent,
        durationMs: stats.totalDurationMs,
        timingStats: stats,
    });

    logger.info(
        `Transmission attempt saved: student="${req.user.username}" accuracy=${score.accuracyPercent}% actualWpm=${stats.actualWpm}`
    );

    return res.status(201).json({
        attemptId: saved.id,
        seed: target.seed,
        reference,
        referenceGroups: target.groups,
        groupSize: target.groupSize,
        transmittedText: decodedText,
        score,
        characterGrade,
        stats,
        createdAt: saved.createdAt,
    });
}

module.exports = {
    generateExercise,
    submitAttempt,
    listHistory,
    getCharsets,
    generateRadiogram,
    analyzeRadiogram,
    generateCharacterTrainingSession,
    submitCharacterTrainingAttempt,
    generateReceptionExercise,
    submitReceptionAttempt,
    generateTransmissionExercise,
    submitTransmissionAttempt,
};
