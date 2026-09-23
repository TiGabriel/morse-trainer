const statsRepository = require('./statsRepository');
const classRepository = require('../classes/classRepository');
const userRepository = require('../users/userRepository');
const practiceRepository = require('../practice/practiceRepository');
const logger = require('../../logger');
const { toCsvLines } = require('./csv');

const EXERCISE_TYPE_LABELS = {
    audio_to_text: 'Reception (Audio to Text)',
    morse_to_text: 'Morse to Text',
    text_to_morse: 'Transmission',
    character_recognition: 'Character Recognition',
    radiogram_training: 'Radiogram Training',
    character_training: 'Character Training',
};
const VALID_HISTORY_EXERCISE_TYPES = Object.keys(EXERCISE_TYPE_LABELS);

function toNumberOrUndefined(v) {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** Shared history/export filter parsing — an invalid exerciseType/direction is silently ignored (falls back to "no filter") rather than erroring, same as the student-facing /api/practice/history endpoint. */
function parseHistoryFilters(query) {
    return {
        exerciseType: VALID_HISTORY_EXERCISE_TYPES.includes(query.exerciseType) ? query.exerciseType : undefined,
        direction: query.direction === 'reception' || query.direction === 'transmission' ? query.direction : undefined,
        since: typeof query.since === 'string' && query.since ? query.since : undefined,
        until: typeof query.until === 'string' && query.until ? query.until : undefined,
        minWpm: toNumberOrUndefined(query.minWpm),
        maxWpm: toNumberOrUndefined(query.maxWpm),
    };
}

/** GET /api/stats/students/:id — teacher, or the student themselves (enforced by requireSelfOrTeacher in the route). */
function getStudentStats(req, res) {
    const studentId = Number(req.params.id);
    const user = userRepository.findById(studentId);
    if (!user || user.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
    }

    return res.json({
        practice: statsRepository.getStudentPracticeSummary(studentId),
        accuracyByDay: statsRepository.getStudentAccuracyByDay(studentId, { days: 14 }),
        sessions: statsRepository.getStudentSessionSummary(studentId),
        // Student's own History & Progress page (see stats.js) — a
        // teacher viewing the same endpoint for one of their students
        // gets these too, which is fine: a teacher is already allowed to
        // see everything about their own students that this endpoint's
        // other fields already expose.
        personalStats: statsRepository.getStudentPersonalStats(studentId),
        dailySeries: statsRepository.getStudentDailySeries(studentId, { days: 30 }),
        weakCharacters: statsRepository.getStudentWeakCharacters(studentId),
    });
}

/** GET /api/stats/classes/:id — teacher-only (enforced in the route). */
function getClassStats(req, res) {
    const classId = Number(req.params.id);
    const cls = classRepository.findById(classId);
    if (!cls) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    return res.json({
        className: cls.name,
        studentCount: statsRepository.getClassStudentIds(classId).length,
        practice: statsRepository.getClassPracticeSummary(classId),
        sessions: statsRepository.getClassSessionSummary(classId),
        students: statsRepository.getClassStudentBreakdown(classId),
    });
}

/**
 * GET /api/stats/students/:id/history — teacher result management: the
 * full, filterable, paginated per-exercise history (reception and
 * transmission both included, with timing data where the row has any).
 * Reuses the exact same practiceRepository.listForStudent/countForStudent
 * a student's own /api/practice/history calls — this is the teacher-
 * facing door into that same data, not a second history system. Access
 * is self-or-teacher (see the route), same as getStudentStats above.
 */
function getStudentHistory(req, res) {
    const studentId = Number(req.params.id);
    const user = userRepository.findById(studentId);
    if (!user || user.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
    }

    const limit = Math.min(Math.max(toNumberOrUndefined(req.query.limit) || 20, 1), 200);
    const offset = Math.max(toNumberOrUndefined(req.query.offset) || 0, 0);
    const filters = parseHistoryFilters(req.query);

    const attempts = practiceRepository.listForStudent(studentId, { limit, offset, ...filters });
    const total = practiceRepository.countForStudent(studentId, filters);
    return res.json({ attempts, total, limit, offset });
}

/**
 * DELETE /api/stats/students/:id/history/:attemptId — teacher-only
 * (enforced in the route; students can never reach this endpoint at
 * all, regardless of whose id is in the URL). Deletes exactly one
 * practice attempt. Scoped to formal-test/session results are
 * deliberately NOT deletable here — those represent official grades and
 * already have their own teacher-authoritative session controls; this
 * only ever touches ungraded individual practice history.
 */
function deleteStudentAttempt(req, res) {
    const studentId = Number(req.params.id);
    const attemptId = Number(req.params.attemptId);

    const deleted = practiceRepository.deleteAttempt(attemptId, studentId);
    if (!deleted) {
        return res.status(404).json({ error: 'Attempt not found for this student.' });
    }

    logger.info(`Practice attempt deleted: id=${attemptId} student=${studentId} by teacher "${req.user.username}"`);
    return res.json({ deleted: true, attemptId });
}

/**
 * DELETE /api/stats/students/:id/history — teacher-only bulk "reset
 * training history". Optionally narrowed by the same filters the history
 * view/export use (e.g. reset only Transmission results, or only results
 * before a given date); omitting every filter deletes the student's
 * entire practice history. The client is expected to have already
 * confirmed this with the teacher — there is no further server-side
 * confirmation step, the same as every other destructive teacher action
 * in this app (e.g. cancelling a session).
 */
function resetStudentHistory(req, res) {
    const studentId = Number(req.params.id);
    const user = userRepository.findById(studentId);
    if (!user || user.role !== 'student') {
        return res.status(404).json({ error: 'Student not found.' });
    }

    const filters = parseHistoryFilters(req.query);
    const deletedCount = practiceRepository.deleteForStudent(studentId, filters);
    logger.info(`Practice history reset: student=${studentId} deletedCount=${deletedCount} by teacher "${req.user.username}"`);
    return res.json({ deletedCount });
}

/**
 * GET /api/stats/classes/:id/attempts — teacher-only, class-wide
 * (optionally single-student-narrowed) filterable/paginated result
 * browser — "select a student, select exercise type, view results"
 * without leaving the class view. Same underlying data/filters as
 * getStudentHistory, just spanning every student in the class.
 */
function getClassAttempts(req, res) {
    const classId = Number(req.params.id);
    const cls = classRepository.findById(classId);
    if (!cls) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    const studentId = toNumberOrUndefined(req.query.studentId);
    const limit = Math.min(Math.max(toNumberOrUndefined(req.query.limit) || 20, 1), 200);
    const offset = Math.max(toNumberOrUndefined(req.query.offset) || 0, 0);
    const filters = parseHistoryFilters(req.query);

    const attempts = statsRepository.getTeacherAttempts({ classId, studentId, ...filters, limit, offset });
    const total = statsRepository.countTeacherAttempts({ classId, studentId, ...filters });
    return res.json({ attempts, total, limit, offset });
}

/**
 * GET /api/stats/classes/:id/export.csv — teacher-only CSV export
 * (Excel-compatible: UTF-8 BOM + comma-separated, see csv.js), for the
 * whole class or narrowed to one student, with the same filters as the
 * result browser. No PDF export — this codebase has no existing PDF
 * generation architecture to reuse, and the brief prioritizes CSV/print
 * in that case; printable results are instead handled client-side via
 * the browser's own print dialog against the on-screen results table.
 */
function exportClassCsv(req, res) {
    const classId = Number(req.params.id);
    const cls = classRepository.findById(classId);
    if (!cls) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    const studentId = toNumberOrUndefined(req.query.studentId);
    const filters = parseHistoryFilters(req.query);
    const rows = statsRepository.getTeacherAttempts({ classId, studentId, ...filters });

    const headers = [
        'Student',
        'Username',
        'Class',
        'Date/Time',
        'Exercise Type',
        'Direction',
        'WPM',
        'Correct',
        'Errors',
        'Accuracy %',
        'Grade',
        'Actual WPM (Transmission)',
        'Rhythm Consistency % (Transmission)',
    ];
    const toCsvRow = (r) => [
        [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username,
        r.username,
        r.className,
        r.createdAt,
        EXERCISE_TYPE_LABELS[r.exerciseType] || r.exerciseType,
        r.direction || '',
        r.wpm ?? '',
        r.correctCount,
        r.errorCount,
        r.accuracyPercent,
        r.characterGrade ? r.characterGrade.grade : '',
        r.timingStats ? r.timingStats.actualWpm ?? '' : '',
        r.timingStats ? r.timingStats.rhythmConsistencyPercent ?? '' : '',
    ];

    // Laid out as a class REPORT rather than one flat block: a short
    // report header, then one clearly separated section per student
    // (a "Student:" heading line with that student's result count, the
    // column headers repeated, that student's rows newest-first, and a
    // blank separator line). Every row still carries exactly the same
    // columns/values as before — this only groups and spaces them, so
    // the file stays sortable/filterable in Excel.
    const byStudent = new Map();
    rows.forEach((r) => {
        if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
        byStudent.get(r.studentId).push(r);
    });
    const displayName = (r) => [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username;
    const sortKey = (r) => `${r.lastName || ''} ${r.firstName || ''} ${r.username}`.toLowerCase();
    const studentGroups = [...byStudent.values()].sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0])));

    const lines = [
        ['Class Report', cls.name],
        ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
        ['Students', studentGroups.length],
        ['Results', rows.length],
        [],
    ];
    if (studentGroups.length === 0) {
        lines.push(headers, []);
    }
    studentGroups.forEach((group) => {
        const first = group[0];
        lines.push([`Student: ${displayName(first)}`, first.username, first.className, `Results: ${group.length}`]);
        lines.push(headers);
        group.forEach((r) => lines.push(toCsvRow(r)));
        lines.push([]);
    });

    const csv = toCsvLines(lines);
    const filenameSafe = cls.name.replace(/[^a-z0-9]+/gi, '_');
    const studentSuffix = studentId ? `-student${studentId}` : '';

    logger.info(`CSV export: class=${classId}${studentId ? ` student=${studentId}` : ''} rows=${rows.length} by teacher "${req.user.username}"`);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="morse-results-${filenameSafe}${studentSuffix}.csv"`);
    return res.send(csv);
}

module.exports = {
    getStudentStats,
    getClassStats,
    getStudentHistory,
    deleteStudentAttempt,
    resetStudentHistory,
    getClassAttempts,
    exportClassCsv,
};
