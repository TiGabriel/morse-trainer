/**
 * Pure logic for group/test sessions: the server-authoritative state
 * machine and exercise-content generation. No DB, no HTTP, no WebSocket
 * concerns here — same separation-of-concerns pattern as
 * `practice/practiceEngine.js`.
 *
 * State machine (matches the CHECK constraint already in schema.sql —
 * this was pre-shaped for Phase 8 by an earlier phase and is treated as
 * the project's existing terminology, not redesigned):
 *
 *   created --open--> waiting --start--> running <--pause/resume--> paused
 *      \                  \                 |                         |
 *       \-------cancel-----\-----cancel------+--stop/finish--> finished
 *                            \--------------cancel--------------> cancelled
 *
 * "countdown" is intentionally NOT a separate persisted DB status (the
 * schema's CHECK constraint only has 6 states, and the already-existing
 * teacher UI's button-visibility table keys off exactly these 6). Instead
 * the countdown-before-playback described in the project brief happens
 * *inside* the "running" status, via a `scheduled_start` realtime event
 * broadcast ahead of the moment audio actually begins (see
 * `sessionRuntime.js`).
 */
const crypto = require('crypto');
const practiceEngine = require('../practice/practiceEngine');
const engine = require('../morse-engine');

class SessionError extends Error {}

const TRANSITIONS = {
    created: { open: 'waiting', cancel: 'cancelled' },
    waiting: { start: 'running', cancel: 'cancelled' },
    running: { pause: 'paused', stop: 'finished', cancel: 'cancelled' },
    paused: { resume: 'running', stop: 'finished', cancel: 'cancelled' },
    finished: {},
    cancelled: {},
};

/** Returns the status an action would lead to, or throws if illegal from the given status. */
function nextStatus(currentStatus, action) {
    const forStatus = TRANSITIONS[currentStatus];
    const target = forStatus && forStatus[action];
    if (!target) {
        throw new SessionError(`Cannot "${action}" a session currently in status "${currentStatus}".`);
    }
    return target;
}

/** Which actions are legal from a given status — used by both the API (400 vs proceeding) and the UI. */
function availableActions(status) {
    return Object.keys(TRANSITIONS[status] || {});
}

const TERMINAL_STATUSES = ['finished', 'cancelled'];
const ACTIVE_STATUSES_FOR_STUDENTS = ['waiting', 'running', 'paused'];

/**
 * Generates `exerciseCount` fully pre-built exercises for a session, all
 * sharing the same mode/difficulty/timing configuration, by composing the
 * existing (already-tested) practice engine per item — no Morse/timing
 * logic is duplicated here. Every item gets its own derived seed so items
 * within one session differ, but the whole set is still fully
 * reproducible from `baseSeed` (useful for debugging/tests).
 */
function generateItems({ baseSeed, exerciseMode, difficulty, wpm, farnsworthWpm, toneFrequencyHz, length, exerciseCount }) {
    if (!Number.isInteger(exerciseCount) || exerciseCount < 1) {
        throw new SessionError('exerciseCount must be a positive integer.');
    }
    const resolvedBaseSeed = baseSeed ?? crypto.randomBytes(8).toString('hex');

    const items = [];
    for (let i = 0; i < exerciseCount; i += 1) {
        const seed = `${resolvedBaseSeed}:${i}`;
        const exercise = practiceEngine.buildExercise({
            mode: exerciseMode,
            difficulty,
            wpm,
            farnsworthWpm,
            toneFrequencyHz,
            length,
            seed,
        });
        items.push({ orderIndex: i, exercise });
    }
    return { baseSeed: resolvedBaseSeed, items };
}

/**
 * Grades one submitted answer against an item's stored exercise. Reused
 * for both group-practice feedback and formal-test grading — the only
 * difference between those two is *when* the result is revealed to the
 * student (enforced by the controller), not how it's computed.
 */
function gradeSubmission(exercise, submittedAnswer) {
    return engine.scoreAnswer(exercise.expectedAnswer, submittedAnswer);
}

/** Pass/fail against a configured threshold; null if the session has no threshold configured (ungraded group practice). */
function computeGrade(accuracyPercent, passThresholdPercent) {
    if (passThresholdPercent === null || passThresholdPercent === undefined) return null;
    return accuracyPercent >= passThresholdPercent ? 'pass' : 'fail';
}

module.exports = {
    SessionError,
    TRANSITIONS,
    TERMINAL_STATUSES,
    ACTIVE_STATUSES_FOR_STUDENTS,
    nextStatus,
    availableActions,
    generateItems,
    gradeSubmission,
    computeGrade,
};
