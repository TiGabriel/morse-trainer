/**
 * Data-access layer for group/formal-test sessions. No HTTP/WebSocket
 * concerns here — controllers and the realtime hub call into this module,
 * same pattern as `users/userRepository.js` and `classes/classRepository.js`.
 */
const db = require('../../db/client');

function toPublicSession(row) {
    if (!row) return null;
    return {
        id: row.id,
        classId: row.class_id,
        className: row.class_name || undefined,
        type: row.type,
        status: row.status,
        exerciseMode: row.exercise_mode,
        difficulty: row.difficulty,
        wpm: row.wpm,
        farnsworthWpm: row.farnsworth_wpm,
        toneFrequencyHz: row.tone_frequency_hz,
        exerciseCount: row.exercise_count,
        prepTimeMs: row.prep_time_ms,
        answerTimeMs: row.answer_time_ms,
        allowedAttempts: row.allowed_attempts,
        passThresholdPercent: row.pass_threshold_percent,
        currentItemIndex: row.current_item_index,
        instructions: row.instructions || null,
        participantIds: row.participant_ids_json ? JSON.parse(row.participant_ids_json) : null,
        itemLength: row.item_length,
        createdBy: row.created_by,
        openedAt: row.opened_at,
        startedAt: row.started_at,
        pausedAt: row.paused_at,
        endedAt: row.ended_at,
        createdAt: row.created_at,
    };
}

function toPublicItem(row) {
    if (!row) return null;
    return {
        id: row.id,
        sessionId: row.session_id,
        radiogramId: row.radiogram_id,
        orderIndex: row.order_index,
        exercise: JSON.parse(row.exercise_json),
    };
}

const SESSION_SELECT = `
    SELECT sessions.*, classes.name AS class_name
    FROM sessions
    LEFT JOIN classes ON classes.id = sessions.class_id
`;

function findById(id) {
    return db.prepare(`${SESSION_SELECT} WHERE sessions.id = ?`).get(id);
}

function findByIdPublic(id) {
    return toPublicSession(findById(id));
}

function listByCreator(teacherId) {
    const rows = db
        .prepare(`${SESSION_SELECT} WHERE sessions.created_by = ? ORDER BY sessions.created_at DESC, sessions.id DESC`)
        .all(teacherId);
    return rows.map(toPublicSession);
}

/**
 * Sessions a given student may currently join/see: their class's
 * waiting/running/paused sessions, narrowed further to only those whose
 * optional participant restriction (if any) includes this student. A
 * session with no restriction (the original default) is visible to the
 * whole class, unchanged from Phase 8.
 */
function listAvailableForStudent(studentId, classId) {
    const rows = db
        .prepare(
            `${SESSION_SELECT} WHERE sessions.class_id = ? AND sessions.status IN ('waiting', 'running', 'paused')
             ORDER BY sessions.created_at DESC, sessions.id DESC`
        )
        .all(classId);
    return rows
        .map(toPublicSession)
        .filter((s) => !s.participantIds || s.participantIds.length === 0 || s.participantIds.includes(studentId));
}

/** Narrows a teacher-submitted participant list down to real, active students actually in the given class — silently drops anything else rather than trusting client-supplied ids outright. */
function validateParticipantIds(classId, candidateIds) {
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) return [];
    const placeholders = candidateIds.map(() => '?').join(', ');
    const rows = db
        .prepare(
            `SELECT id FROM users WHERE class_id = ? AND role = 'student' AND is_active = 1 AND id IN (${placeholders})`
        )
        .all(classId, ...candidateIds);
    return rows.map((r) => r.id);
}

