const sessionRepository = require('./sessionRepository');
const sessionEngine = require('./sessionEngine');
const sessionRuntime = require('./sessionRuntime');
const classRepository = require('../classes/classRepository');
const { VALID_MODES } = require('../practice/practiceEngine');
const { findDifficultyPreset } = require('../morse-engine/difficultyPresets');
const gradingService = require('../grading/gradingService');
const hub = require('../../realtime/hub');
const logger = require('../../logger');

const VALID_TYPES = ['group', 'test'];
// A late submission is still accepted within this grace window past the
// server-computed deadline, to absorb ordinary LAN/request latency —
// client timers are for display only, but a hard cutoff at exactly 0ms
// would punish students for network jitter, not for being late.
const SUBMIT_GRACE_MS = 3000;

function toNumberOrUndefined(v) {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function clampInt(value, fallback, min, max) {
    const n = Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.min(Math.max(n, min), max);
}

/**
 * POST /api/sessions (teacher)
 * Creates a session AND its full set of pre-generated exercise items in
 * one call — group/test sessions need every student to receive identical
 * content, so (unlike individual practice) items are generated once now,
 * not lazily per request.
 */
function createSession(req, res) {
    const body = req.body || {};
    const type = body.type || 'group';
    const classId = Number(body.classId);
    const exerciseMode = body.exerciseMode;
    const difficulty = body.difficulty;
    const exerciseCount = clampInt(toNumberOrUndefined(body.exerciseCount), 5, 1, 100);

    if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!classId) {
        return res.status(400).json({ error: 'classId is required.' });
    }
    if (!classRepository.findById(classId)) {
        return res.status(400).json({ error: 'classId does not refer to an existing class.' });
    }
    if (!VALID_MODES.includes(exerciseMode)) {
        return res.status(400).json({ error: `exerciseMode must be one of: ${VALID_MODES.join(', ')}` });
    }
    if (!difficulty || !findDifficultyPreset(difficulty)) {
        return res.status(400).json({ error: 'A valid difficulty preset is required.' });
    }

    const prepTimeMs = clampInt(toNumberOrUndefined(body.prepTimeMs), 5000, 1000, 30000);
    const answerTimeMs = body.answerTimeMs === undefined || body.answerTimeMs === '' ? null : clampInt(toNumberOrUndefined(body.answerTimeMs), 15000, 3000, 180000);
    const allowedAttempts = clampInt(toNumberOrUndefined(body.allowedAttempts), 1, 1, 5);
    const passThresholdPercent =
        body.passThresholdPercent === undefined || body.passThresholdPercent === ''
            ? null
            : clampInt(toNumberOrUndefined(body.passThresholdPercent), 70, 0, 100);
    const itemLength = body.length === undefined || body.length === '' ? undefined : clampInt(toNumberOrUndefined(body.length), 10, 1, 100);
    const instructions = typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim().slice(0, 2000) : null;
    // Optional teacher-picked character pool (same shape Individual
    // Training's pool picker produces — an array of single characters).
    // Omitted/invalid/empty falls back to the difficulty preset's own
    // pool, unchanged from before this option existed; the engine itself
    // re-validates/uppercases/dedupes whatever's actually usable here.
    const characters = Array.isArray(body.characters) && body.characters.length > 0 ? body.characters : undefined;

    // A teacher may restrict a formal test to specific students rather
    // than the whole class — validated against real, active students in
    // THIS class (never trusted outright from the client). An empty/
    // omitted list means "everyone in the class", unchanged from Phase 8.
    let participantIds;
    if (Array.isArray(body.participantIds) && body.participantIds.length > 0) {
        participantIds = sessionRepository.validateParticipantIds(classId, body.participantIds.map(Number));
        if (participantIds.length === 0) {
            return res.status(400).json({ error: 'None of the selected participants are active students in that class.' });
        }
    }

    let generated;
    try {
        generated = sessionEngine.generateItems({
            exerciseMode,
            difficulty,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            length: itemLength,
            characters,
            exerciseCount,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }

    // Created atomically with its items — a crash or DB error between two
    // separate inserts would otherwise leave an orphaned, item-less
    // session sitting in the teacher's list forever.
    const session = sessionRepository.createSessionWithItems(
        {
            classId,
            type,
            exerciseMode,
            difficulty,
            wpm: toNumberOrUndefined(body.wpm),
            farnsworthWpm: toNumberOrUndefined(body.farnsworthWpm),
            toneFrequencyHz: toNumberOrUndefined(body.toneFrequencyHz),
            exerciseCount,
            prepTimeMs,
            answerTimeMs,
            allowedAttempts: type === 'test' ? allowedAttempts : 1,
            passThresholdPercent: type === 'test' ? passThresholdPercent : null,
            instructions,
            participantIds,
            itemLength,
            createdBy: req.user.id,
        },
        generated.items
    );

    logger.info(
        `Session created: id=${session.id} type=${type} class=${classId} by teacher "${req.user.username}" (${exerciseCount} items)`
    );
    return res.status(201).json({ session });
}

/** GET /api/sessions (teacher) — sessions this teacher created. */
function listSessions(req, res) {
    return res.json({ sessions: sessionRepository.listByCreator(req.user.id) });
}

/** GET /api/sessions/available (student) — open/active sessions for the student's own class, narrowed further by any participant restriction. */
function listAvailable(req, res) {
    if (!req.user.classId) return res.json({ sessions: [] });
    return res.json({ sessions: sessionRepository.listAvailableForStudent(req.user.id, req.user.classId) });
}

/** GET /api/sessions/:id — teacher gets the roster too; a student only their own eligibility view. */
function getSession(req, res) {
    const id = Number(req.params.id);
    const session = sessionRepository.findByIdPublic(id);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    const itemsTotal = sessionRepository.countItems(id);

    if (req.user.role === 'teacher') {
        const roster = sessionRepository.listRoster(id, session.classId, session.participantIds);
        return res.json({ session, roster, itemsTotal });
    }

    if (!sessionRepository.isStudentInSessionClass(id, req.user.id)) {
        return res.status(403).json({ error: 'This session does not belong to your class.' });
    }
    return res.json({ session, itemsTotal });
}

/**
 * Builds one handler per teacher-only status-transition action. Keeping
 * these generic (rather than 6 near-identical functions) means the state
 * machine table in sessionEngine.js is the ONE place transition legality
 * is decided — this just wires it to the DB write + runtime scheduler +
 * broadcast.
 */
function makeTransitionHandler(action, timestampColumn, runtimeHook) {
    return function handleTransition(req, res) {
        const id = Number(req.params.id);
        const session = sessionRepository.findByIdPublic(id);
        if (!session) return res.status(404).json({ error: 'Session not found.' });

        let targetStatus;
        try {
            targetStatus = sessionEngine.nextStatus(session.status, action);
        } catch (err) {
            return res.status(409).json({ error: err.message });
        }

        const extraFields = timestampColumn ? { [timestampColumn]: new Date().toISOString() } : {};
        const info = sessionRepository.transitionStatus(id, [session.status], targetStatus, extraFields);
        if (info.changes === 0) {
            // Someone else (another teacher tab, a double-click) changed it first.
            return res.status(409).json({ error: 'Session status changed concurrently — please refresh and retry.' });
        }

        if (runtimeHook) runtimeHook(id);
        hub.broadcastSessionState(id);

        logger.info(`Session ${id}: ${session.status} --${action}--> ${targetStatus} (teacher "${req.user.username}")`);
        return res.json({ session: sessionRepository.findByIdPublic(id) });
    };
}

const openSession = makeTransitionHandler('open', 'opened_at', null);
const startSessionAction = makeTransitionHandler('start', 'started_at', sessionRuntime.startSession);
const pauseSession = makeTransitionHandler('pause', 'paused_at', sessionRuntime.pauseSession);
const resumeSession = makeTransitionHandler('resume', null, sessionRuntime.resumeSession);
const stopSession = makeTransitionHandler('stop', 'ended_at', sessionRuntime.haltSession);
const cancelSession = makeTransitionHandler('cancel', 'ended_at', sessionRuntime.haltSession);

/**
 * POST /api/sessions/:id/items/:itemId/attempts (student)
 * Server-side authoritative validation: the item must be the currently
 * active one, the deadline (computed server-side, never trusted from the
 * client) must not have passed, and allowed_attempts must not be
 * exceeded. Grading reuses the same scoring engine as individual
 * practice.
 */
function submitAttempt(req, res) {
    const sessionId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const body = req.body || {};

    if (typeof body.submittedAnswer !== 'string') {
        return res.status(400).json({ error: 'submittedAnswer is required.' });
    }
    if (req.user.role !== 'student') {
        return res.status(403).json({ error: 'Only students submit session answers.' });
    }

    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });
    if (!sessionRepository.isStudentInSessionClass(sessionId, req.user.id)) {
        return res.status(403).json({ error: 'This session does not belong to your class.' });
    }
    if (session.status !== 'running') {
        return res.status(409).json({ error: `This session is not currently running (status: ${session.status}).` });
    }

    const item = sessionRepository.getItemById(sessionId, itemId);
    if (!item) return res.status(404).json({ error: 'Item not found in this session.' });

    const runtime = sessionRuntime.getRuntimeState(sessionId);
    if (!runtime || runtime.currentItemIndex !== item.orderIndex) {
        return res.status(409).json({ error: 'That item is not the currently active one.' });
    }
    if (runtime.currentDeadlineAt && Date.now() > runtime.currentDeadlineAt + SUBMIT_GRACE_MS) {
        return res.status(409).json({ error: 'The submission window for this item has closed.' });
    }

    const existing = sessionRepository.getAttempt(itemId, req.user.id);
    if (existing && existing.attemptCount >= session.allowedAttempts) {
        return res.status(429).json({ error: 'You have used all allowed attempts for this item.' });
    }

    const attempt = sessionRepository.upsertAttempt({
        sessionItemId: itemId,
        studentId: req.user.id,
        submittedText: body.submittedAnswer,
        durationMs: toNumberOrUndefined(body.durationMs),
    });

    const score = sessionEngine.gradeSubmission(item.exercise, body.submittedAnswer);
    const grade = sessionEngine.computeGrade(score.accuracyPercent, session.passThresholdPercent);
    const characterGrade = gradingService.calculateGrade({ correct: score.correctCount, total: score.totalExpected });
    sessionRepository.upsertResult({
        attemptId: attempt.id,
        score: score.accuracyPercent,
        errorCount: score.incorrectCount + score.missingCount + score.extraCount,
        grade,
        correctCount: score.correctCount,
    });

    hub.broadcast(sessionId, {
        type: 'progress_update',
        itemIndex: item.orderIndex,
        studentId: req.user.id,
        attemptCount: attempt.attemptCount,
    });

    logger.info(`Attempt: session=${sessionId} item=${itemId} student="${req.user.username}" accuracy=${score.accuracyPercent}%`);

    // Formal tests never reveal correctness/score before the test ends —
    // group practice gives immediate feedback like individual practice does.
    if (session.type === 'test') {
        return res.status(201).json({ submitted: true, attemptCount: attempt.attemptCount });
    }
    return res
        .status(201)
        .json({ submitted: true, attemptCount: attempt.attemptCount, score, expectedAnswer: item.exercise.expectedAnswer, characterGrade });
}

/** GET /api/sessions/:id/results — full roster for a teacher; own rows only for a student, withheld mid-test. */
function getResults(req, res) {
    const sessionId = Number(req.params.id);
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found.' });

    if (req.user.role === 'teacher') {
        return res.json({ results: sessionRepository.listResultsForSession(sessionId) });
    }

    if (!sessionRepository.isStudentInSessionClass(sessionId, req.user.id)) {
        return res.status(403).json({ error: 'This session does not belong to your class.' });
    }

    const rows = sessionRepository.listResultsForStudent(sessionId, req.user.id);
    const isTestInProgress = session.type === 'test' && !['finished', 'cancelled'].includes(session.status);
    if (isTestInProgress) {
        // Submission acknowledgement only — no score/grade before completion.
        return res.json({
            results: rows.map((r) => ({ orderIndex: r.orderIndex, sessionItemId: r.sessionItemId, submitted: !!r.submittedText })),
        });
    }
    return res.json({ results: rows });
}

module.exports = {
    createSession,
    listSessions,
    listAvailable,
    getSession,
    openSession,
    startSession: startSessionAction,
    pauseSession,
    resumeSession,
    stopSession,
    cancelSession,
    submitAttempt,
    getResults,
};
