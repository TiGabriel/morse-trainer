/**
 * Read-only aggregate queries over the existing, already-reliable
 * practice/session data. Deliberately does NOT compute anything the
 * current schema can't actually support — e.g. "most commonly confused
 * characters" would need per-character diff detail that is never
 * persisted anywhere (only aggregate correct/incorrect/missing/extra
 * counts are stored), so that metric is not implemented rather than
 * faked from data that can't support it.
 */
const db = require('../../db/client');

/** Rounds to 2 decimal places, or returns null for "no data" rather than 0/NaN — a student with zero attempts has no average, not a 0% average. */
function round2(value) {
    return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------
// Practice (individual, ungraded)
// ---------------------------------------------------------------------

function getStudentPracticeSummary(studentId) {
    const overall = db
        .prepare('SELECT COUNT(*) AS count, AVG(accuracy_percent) AS avg_accuracy FROM practice_attempts WHERE student_id = ?')
        .get(studentId);

    const byType = db
        .prepare(
            `SELECT exercise_type, COUNT(*) AS count, AVG(accuracy_percent) AS avg_accuracy
             FROM practice_attempts WHERE student_id = ? GROUP BY exercise_type ORDER BY exercise_type`
        )
        .all(studentId);

    // A "recent vs. overall" trend is only meaningful with enough history
    // to compare against — otherwise "last 5" and "all-time" are nearly
    // the same 2-3 data points, which isn't a trend, it's noise.
    let recentTrend = null;
    if (overall.count >= 10) {
        const recent = db
            .prepare(
                `SELECT AVG(accuracy_percent) AS avg_accuracy FROM (
                    SELECT accuracy_percent FROM practice_attempts WHERE student_id = ?
                    ORDER BY created_at DESC, id DESC LIMIT 5
                 )`
            )
            .get(studentId);
        recentTrend = {
            recentAvgAccuracy: round2(recent.avg_accuracy),
            overallAvgAccuracy: round2(overall.avg_accuracy),
            sampleSize: 5,
        };
    }

    return {
        attemptCount: overall.count,
        avgAccuracy: round2(overall.avg_accuracy),
        byExerciseType: byType.map((row) => ({
            exerciseType: row.exercise_type,
            count: row.count,
            avgAccuracy: round2(row.avg_accuracy),
        })),
        recentTrend,
    };
}

/** Daily accuracy averages for a simple progress-over-time view — each day's own average, never interpolated or smoothed across gaps. */
function getStudentAccuracyByDay(studentId, { days = 14 } = {}) {
    const rows = db
        .prepare(
            `SELECT date(created_at) AS day, COUNT(*) AS count, AVG(accuracy_percent) AS avg_accuracy
             FROM practice_attempts
             WHERE student_id = ? AND date(created_at) >= date('now', ?)
             GROUP BY day
             ORDER BY day ASC`
        )
        .all(studentId, `-${days} days`);
    return rows.map((row) => ({ day: row.day, count: row.count, avgAccuracy: round2(row.avg_accuracy) }));
}

// ---------------------------------------------------------------------
// Group sessions / formal tests (graded, server-authoritative)
// ---------------------------------------------------------------------

/**
 * Only counts `finished` sessions — an in-progress session's partial
 * results would understate scores for students who haven't reached
 * later items yet, which is exactly the kind of misleading statistic
 * this module is meant to avoid.
 */
function getStudentSessionSummary(studentId) {
    const rows = db
        .prepare(
            `SELECT sessions.type,
                    COUNT(DISTINCT sessions.id) AS session_count,
                    COUNT(results.id) AS graded_item_count,
                    AVG(results.score) AS avg_score,
                    SUM(CASE WHEN results.grade = 'pass' THEN 1 ELSE 0 END) AS pass_count,
                    SUM(CASE WHEN results.grade = 'fail' THEN 1 ELSE 0 END) AS fail_count
             FROM attempts
             JOIN session_items ON session_items.id = attempts.session_item_id
             JOIN sessions ON sessions.id = session_items.session_id
             LEFT JOIN results ON results.attempt_id = attempts.id
             WHERE attempts.student_id = ? AND sessions.status = 'finished'
             GROUP BY sessions.type`
        )
        .all(studentId);

    return rows.map((row) => {
        const gradedCount = row.pass_count + row.fail_count;
        return {
            type: row.type,
            sessionCount: row.session_count,
            gradedItemCount: row.graded_item_count,
            avgScore: round2(row.avg_score),
            passCount: row.pass_count,
            failCount: row.fail_count,
            // null (not 0%) when nothing was ever graded with a pass
            // threshold — most group-practice sessions have none, and a
            // 0% pass rate would misleadingly read as "always failed".
            passRatePercent: gradedCount > 0 ? round2((row.pass_count / gradedCount) * 100) : null,
        };
    });
}

// ---------------------------------------------------------------------
// Class-level summaries (teacher-facing)
// ---------------------------------------------------------------------

function getClassStudentIds(classId) {
    return db
        .prepare("SELECT id FROM users WHERE class_id = ? AND role = 'student' AND is_active = 1")
        .all(classId)
        .map((r) => r.id);
}

function getClassPracticeSummary(classId) {
    const overall = db
        .prepare(
            `SELECT COUNT(*) AS count, AVG(pa.accuracy_percent) AS avg_accuracy
             FROM practice_attempts pa
             JOIN users ON users.id = pa.student_id
             WHERE users.class_id = ? AND users.role = 'student' AND users.is_active = 1`
        )
        .get(classId);
    return { attemptCount: overall.count, avgAccuracy: round2(overall.avg_accuracy) };
}

function getClassSessionSummary(classId) {
    const rows = db
        .prepare(
            `SELECT sessions.type,
                    COUNT(DISTINCT sessions.id) AS session_count,
                    COUNT(results.id) AS graded_item_count,
                    AVG(results.score) AS avg_score,
                    SUM(CASE WHEN results.grade = 'pass' THEN 1 ELSE 0 END) AS pass_count,
                    SUM(CASE WHEN results.grade = 'fail' THEN 1 ELSE 0 END) AS fail_count
             FROM sessions
             JOIN session_items ON session_items.session_id = sessions.id
             JOIN attempts ON attempts.session_item_id = session_items.id
             LEFT JOIN results ON results.attempt_id = attempts.id
             WHERE sessions.class_id = ? AND sessions.status = 'finished'
             GROUP BY sessions.type`
        )
        .all(classId);

    return rows.map((row) => {
        const gradedCount = row.pass_count + row.fail_count;
        return {
            type: row.type,
            sessionCount: row.session_count,
            gradedItemCount: row.graded_item_count,
            avgScore: round2(row.avg_score),
            passCount: row.pass_count,
            failCount: row.fail_count,
            passRatePercent: gradedCount > 0 ? round2((row.pass_count / gradedCount) * 100) : null,
        };
    });
}

/** Per-student roster with a light practice+test summary each — the table a teacher actually wants to scan for who needs help. */
function getClassStudentBreakdown(classId) {
    const students = db
        .prepare(
            `SELECT id, username, first_name, last_name, rank FROM users
             WHERE class_id = ? AND role = 'student' AND is_active = 1
             ORDER BY last_name, first_name`
        )
        .all(classId);

    return students.map((s) => {
        const practice = getStudentPracticeSummary(s.id);
        const sessions = getStudentSessionSummary(s.id);
        const testRow = sessions.find((r) => r.type === 'test');
        return {
            studentId: s.id,
            username: s.username,
            firstName: s.first_name,
            lastName: s.last_name,
            rank: s.rank,
            practiceAttemptCount: practice.attemptCount,
            practiceAvgAccuracy: practice.avgAccuracy,
            testSessionCount: testRow ? testRow.sessionCount : 0,
            testAvgScore: testRow ? testRow.avgScore : null,
            testPassRatePercent: testRow ? testRow.passRatePercent : null,
        };
    });
}

module.exports = {
    getStudentPracticeSummary,
    getStudentAccuracyByDay,
    getStudentSessionSummary,
    getClassStudentIds,
    getClassPracticeSummary,
    getClassSessionSummary,
    getClassStudentBreakdown,
};