function createSession(data) {
    const info = db
        .prepare(
            `INSERT INTO sessions (
                class_id, type, exercise_mode, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                exercise_count, prep_time_ms, answer_time_ms, allowed_attempts, pass_threshold_percent,
                instructions, participant_ids_json, item_length, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            data.classId,
            data.type,
            data.exerciseMode,
            data.difficulty,
            data.wpm || null,
            data.farnsworthWpm || null,
            data.toneFrequencyHz || null,
            data.exerciseCount,
            data.prepTimeMs,
            data.answerTimeMs === undefined ? null : data.answerTimeMs,
            data.allowedAttempts,
            data.passThresholdPercent === undefined ? null : data.passThresholdPercent,
            data.instructions || null,
            data.participantIds && data.participantIds.length > 0 ? JSON.stringify(data.participantIds) : null,
            data.itemLength === undefined ? null : data.itemLength,
            data.createdBy
        );
    return findByIdPublic(info.lastInsertRowid);
}

/**
 * Persists the pre-generated exercise set: one `radiograms` row per item
 * (for the audit trail the schema was designed around) plus the matching
 * `session_items` row carrying the full exercise JSON every participant
 * will receive verbatim.
 */
const insertItemsTxn = db.transaction((sessionId, teacherId, items) => {
    const insertRadiogram = db.prepare(
        `INSERT INTO radiograms (source_text, generated_or_manual, created_by) VALUES (?, 'generated', ?)`
    );
    const insertItem = db.prepare(
        `INSERT INTO session_items (session_id, radiogram_id, order_index, exercise_json) VALUES (?, ?, ?, ?)`
    );
    for (const item of items) {
        const radiogramInfo = insertRadiogram.run(item.exercise.text, teacherId);
        insertItem.run(sessionId, radiogramInfo.lastInsertRowid, item.orderIndex, JSON.stringify(item.exercise));
    }
});

function insertItems(sessionId, teacherId, items) {
    insertItemsTxn(sessionId, teacherId, items);
}

function listItems(sessionId) {
    const rows = db
        .prepare('SELECT * FROM session_items WHERE session_id = ? ORDER BY order_index ASC')
        .all(sessionId);
    return rows.map(toPublicItem);
}

function getItemByIndex(sessionId, orderIndex) {
    const row = db
        .prepare('SELECT * FROM session_items WHERE session_id = ? AND order_index = ?')
        .get(sessionId, orderIndex);
    return toPublicItem(row);
}

function getItemById(sessionId, itemId) {
    const row = db.prepare('SELECT * FROM session_items WHERE session_id = ? AND id = ?').get(sessionId, itemId);
    return toPublicItem(row);
}

function countItems(sessionId) {
    return db.prepare('SELECT COUNT(*) AS count FROM session_items WHERE session_id = ?').get(sessionId).count;
}

function setCurrentItemIndex(sessionId, itemIndex) {
    db.prepare('UPDATE sessions SET current_item_index = ? WHERE id = ?').run(itemIndex, sessionId);
}

/**
 * Atomically transitions a session's status, only if it is currently in
 * one of `expectedStatuses` — the DB-level enforcement half of the state
 * machine (sessionEngine.js decides *which* transition is legal; this
 * makes the write itself race-safe against a concurrent duplicate
 * request, e.g. two rapid clicks of "Start").
 */
function transitionStatus(id, expectedStatuses, newStatus, extraFields = {}) {
    const setClauses = ['status = ?'];
    const params = [newStatus];
    for (const [column, value] of Object.entries(extraFields)) {
        setClauses.push(`${column} = ?`);
        params.push(value);
    }
    params.push(id);
    const statusPlaceholders = expectedStatuses.map(() => '?').join(', ');
    params.push(...expectedStatuses);

    const sql = `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${statusPlaceholders})`;
    return db.prepare(sql).run(...params);
}

// ---------------------------------------------------------------------
// Participants / roster
// ---------------------------------------------------------------------

/**
 * Marks a student as connected to a session (creating the participant
 * row on first connect, per the schema's "a row here only exists once a
 * student has connected at least once" design). Readiness is untouched —
 * a reconnect should not silently un-ready someone the teacher already
 * saw as ready.
 */
function markParticipantConnected(sessionId, studentId) {
    db.prepare(
        `INSERT INTO session_participants (session_id, student_id, connection_status, joined_at, last_seen_at)
         VALUES (?, ?, 'connected', datetime('now'), datetime('now'))
         ON CONFLICT (session_id, student_id) DO UPDATE SET
            connection_status = 'connected',
            last_seen_at = datetime('now')`
    ).run(sessionId, studentId);
}

function markParticipantDisconnected(sessionId, studentId) {
    db.prepare(
        `UPDATE session_participants SET connection_status = 'disconnected', last_seen_at = datetime('now')
         WHERE session_id = ? AND student_id = ?`
    ).run(sessionId, studentId);
}

function setParticipantReady(sessionId, studentId, isReady) {
    db.prepare('UPDATE session_participants SET is_ready = ? WHERE session_id = ? AND student_id = ?').run(
        isReady ? 1 : 0,
        sessionId,
        studentId
    );
}

/**
 * The full roster for a session: every student in the session's class
 * (the eligible roster, derived live from `users` per the schema's
 * design), left-joined with their connection/readiness state if they've
 * ever connected. When `participantIds` is a non-empty array (a
 * teacher-restricted formal test), the roster narrows to just those
 * students — the whole point of restricting a test is that it isn't
 * meant for the rest of the class either.
 */
function listRoster(sessionId, classId, participantIds) {
    const restrict = Array.isArray(participantIds) && participantIds.length > 0;
    const rows = db
        .prepare(
            `SELECT users.id AS student_id, users.username, users.first_name, users.last_name, users.rank,
                    classes.name AS class_name,
                    COALESCE(sp.connection_status, 'disconnected') AS connection_status,
                    COALESCE(sp.is_ready, 0) AS is_ready,
                    sp.joined_at, sp.last_seen_at
             FROM users
             LEFT JOIN classes ON classes.id = users.class_id
             LEFT JOIN session_participants sp ON sp.session_id = ? AND sp.student_id = users.id
             WHERE users.class_id = ? AND users.role = 'student' AND users.is_active = 1
             ${restrict ? `AND users.id IN (${participantIds.map(() => '?').join(', ')})` : ''}
             ORDER BY users.last_name, users.first_name`
        )
        .all(sessionId, classId, ...(restrict ? participantIds : []));

    return rows.map((row) => ({
        studentId: row.student_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        rank: row.rank,
        className: row.class_name,
        connectionStatus: row.connection_status,
        isReady: !!row.is_ready,
        joinedAt: row.joined_at,
        lastSeenAt: row.last_seen_at,
    }));
}

/**
 * True if `studentId` is both in the session's class AND, when the
 * session restricts its participants to a specific subset (a formal
 * test not meant for the whole class), actually one of the selected
 * students. Every join/submit/results authorization check in this
 * module goes through this one function, so the restriction is
 * enforced everywhere consistently rather than needing to be repeated
 * at each call site.
 */
function isStudentInSessionClass(sessionId, studentId) {
    const row = db
        .prepare(
            `SELECT sessions.participant_ids_json AS participant_ids_json
             FROM sessions
             JOIN users ON users.class_id = sessions.class_id
             WHERE sessions.id = ? AND users.id = ? AND users.role = 'student'`
        )
        .get(sessionId, studentId);
    if (!row) return false;
    if (!row.participant_ids_json) return true;
    const participantIds = JSON.parse(row.participant_ids_json);
    return participantIds.length === 0 || participantIds.includes(studentId);
}

// ---------------------------------------------------------------------
// Attempts / results
// ---------------------------------------------------------------------

function toPublicAttempt(row) {
    if (!row) return null;
    return {
        id: row.id,
        sessionItemId: row.session_item_id,
        studentId: row.student_id,
        submittedText: row.submitted_text,
        submittedAt: row.submitted_at,
        durationMs: row.duration_ms,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
    };
}

function getAttempt(sessionItemId, studentId) {
    return toPublicAttempt(
        db.prepare('SELECT * FROM attempts WHERE session_item_id = ? AND student_id = ?').get(sessionItemId, studentId)
    );
}

/** Upserts the (single, latest) attempt row for a student+item and bumps its attempt_count. */
function upsertAttempt({ sessionItemId, studentId, submittedText, durationMs }) {
    db.prepare(
        `INSERT INTO attempts (session_item_id, student_id, submitted_text, submitted_at, duration_ms, attempt_count)
         VALUES (?, ?, ?, datetime('now'), ?, 1)
         ON CONFLICT (session_item_id, student_id) DO UPDATE SET
            submitted_text = excluded.submitted_text,
            submitted_at = datetime('now'),
            duration_ms = excluded.duration_ms,
            attempt_count = attempts.attempt_count + 1`
    ).run(sessionItemId, studentId, submittedText, durationMs === undefined ? null : durationMs);
    return getAttempt(sessionItemId, studentId);
}

function upsertResult({ attemptId, score, errorCount, grade }) {
    db.prepare(
        `INSERT INTO results (attempt_id, score, error_count, grade, graded_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (attempt_id) DO UPDATE SET
            score = excluded.score,
            error_count = excluded.error_count,
            grade = excluded.grade,
            graded_at = datetime('now')`
    ).run(attemptId, score, errorCount, grade);
}

/** Full per-item/per-student results for a session — teacher-facing. Narrowed to selected participants for a restricted formal test, same as the roster. */
function listResultsForSession(sessionId) {
    const session = findByIdPublic(sessionId);
    const restrict = session && Array.isArray(session.participantIds) && session.participantIds.length > 0;
    const rows = db
        .prepare(
            `SELECT session_items.order_index, session_items.id AS session_item_id,
                    users.id AS student_id, users.username, users.first_name, users.last_name,
                    attempts.submitted_text, attempts.submitted_at, attempts.duration_ms, attempts.attempt_count,
                    results.score, results.error_count, results.grade
             FROM session_items
             CROSS JOIN users
             LEFT JOIN attempts ON attempts.session_item_id = session_items.id AND attempts.student_id = users.id
             LEFT JOIN results ON results.attempt_id = attempts.id
             WHERE session_items.session_id = ?
               AND users.class_id = (SELECT class_id FROM sessions WHERE id = ?)
               AND users.role = 'student'
               ${restrict ? `AND users.id IN (${session.participantIds.map(() => '?').join(', ')})` : ''}
             ORDER BY session_items.order_index, users.last_name, users.first_name`
        )
        .all(sessionId, sessionId, ...(restrict ? session.participantIds : []));

    return rows.map((row) => ({
        orderIndex: row.order_index,
        sessionItemId: row.session_item_id,
        studentId: row.student_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name,
        submittedText: row.submitted_text,
        submittedAt: row.submitted_at,
        durationMs: row.duration_ms,
        attemptCount: row.attempt_count || 0,
        score: row.score,
        errorCount: row.error_count,
        grade: row.grade,
    }));
}

/** Same shape, filtered to one student's own rows — student-facing. */
function listResultsForStudent(sessionId, studentId) {
    return listResultsForSession(sessionId).filter((row) => row.studentId === studentId);
}

module.exports = {
    toPublicSession,
    toPublicItem,
    findById,
    findByIdPublic,
    listByCreator,
    listAvailableForStudent,
    validateParticipantIds,
    createSession,
    insertItems,
    listItems,
    getItemByIndex,
    getItemById,
    countItems,
    setCurrentItemIndex,
    transitionStatus,
    markParticipantConnected,
    markParticipantDisconnected,
    setParticipantReady,
    listRoster,
    isStudentInSessionClass,
    getAttempt,
    upsertAttempt,
    upsertResult,
    listResultsForSession,
    listResultsForStudent,
};
