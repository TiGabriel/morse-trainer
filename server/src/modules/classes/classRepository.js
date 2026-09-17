const db = require('../../db/client');

function toPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        isActive: !!row.is_active,
        studentCount: row.student_count !== undefined ? row.student_count : undefined,
        createdAt: row.created_at,
    };
}

/** Lists classes, each annotated with how many users currently reference it. */
function listAll() {
    const rows = db
        .prepare(
            `SELECT classes.*, COUNT(users.id) AS student_count
             FROM classes
             LEFT JOIN users ON users.class_id = classes.id
             GROUP BY classes.id
             ORDER BY classes.name`
        )
        .all();
    return rows.map(toPublic);
}

function findByName(name) {
    return db.prepare('SELECT * FROM classes WHERE name = ?').get(name);
}

function findById(id) {
    return db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
}

function findByIdPublic(id) {
    const row = db
        .prepare(
            `SELECT classes.*, COUNT(users.id) AS student_count
             FROM classes
             LEFT JOIN users ON users.class_id = classes.id
             WHERE classes.id = ?
             GROUP BY classes.id`
        )
        .get(id);
    return toPublic(row);
}

function create(name) {
    const info = db.prepare('INSERT INTO classes (name) VALUES (?)').run(name);
    return findByIdPublic(info.lastInsertRowid);
}

function rename(id, name) {
    const info = db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) return null;
    return findByIdPublic(id);
}

function setActive(id, isActive) {
    const info = db.prepare('UPDATE classes SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
    if (info.changes === 0) return null;
    return findByIdPublic(id);
}

function remove(id) {
    const info = db.prepare('DELETE FROM classes WHERE id = ?').run(id);
    return info.changes > 0;
}

module.exports = { listAll, findByName, findById, findByIdPublic, create, rename, setActive, remove, toPublic };
