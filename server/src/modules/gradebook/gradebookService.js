/**
 * Turns a finished Formal Test's own authoritative graded results into
 * TEMPORARY electronic-gradebook entries — one per student who actually
 * submitted something. Never re-grades anything: it reads the exact
 * per-item results the test already persisted (via
 * sessionRepository.listResultsForSession, the same data the teacher's
 * Group Sessions results view shows) and summarizes them the same way
 * that view does (see sessions.js's summarizeStudentResults):
 *
 *   - accuracy = mean of the student's scored items' accuracy %
 *   - pass/fail = fail if any graded item failed, else pass (null when
 *     the test has no pass threshold configured)
 *   - grade (4-10) = mean of the per-item centralized school grades
 *     (gradingService, computed on read by the repository), rounded
 *
 * Idempotent: safe to call more than once for the same session (e.g.
 * auto-finish and a teacher's Stop racing, or a retry) — the database's
 * partial unique index makes a second insert for the same
 * student/test a no-op, so there is never a duplicate entry.
 */
const sessionRepository = require('../sessions/sessionRepository');
const gradebookRepository = require('./gradebookRepository');
const logger = require('../../logger');

function summarizeStudentRows(rows) {
    const scored = rows.filter((r) => r.score !== null && r.score !== undefined);
    const accuracy = scored.length > 0 ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : null;
    const passFlags = rows.map((r) => r.grade).filter(Boolean);
    const passFail = passFlags.length === 0 ? null : passFlags.includes('fail') ? 'fail' : 'pass';
    const marks = rows.map((r) => r.characterGrade && r.characterGrade.grade).filter((g) => g !== null && g !== undefined);
    const grade = marks.length > 0 ? Math.round(marks.reduce((sum, g) => sum + g, 0) / marks.length) : null;
    return {
        accuracy: accuracy === null ? null : Math.round(accuracy * 100) / 100,
        passFail,
        grade,
        itemsAnswered: rows.filter((r) => r.attemptCount > 0).length,
        itemsTotal: rows.length,
    };
}

/**
 * @param {number} sessionId
 * @returns {number} how many new temporary entries were created (0 when
 *   the session isn't a finished Formal Test, or entries already exist)
 */
function recordFormalTestResults(sessionId) {
    const session = sessionRepository.findByIdPublic(sessionId);
    if (!session || session.type !== 'test' || session.status !== 'finished') return 0;

    const byStudent = new Map();
    sessionRepository.listResultsForSession(sessionId).forEach((row) => {
        if (!byStudent.has(row.studentId)) byStudent.set(row.studentId, []);
        byStudent.get(row.studentId).push(row);
    });

    let created = 0;
    byStudent.forEach((rows, studentId) => {
        const summary = summarizeStudentRows(rows);
        // Only a student who actually took part gets a result entry — an
        // eligible student who never submitted anything has no result.
        if (summary.itemsAnswered === 0) return;

        const inserted = gradebookRepository.insertFormalTestEntry({
            studentId,
            teacherId: session.createdBy,
            sessionId,
            grade: summary.grade,
            details: {
                exerciseMode: session.exerciseMode,
                difficulty: session.difficulty,
                accuracyPercent: summary.accuracy,
                passFail: summary.passFail,
                itemsAnswered: summary.itemsAnswered,
                itemsTotal: summary.itemsTotal,
                testDate: session.endedAt || session.startedAt || null,
            },
        });
        if (inserted) created += 1;
    });

    if (created > 0) {
        logger.info(`Gradebook: created ${created} temporary Formal Test entr${created === 1 ? 'y' : 'ies'} for session ${sessionId}.`);
    }
    return created;
}

/** Never lets a gradebook problem break the session lifecycle that triggered it — logged, not thrown. */
function safeRecordFormalTestResults(sessionId) {
    try {
        return recordFormalTestResults(sessionId);
    } catch (err) {
        logger.error(`Gradebook: failed to record Formal Test results for session ${sessionId}: ${err.message}`);
        return 0;
    }
}

module.exports = { recordFormalTestResults, safeRecordFormalTestResults, summarizeStudentRows };
