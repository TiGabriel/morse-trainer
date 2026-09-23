/**
 * Data-access layer for the electronic gradebook ("Catalog electronic").
 * No HTTP concerns here — same pattern as users/userRepository.js and
 * sessions/sessionRepository.js. See schema.sql's `gradebook_entries`
 * comment for the manual vs. formal_test / temporary vs. permanent model.
 */
const db = require('../../db/client');

const ENTRY_TYPES = ['grade', 'note'];

function toPublicEntry(row) {
    if (!row) return null;
    let details = null;
    if (row.details_json) {
        try {
            details = JSON.parse(row.details_json);
        } catch {
            details = null;
        }
    }
    return {
        id: row.id,
        studentId: row.student_id,
        teacherId: row.teacher_id,
        teacherName: [row.teacher_first_name, row.teacher_last_name].filter(Boolean).join(' ') || row.teacher_username || null,
        type: row.entry_type,
        grade: row.grade,
        note: row.note,
        source: row.source,
        sourceSessionId: row.source_session_id,
        details,
        isPermanent: !!row.is_permanent,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const ENTRY_SELECT = `
    SELECT gradebook_entries.*,
           teachers.username AS teacher_username,
           teachers.first_name AS teacher_first_name,
           teachers.last_name AS teacher_last_name
    FROM gradebook_entries
    LEFT JOIN users AS teachers ON teachers.id = gradebook_entries.teacher_id
`;

function findById(id) {
    return toPublicEntry(db.prepare(`${ENTRY_SELECT} WHERE gradebook_entries.id = ?`).get(id));
}

/** Newest first — temporary (still-to-confirm) entries are shown by the UI in their own group, not re-ordered here. */
function listForStudent(studentId) {
    return db
        .prepare(`${ENTRY_SELECT} WHERE gradebook_entries.student_id = ? ORDER BY gradebook_entries.created_at DESC, gradebook_entries.id DESC`)
        .all(studentId)
        .map(toPublicEntry);
}

/** Per-student count of temporary (unconfirmed) automatic entries — lets the student picker flag who has something waiting for review. */
function countPendingByStudent() {
    const rows = db
        .prepare('SELECT student_id, COUNT(*) AS count FROM gradebook_entries WHERE is_permanent = 0 GROUP BY student_id')
        .all();
    return Object.fromEntries(rows.map((r) => [r.student_id, r.count]));
}

/** A manually written grade or note — permanent from the moment it's saved (the teacher typed it in deliberately). */
function createManualEntry({ studentId, teacherId, type, grade, note }) {
    const info = db
        .prepare(
            `INSERT INTO gradebook_entries (student_id, teacher_id, entry_type, grade, note, source, is_permanent)
             VALUES (?, ?, ?, ?, ?, 'manual', 1)`
        )
        .run(studentId, teacherId, type, grade ?? null, note || null);
    return findById(info.lastInsertRowid);
}

/**
 * An automatic, TEMPORARY Formal Test entry. INSERT OR IGNORE against
 * the partial unique index on (student_id, source_session_id) WHERE
 * source = 'formal_test' — so calling this twice for the same
 * student/test is a harmless no-op, never a duplicate row.
 * @returns {boolean} whether a new row was actually inserted
 */
function insertFormalTestEntry({ studentId, teacherId, sessionId, grade, note, details }) {
    const info = db
        .prepare(
            `INSERT OR IGNORE INTO gradebook_entries
                 (student_id, teacher_id, entry_type, grade, note, source, source_session_id, details_json, is_permanent)
             VALUES (?, ?, 'grade', ?, ?, 'formal_test', ?, ?, 0)`
        )
        .run(studentId, teacherId ?? null, grade ?? null, note || null, sessionId, details ? JSON.stringify(details) : null);
    return info.changes > 0;
}

function updateEntry(id, { grade, note }) {
    const fields = [];
    const params = [];
    if (grade !== undefined) {
        fields.push('grade = ?');
        params.push(grade);
    }
    if (note !== undefined) {
        fields.push('note = ?');
        params.push(note || null);
    }
    if (fields.length === 0) return findById(id);
    fields.push("updated_at = datetime('now')");
    db.prepare(`UPDATE gradebook_entries SET ${fields.join(', ')} WHERE id = ?`).run(...params, id);
    return findById(id);
}

/** Temporary -> permanent. One-way: a permanent entry never goes back to temporary. */
function markPermanent(id) {
    db.prepare("UPDATE gradebook_entries SET is_permanent = 1, updated_at = datetime('now') WHERE id = ?").run(id);
    return findById(id);
}

function deleteEntry(id) {
    return db.prepare('DELETE FROM gradebook_entries WHERE id = ?').run(id).changes > 0;
}

module.exports = {
    ENTRY_TYPES,
    findById,
    listForStudent,
    countPendingByStudent,
    createManualEntry,
    insertFormalTestEntry,
    updateEntry,
    markPermanent,
    deleteEntry,
};
