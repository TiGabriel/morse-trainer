const db = require('../../db/client');
const gradingService = require('../grading/gradingService');

// A student's own history/progress view (see stats module) needs to tell
// "reception" (listening/copying) apart from "transmission" (keying) —
// this is the one place that classification is defined, reused by
// listForStudent's toPublic() below and by statsRepository's aggregate
// queries, rather than re-deriving it in each place separately.
const RECEPTION_EXERCISE_TYPES = ['audio_to_text', 'morse_to_text', 'character_recognition', 'radiogram_training', 'character_training'];
const TRANSMISSION_EXERCISE_TYPES = ['text_to_morse'];

function exerciseDirection(exerciseType) {
    if (TRANSMISSION_EXERCISE_TYPES.includes(exerciseType)) return 'transmission';
    if (RECEPTION_EXERCISE_TYPES.includes(exerciseType)) return 'reception';
    return null;
}

function toPublic(row) {
    if (!row) return null;
    const total = row.correct_count + row.incorrect_count + row.missing_count;
    return {
        id: row.id,
        studentId: row.student_id,
        exerciseType: row.exercise_type,
        direction: exerciseDirection(row.exercise_type),
        difficulty: row.difficulty,
        wpm: row.wpm,
        farnsworthWpm: row.farnsworth_wpm,
        toneFrequencyHz: row.tone_frequency_hz,
        promptText: row.prompt_text,
        promptMorse: row.prompt_morse,
        expectedAnswer: row.expected_answer,
        submittedAnswer: row.submitted_answer,
        correctCount: row.correct_count,
        incorrectCount: row.incorrect_count,
        missingCount: row.missing_count,
        extraCount: row.extra_count,
        accuracyPercent: row.accuracy_percent,
        errorCount: row.incorrect_count + row.missing_count + row.extra_count,
        // The centralized 4-10 school grade (see grading/gradingService.js),
        // computed on read from the same correct/total this row's own
        // accuracy_percent was originally scored against — never stored
        // pre-computed, so a later change to GRADE_THRESHOLDS is reflected
        // immediately for historical rows too (same pattern
        // sessionRepository.characterGradeFor already uses).
        characterGrade: total > 0 ? gradingService.calculateGrade({ correct: row.correct_count, total }) : null,
        durationMs: row.duration_ms,
        // Morse Transmission only — the per-keystroke timing analysis
        // (see morse-transmitter-core.js's getStats()); null for every
        // other exercise type, which has nothing to report here.
        timingStats: row.timing_stats_json ? JSON.parse(row.timing_stats_json) : null,
        createdAt: row.created_at,
    };
}

function insertAttempt(data) {
    const info = db
        .prepare(
            `INSERT INTO practice_attempts (
                student_id, exercise_type, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                prompt_text, prompt_morse, expected_answer, submitted_answer,
                correct_count, incorrect_count, missing_count, extra_count, accuracy_percent, duration_ms,
                timing_stats_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            data.studentId,
            data.exerciseType,
            data.difficulty || null,
            data.wpm,
            data.farnsworthWpm || null,
            data.toneFrequencyHz || null,
            data.promptText,
            data.promptMorse,
            data.expectedAnswer,
            data.submittedAnswer,
            data.correctCount,
            data.incorrectCount,
            data.missingCount,
            data.extraCount,
            data.accuracyPercent,
            data.durationMs || null,
            data.timingStats ? JSON.stringify(data.timingStats) : null
        );
    return findById(info.lastInsertRowid);
}

function findById(id) {
    return toPublic(db.prepare('SELECT * FROM practice_attempts WHERE id = ?').get(id));
}

/**
 * Builds the shared WHERE clause + params for a student's history,
 * reused by both listForStudent (paginated rows) and countForStudent
 * (matching total) so a filtered count always matches what limit/offset
 * actually paginate over.
 */
function buildHistoryFilter(studentId, { exerciseType, direction, since, until, minWpm, maxWpm } = {}) {
    const clauses = ['student_id = ?'];
    const params = [studentId];

    if (exerciseType) {
        clauses.push('exercise_type = ?');
        params.push(exerciseType);
    }
    if (direction === 'reception' || direction === 'transmission') {
        const types = direction === 'transmission' ? TRANSMISSION_EXERCISE_TYPES : RECEPTION_EXERCISE_TYPES;
        clauses.push(`exercise_type IN (${types.map(() => '?').join(', ')})`);
        params.push(...types);
    }
    if (since) {
        clauses.push('date(created_at) >= date(?)');
        params.push(since);
    }
    if (until) {
        clauses.push('date(created_at) <= date(?)');
        params.push(until);
    }
    if (Number.isFinite(minWpm)) {
        clauses.push('wpm >= ?');
        params.push(minWpm);
    }
    if (Number.isFinite(maxWpm)) {
        clauses.push('wpm <= ?');
        params.push(maxWpm);
    }

    return { where: clauses.join(' AND '), params };
}

function listForStudent(studentId, { limit = 20, offset = 0, exerciseType, direction, since, until, minWpm, maxWpm } = {}) {
    const { where, params } = buildHistoryFilter(studentId, { exerciseType, direction, since, until, minWpm, maxWpm });
    const rows = db
        .prepare(`SELECT * FROM practice_attempts WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    return rows.map(toPublic);
}

function countForStudent(studentId, { exerciseType, direction, since, until, minWpm, maxWpm } = {}) {
    const { where, params } = buildHistoryFilter(studentId, { exerciseType, direction, since, until, minWpm, maxWpm });
    return db.prepare(`SELECT COUNT(*) AS count FROM practice_attempts WHERE ${where}`).get(...params).count;
}

/**
 * Teacher-only result management (see statsController.deleteStudentAttempt/
 * resetStudentHistory) — deletes exactly one attempt, scoped by student_id
 * in the same query so an attemptId belonging to a DIFFERENT student can
 * never be deleted by guessing an id, regardless of what the controller
 * already checked. Returns true only if a row actually existed and was
 * removed.
 */
function deleteAttempt(attemptId, studentId) {
    const info = db.prepare('DELETE FROM practice_attempts WHERE id = ? AND student_id = ?').run(attemptId, studentId);
    return info.changes > 0;
}

/**
 * Bulk "reset training history" — deletes every attempt for a student
 * matching the given filters (the same filter shape listForStudent uses;
 * omitting all of them deletes the student's ENTIRE practice history).
 * Returns the number of rows actually deleted, so the caller/teacher UI
 * can confirm what happened rather than assuming.
 */
function deleteForStudent(studentId, { exerciseType, direction, since, until, minWpm, maxWpm } = {}) {
    const { where, params } = buildHistoryFilter(studentId, { exerciseType, direction, since, until, minWpm, maxWpm });
    const info = db.prepare(`DELETE FROM practice_attempts WHERE ${where}`).run(...params);
    return info.changes;
}

module.exports = {
    insertAttempt,
    findById,
    listForStudent,
    countForStudent,
    deleteAttempt,
    deleteForStudent,
    exerciseDirection,
    RECEPTION_EXERCISE_TYPES,
    TRANSMISSION_EXERCISE_TYPES,
};
