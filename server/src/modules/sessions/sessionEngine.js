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
const radiogramEngine = require('../practice/radiogramEngine');
const { buildTransmissionTarget } = require('../practice/transmissionEngine');
const { analyzeElementLog } = require('../practice/transmissionDecoding');
const engine = require('../morse-engine');

// Same default every Individual Training Transmission exercise uses
// (see receptionEngine.js's sibling, morse-transmitter-core.js's
// DEFAULT_TOLERANCE_FACTOR) — a formal test doesn't currently expose a
// teacher-facing control for this, so every transmission item uses the
// same sensible default classification tolerance.
const DEFAULT_TRANSMISSION_TOLERANCE_FACTOR = 0.35;

// Every exercise mode a Group Session / Formal Test can be created with:
// the four shared with Individual Practice's engine, plus 'transmission'
// (Space-bar keying, see buildTransmissionExercise), which only exists
// here — it has no practiceEngine.buildExercise counterpart, so it can't
// simply live in practiceEngine.VALID_MODES. Matches the
// sessions.exercise_mode CHECK constraint in schema.sql exactly.
const SESSION_EXERCISE_MODES = [...practiceEngine.VALID_MODES, 'transmission'];

// Real-procedure call-up sent immediately before every Group Session
// radiogram, exactly like Individual Training's Radiogram Training does
// NOT do (this preamble is specific to Group Session/testing — see
// buildRadiogramExercise). Transmitted as one "word" (normal
// inter-character spacing between the four V's), then a full inter-word
// gap before the radiogram itself begins — see buildRadiogramExercise.
const RADIOGRAM_PREAMBLE_TEXT = 'VVVV';

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
 * Builds one Group Session "audio_to_text" item as a radiogram: the exact
 * same fixed 3-row x 10-group x 4-character (120-character) block
 * Individual Training's Radiogram Training produces, via the same
 * `radiogramEngine.buildRadiogram()` — never a separately-invented
 * shape. Ignores the difficulty preset's own length/groupSize range
 * (a radiogram's shape is always fixed, per radiogramEngine), but still
 * resolves wpm/farnsworthWpm from that preset's range when the teacher
 * didn't specify one explicitly, by reusing the existing
 * `generateFromDifficulty` resolution (its generated text/length are
 * discarded — only the reproducible wpm/farnsworthWpm draw is used).
 *
 * A VVVV call-up preamble (see RADIOGRAM_PREAMBLE_TEXT) is prepended to
 * the *playback plan only*: it's transmitted as one extra "word" ahead of
 * the radiogram's own groups, using the exact same text/word parsing
 * (`engine.textToMorse` + `engine.buildPlaybackPlan`) already used
 * everywhere else, so it naturally gets normal inter-character spacing
 * within VVVV and a full inter-word gap before the radiogram starts —
 * no bespoke timing logic needed. Every other field on the returned
 * exercise (expectedAnswer, text, groups, rows, morse, durationMs used
 * for grading/history/display) describes the 120-character radiogram
 * ALONE — the preamble is excluded from all of it, per spec.
 *
 * `characters`, when given, overrides the difficulty preset's own
 * character pool (e.g. the teacher picked specific letters/numbers in the
 * Group Session settings UI) — wpm/farnsworthWpm resolution from the
 * preset is unaffected either way.
 */
function buildRadiogramExercise({ difficulty, wpm, farnsworthWpm, toneFrequencyHz, characters, seed }) {
    const preset = engine.findDifficultyPreset(difficulty);
    if (!preset) {
        throw new SessionError(`Unknown difficulty preset "${difficulty}".`);
    }

    const overrides = { seed };
    if (wpm) overrides.wpm = wpm;
    if (farnsworthWpm) overrides.farnsworthWpm = farnsworthWpm;
    const resolved = engine.generateFromDifficulty(difficulty, overrides);

    const radiogram = radiogramEngine.buildRadiogram({
        characters: characters && characters.length > 0 ? characters : preset.characters,
        wpm: resolved.wpm,
        farnsworthWpm: resolved.farnsworthWpm,
        toneFrequencyHz: toneFrequencyHz || 600,
        seed,
    });

    const combinedText = `${RADIOGRAM_PREAMBLE_TEXT} ${radiogram.text}`;
    const { morse: combinedMorse } = engine.textToMorse(combinedText);
    const plan = engine.buildPlaybackPlan(combinedMorse, radiogram.timing);
    const durationMs = engine.planTotalDurationMs(plan);

    return {
        mode: 'audio_to_text',
        seed: radiogram.seed,
        difficulty,
        wpm: radiogram.timing.wpm,
        farnsworthWpm: radiogram.timing.farnsworthWpm,
        toneFrequencyHz: radiogram.timing.toneFrequencyHz,
        length: radiogram.totalCharacters,
        text: radiogram.text,
        expectedAnswer: radiogram.text,
        groups: radiogram.groups,
        rows: radiogram.rows,
        rowCount: radiogram.rowCount,
        groupsPerRow: radiogram.groupsPerRow,
        groupSize: radiogram.groupSize,
        totalCharacters: radiogram.totalCharacters,
        preambleText: RADIOGRAM_PREAMBLE_TEXT,
        morse: radiogram.morse,
        timing: radiogram.timing,
        plan,
        durationMs,
    };
}

/**
 * Builds one Formal Test / Group Session "transmission" item: the student
 * is shown a target sequence and keys it themselves (Space bar), exactly
 * like Individual Training's Transmission Training — reuses
 * transmissionEngine.buildTransmissionTarget() for the target text
 * itself, never a second copy of that generation logic. Unlike
 * buildRadiogramExercise, there is no audio plan/durationMs to compute —
 * transmission has no playback phase at all, the item's entire answer
 * window (`session.answer_time_ms`) IS the keying time.
 *
 * `length`, when given, overrides the difficulty preset's own drawn
 * length (its own random length draw still happens unconditionally, per
 * generateFromDifficulty's own reproducibility contract — see its doc
 * comment); `characters` overrides the preset's own character pool.
 * `toleranceFactor`, when given, overrides the default dot/dash/gap
 * timing-classification tolerance (see morse-transmitter-core.js) —
 * the teacher-facing "Timing tolerance" field in the session wizard.
 */
function buildTransmissionExercise({ difficulty, wpm, farnsworthWpm, length, characters, seed, toleranceFactor }) {
    const preset = engine.findDifficultyPreset(difficulty);
    if (!preset) {
        throw new SessionError(`Unknown difficulty preset "${difficulty}".`);
    }

    const overrides = { seed };
    if (wpm) overrides.wpm = wpm;
    if (farnsworthWpm) overrides.farnsworthWpm = farnsworthWpm;
    if (length) overrides.length = length;
    const resolved = engine.generateFromDifficulty(difficulty, overrides);

    const target = buildTransmissionTarget({
        characters: characters && characters.length > 0 ? characters : preset.characters,
        groupSize: 0,
        groupCount: resolved.length,
        seed,
    });

    return {
        mode: 'transmission',
        seed: target.seed,
        difficulty,
        wpm: resolved.wpm,
        farnsworthWpm: resolved.farnsworthWpm,
        toleranceFactor: Number.isFinite(toleranceFactor) && toleranceFactor > 0 ? toleranceFactor : DEFAULT_TRANSMISSION_TOLERANCE_FACTOR,
        length: target.totalCharacters,
        text: target.text,
        expectedAnswer: target.text,
        groups: target.groups,
        groupSize: target.groupSize,
        totalCharacters: target.totalCharacters,
        morse: target.morse,
        durationMs: 0,
    };
}

/**
 * Generates `exerciseCount` fully pre-built exercises for a session, all
 * sharing the same mode/difficulty/timing configuration. "audio_to_text"
 * items are radiograms (see buildRadiogramExercise); every other mode
 * still composes the existing (already-tested) practice engine per item,
 * exactly as before — no Morse/timing logic is duplicated here either
 * way. Every item gets its own derived seed so items within one session
 * differ, but the whole set is still fully reproducible from `baseSeed`
 * (useful for debugging/tests).
 *
 * `characters`, when given (a non-empty array from the teacher's own
 * character-pool selection in the Group Session settings UI — the same
 * picker/data shape Individual Training already uses), overrides the
 * difficulty preset's default pool for every item. Omitted/empty means
 * "use the difficulty preset's own pool", exactly as before this option
 * existed.
 */
function generateItems({ baseSeed, exerciseMode, difficulty, wpm, farnsworthWpm, toneFrequencyHz, length, characters, exerciseCount, toleranceFactor }) {
    if (!Number.isInteger(exerciseCount) || exerciseCount < 1) {
        throw new SessionError('exerciseCount must be a positive integer.');
    }
    const resolvedBaseSeed = baseSeed ?? crypto.randomBytes(8).toString('hex');

    const items = [];
    for (let i = 0; i < exerciseCount; i += 1) {
        const seed = `${resolvedBaseSeed}:${i}`;
        let exercise;
        if (exerciseMode === 'audio_to_text') {
            exercise = buildRadiogramExercise({ difficulty, wpm, farnsworthWpm, toneFrequencyHz, characters, seed });
        } else if (exerciseMode === 'transmission') {
            exercise = buildTransmissionExercise({ difficulty, wpm, farnsworthWpm, length, characters, seed, toleranceFactor });
        } else {
            exercise = practiceEngine.buildExercise({
                mode: exerciseMode,
                difficulty,
                wpm,
                farnsworthWpm,
                toneFrequencyHz,
                length,
                characters: characters && characters.length > 0 ? characters : undefined,
                seed,
            });
        }
        items.push({ orderIndex: i, exercise });
    }
    return { baseSeed: resolvedBaseSeed, items };
}

/**
 * Grades one submitted answer against an item's stored exercise. Reused
 * for both group-practice feedback and formal-test grading — the only
 * difference between those two is *when* the result is revealed to the
 * student (enforced by the controller), not how it's computed.
 *
 * Group spacing is stripped from both sides first — the same convention
 * Individual Training's radiogram analysis already uses (see
 * practiceController.analyzeRadiogram) — so formatting differences
 * (extra/missing spaces between groups) are never counted as character
 * errors for a radiogram-shaped exercise. A no-op for exercises whose
 * expected answer never had spaces to begin with.
 */
function gradeSubmission(exercise, submittedAnswer) {
    if (exercise.mode === 'transmission') {
        return gradeTransmissionSubmission(exercise, submittedAnswer);
    }
    const expected = exercise.expectedAnswer.replace(/\s+/g, '');
    const submitted = submittedAnswer.replace(/\s+/g, '');
    return engine.scoreAnswer(expected, submitted);
}

/**
 * `submittedAnswer` for a 'transmission' item is not typed text — it's
 * the student's raw key-press/gap element log (the same shape
 * Individual Training's Transmission mode submits), JSON-stringified so
 * it fits the existing `submittedAnswer: string` contract with no schema
 * change. Never trusts a client-reported decoding: re-derives the
 * transmitted text itself via analyzeElementLog (the exact same
 * MorseTimingDecoder/MorseCharacterDecoder pipeline reused everywhere
 * else in this app), then scores THAT against the target — same
 * "server remains authoritative" rule every other exercise type follows.
 */
function gradeTransmissionSubmission(exercise, submittedAnswer) {
    let elementLog;
    try {
        elementLog = JSON.parse(submittedAnswer);
    } catch {
        elementLog = [];
    }
    if (!Array.isArray(elementLog)) elementLog = [];

    const { decodedText, stats } = analyzeElementLog(elementLog, {
        wpm: exercise.wpm,
        toleranceFactor: exercise.toleranceFactor,
    });
    const expected = exercise.expectedAnswer.replace(/\s+/g, '');
    const submitted = decodedText.replace(/\s+/g, '');
    const score = engine.scoreAnswer(expected, submitted);
    return { ...score, decodedText, timingStats: stats };
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
    RADIOGRAM_PREAMBLE_TEXT,
    DEFAULT_TRANSMISSION_TOLERANCE_FACTOR,
    SESSION_EXERCISE_MODES,
    nextStatus,
    availableActions,
    generateItems,
    buildRadiogramExercise,
    buildTransmissionExercise,
    gradeSubmission,
    computeGrade,
};
