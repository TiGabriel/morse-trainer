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
const engine = require('../morse-engine');
const gradingService = require('../grading/gradingService');
const { RECEPTION_EXERCISE_TYPES, TRANSMISSION_EXERCISE_TYPES, exerciseDirection } = require('../practice/practiceRepository');

/** Rounds to 2 decimal places, or returns null for "no data" rather than 0/NaN — a student with zero attempts has no average, not a 0% average. */
function round2(value) {
    return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

/** A SQL CASE expression classifying exercise_type into 'reception'/'transmission' — the exact same classification practiceRepository.exerciseDirection uses for a single row, expressed once here for use inside aggregate SQL (AVG(CASE WHEN ...), SUM(CASE WHEN ...), etc.) rather than re-deriving it in JS per row. */
const DIRECTION_CASE_SQL = `CASE WHEN exercise_type IN (${TRANSMISSION_EXERCISE_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'transmission' WHEN exercise_type IN (${RECEPTION_EXERCISE_TYPES.map((t) => `'${t}'`).join(', ')}) THEN 'reception' ELSE NULL END`;

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

/**
 * Daily time series for the student's own History & Progress graphs
 * (accuracy/WPM/errors over time, reception vs transmission) — each
 * day's own average, never interpolated or smoothed across gaps, so a
 * quiet week reads as a genuine gap rather than a fabricated flat line.
 */
function getStudentDailySeries(studentId, { days = 30 } = {}) {
    const rows = db
        .prepare(
            `SELECT date(created_at) AS day,
                    COUNT(*) AS count,
                    AVG(accuracy_percent) AS avg_accuracy,
                    AVG(wpm) AS avg_wpm,
                    SUM(incorrect_count + missing_count + extra_count) AS total_errors,
                    AVG(CASE WHEN ${DIRECTION_CASE_SQL} = 'reception' THEN accuracy_percent END) AS reception_avg_accuracy,
                    AVG(CASE WHEN ${DIRECTION_CASE_SQL} = 'transmission' THEN accuracy_percent END) AS transmission_avg_accuracy
             FROM practice_attempts
             WHERE student_id = ? AND date(created_at) >= date('now', ?)
             GROUP BY day
             ORDER BY day ASC`
        )
        .all(studentId, `-${days} days`);
    return rows.map((row) => ({
        day: row.day,
        count: row.count,
        avgAccuracy: round2(row.avg_accuracy),
        avgWpm: row.avg_wpm === null ? null : Math.round(row.avg_wpm * 10) / 10,
        totalErrors: row.total_errors || 0,
        receptionAvgAccuracy: round2(row.reception_avg_accuracy),
        transmissionAvgAccuracy: round2(row.transmission_avg_accuracy),
    }));
}

/** Narrower accuracy-only view over the same series, kept for the existing teacher-facing per-student detail table — unchanged shape/behavior, just derived from getStudentDailySeries now instead of its own separate query. */
function getStudentAccuracyByDay(studentId, { days = 14 } = {}) {
    return getStudentDailySeries(studentId, { days }).map((row) => ({ day: row.day, count: row.count, avgAccuracy: row.avgAccuracy }));
}

/** Whole-history personal totals for the student's own History & Progress page — reception/transmission split via the same DIRECTION_CASE_SQL classification used everywhere else in this module. Null averages (not 0) for a student with no data of a given kind yet. */
function getStudentPersonalStats(studentId) {
    const row = db
        .prepare(
            `SELECT
                COUNT(*) AS count,
                AVG(accuracy_percent) AS avg_accuracy,
                MAX(accuracy_percent) AS best_accuracy,
                AVG(wpm) AS avg_wpm,
                MAX(wpm) AS best_wpm,
                SUM(incorrect_count + missing_count + extra_count) AS total_errors,
                SUM(CASE WHEN ${DIRECTION_CASE_SQL} = 'reception' THEN 1 ELSE 0 END) AS reception_count,
                AVG(CASE WHEN ${DIRECTION_CASE_SQL} = 'reception' THEN accuracy_percent END) AS reception_avg_accuracy,
                SUM(CASE WHEN ${DIRECTION_CASE_SQL} = 'transmission' THEN 1 ELSE 0 END) AS transmission_count,
                AVG(CASE WHEN ${DIRECTION_CASE_SQL} = 'transmission' THEN accuracy_percent END) AS transmission_avg_accuracy
             FROM practice_attempts WHERE student_id = ?`
        )
        .get(studentId);

    return {
        totalExercises: row.count,
        avgAccuracy: round2(row.avg_accuracy),
        bestAccuracy: row.best_accuracy,
        avgWpm: row.avg_wpm === null ? null : Math.round(row.avg_wpm * 10) / 10,
        bestWpm: row.best_wpm,
        totalErrors: row.total_errors || 0,
        receptionCount: row.reception_count || 0,
        receptionAvgAccuracy: round2(row.reception_avg_accuracy),
        transmissionCount: row.transmission_count || 0,
        transmissionAvgAccuracy: round2(row.transmission_avg_accuracy),
    };
}

// A character is only ever reported as "weak" once it has this many
// scored occurrences across the student's whole history — a single bad
// attempt says nothing reliable about one character. Same threshold
// family as Character Training's own in-session weak-character detector
// (see client/public/js/practice.js's WEAK_ACCURACY_THRESHOLD) — 80%
// accuracy is what "repeatedly causing problems" means throughout this
// app, not a new number invented for history specifically.
const WEAK_CHARACTER_MIN_ATTEMPTS = 3;
const WEAK_CHARACTER_ACCURACY_THRESHOLD = 80;

/**
 * Character-level weak-area analysis, derived entirely from data already
 * stored — practice_attempts never persisted a per-character breakdown
 * (only per-attempt aggregate counts), so this re-runs the exact same
 * alignment-based scoreAnswer() every submit handler already used, once
 * per historical row, and tallies the results per character across the
 * student's whole history. Not a second scoring system: the only "new"
 * logic here is the tally itself.
 */
function getStudentWeakCharacters(studentId, { minAttempts = WEAK_CHARACTER_MIN_ATTEMPTS, accuracyThreshold = WEAK_CHARACTER_ACCURACY_THRESHOLD, limit = 15 } = {}) {
    const rows = db.prepare('SELECT expected_answer, submitted_answer FROM practice_attempts WHERE student_id = ?').all(studentId);

    const byChar = new Map();
    rows.forEach((row) => {
        const expected = (row.expected_answer || '').replace(/\s+/g, '');
        const submitted = (row.submitted_answer || '').replace(/\s+/g, '');
        if (!expected) return;

        let score;
        try {
            score = engine.scoreAnswer(expected, submitted);
        } catch {
            return; // a malformed/oversized historical row is skipped, not allowed to break the whole page
        }

        score.ops.forEach((op) => {
            if (op.type === 'extra') return; // an inserted character has no real target character to blame
            const ch = op.expectedChar;
            if (!ch) return;
            if (!byChar.has(ch)) byChar.set(ch, { char: ch, attempts: 0, correct: 0, errors: 0 });
            const entry = byChar.get(ch);
            entry.attempts += 1;
            if (op.type === 'match') entry.correct += 1;
            else entry.errors += 1;
        });
    });

    return [...byChar.values()]
        .map((entry) => ({ ...entry, accuracyPercent: round2((entry.correct / entry.attempts) * 100) }))
        .filter((entry) => entry.attempts >= minAttempts && entry.accuracyPercent < accuracyThreshold)
        .sort((a, b) => a.accuracyPercent - b.accuracyPercent || b.attempts - a.attempts)
        .slice(0, limit);
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

// ---------------------------------------------------------------------
// Teacher result management: cross-student browsing/export over
// practice_attempts (see practiceRepository.js for the per-student
// version this mirrors — this one additionally joins in student/class
// identity and can span an entire class, which a single student's own
// history view never needs to).
// ---------------------------------------------------------------------

/** Builds the shared WHERE clause + params for a teacher-facing, class-scoped (optionally student-narrowed) view over practice_attempts. classId is always required — an unscoped "every class" query is deliberately not offered, the same way getClassStats already requires one. */
function buildTeacherAttemptsFilter({ classId, studentId, exerciseType, direction, since, until, minWpm, maxWpm }) {
    const clauses = ['users.class_id = ?', "users.role = 'student'"];
    const params = [classId];

    if (studentId) {
        clauses.push('practice_attempts.student_id = ?');
        params.push(studentId);
    }
    if (exerciseType) {
        clauses.push('practice_attempts.exercise_type = ?');
        params.push(exerciseType);
    }
    if (direction === 'reception' || direction === 'transmission') {
        const types = direction === 'transmission' ? TRANSMISSION_EXERCISE_TYPES : RECEPTION_EXERCISE_TYPES;
        clauses.push(`practice_attempts.exercise_type IN (${types.map(() => '?').join(', ')})`);
        params.push(...types);
    }
    if (since) {
        clauses.push('date(practice_attempts.created_at) >= date(?)');
        params.push(since);
    }
    if (until) {
        clauses.push('date(practice_attempts.created_at) <= date(?)');
        params.push(until);
    }
    if (Number.isFinite(minWpm)) {
        clauses.push('practice_attempts.wpm >= ?');
        params.push(minWpm);
    }
    if (Number.isFinite(maxWpm)) {
        clauses.push('practice_attempts.wpm <= ?');
        params.push(maxWpm);
    }

    return { where: clauses.join(' AND '), params };
}

/**
 * Teacher-facing, cross-student attempt list for the class/student result
 * browser and CSV export — same underlying practice_attempts rows and
 * same grading/direction derivation as a student's own history
 * (practiceRepository.toPublic), just joined with who-it-belongs-to and
 * able to span a whole class at once. `limit`/`offset` are optional —
 * omitted entirely for a CSV export (which wants everything matching the
 * filters, not one page of it).
 */
function getTeacherAttempts({ classId, studentId, exerciseType, direction, since, until, minWpm, maxWpm, limit, offset } = {}) {
    const { where, params } = buildTeacherAttemptsFilter({ classId, studentId, exerciseType, direction, since, until, minWpm, maxWpm });
    let sql = `
        SELECT practice_attempts.*, users.username, users.first_name, users.last_name, classes.name AS class_name
        FROM practice_attempts
        JOIN users ON users.id = practice_attempts.student_id
        JOIN classes ON classes.id = users.class_id
        WHERE ${where}
        ORDER BY practice_attempts.created_at DESC, practice_attempts.id DESC
    `;
    const finalParams = [...params];
    if (Number.isFinite(limit)) {
        sql += ' LIMIT ? OFFSET ?';
        finalParams.push(limit, Math.max(offset || 0, 0));
    }

    const rows = db.prepare(sql).all(...finalParams);
    return rows.map((row) => {
        const total = row.correct_count + row.incorrect_count + row.missing_count;
        return {
            id: row.id,
            studentId: row.student_id,
            username: row.username,
            firstName: row.first_name,
            lastName: row.last_name,
            className: row.class_name,
            exerciseType: row.exercise_type,
            direction: exerciseDirection(row.exercise_type),
            wpm: row.wpm,
            correctCount: row.correct_count,
            incorrectCount: row.incorrect_count,
            missingCount: row.missing_count,
            extraCount: row.extra_count,
            accuracyPercent: row.accuracy_percent,
            errorCount: row.incorrect_count + row.missing_count + row.extra_count,
            characterGrade: total > 0 ? gradingService.calculateGrade({ correct: row.correct_count, total }) : null,
            durationMs: row.duration_ms,
            timingStats: row.timing_stats_json ? JSON.parse(row.timing_stats_json) : null,
            createdAt: row.created_at,
        };
    });
}

function countTeacherAttempts({ classId, studentId, exerciseType, direction, since, until, minWpm, maxWpm } = {}) {
    const { where, params } = buildTeacherAttemptsFilter({ classId, studentId, exerciseType, direction, since, until, minWpm, maxWpm });
    return db
        .prepare(`SELECT COUNT(*) AS count FROM practice_attempts JOIN users ON users.id = practice_attempts.student_id WHERE ${where}`)
        .get(...params).count;
}

module.exports = {
    getStudentPracticeSummary,
    getStudentAccuracyByDay,
    getStudentDailySeries,
    getStudentPersonalStats,
    getStudentWeakCharacters,
    getStudentSessionSummary,
    getClassStudentIds,
    getClassPracticeSummary,
    getClassSessionSummary,
    getClassStudentBreakdown,
    getTeacherAttempts,
    countTeacherAttempts,
};
