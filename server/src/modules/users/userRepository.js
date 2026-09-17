/**
 * Data-access layer for the `users` table. No HTTP concerns here — just
 * SQL. Controllers call into this module rather than touching the DB
 * directly, so the query shape stays in one place.
 */
const db = require('../../db/client');

function toPublicUser(row) {
    if (!row) return null;
    return {
        id: row.id,
        username: row.username,
        role: row.role,
        rank: row.rank,
        firstName: row.first_name,
        lastName: row.last_name,
        classId: row.class_id,
        className: row.class_name || undefined,
        isActive: !!row.is_active,
        createdAt: row.created_at,
    };
}

function findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findByIdPublic(id) {
    const row = db
        .prepare(
            `SELECT users.*, classes.name AS class_name
             FROM users LEFT JOIN classes ON classes.id = users.class_id
             WHERE users.id = ?`
        )
        .get(id);
    return toPublicUser(row);
}

function countByRole(role) {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users WHERE role = ?').get(role);
    return row.count;
}

function listAllPublic() {
    const rows = db
        .prepare(
            `SELECT users.*, classes.name AS class_name
             FROM users LEFT JOIN classes ON classes.id = users.class_id
             ORDER BY users.role, users.last_name, users.first_name`
        )
        .all();
    return rows.map(toPublicUser);
}

/**
 * Flexible search/filter for the teacher's student (or user) list.
 * All filters are optional and combine with AND.
 *   role:     'teacher' | 'student'
 *   search:   free-text match against username/first/last name/rank
 *   classId:  number | null (null = students with no class assigned)
 *   status:   'active' | 'inactive' | 'all' (default 'all')
 */
function search({ role, search: searchText, classId, status } = {}) {
    let sql = `SELECT users.*, classes.name AS class_name
               FROM users LEFT JOIN classes ON classes.id = users.class_id
               WHERE 1 = 1`;
    const params = [];

    if (role) {
        sql += ' AND users.role = ?';
        params.push(role);
    }
    if (classId !== undefined) {
        if (classId === null) {
            sql += ' AND users.class_id IS NULL';
        } else {
            sql += ' AND users.class_id = ?';
            params.push(classId);
        }
    }
    if (status === 'active') {
        sql += ' AND users.is_active = 1';
    } else if (status === 'inactive') {
        sql += ' AND users.is_active = 0';
    }
    if (searchText) {
        sql += ` AND (users.username LIKE ? OR users.first_name LIKE ?
                       OR users.last_name LIKE ? OR users.rank LIKE ?)`;
        const like = `%${searchText}%`;
        params.push(like, like, like, like);
    }

    sql += ' ORDER BY users.last_name, users.first_name';

    const rows = db.prepare(sql).all(...params);
    return rows.map(toPublicUser);
}

function createUser({ username, passwordHash, role, rank, firstName, lastName, classId, isActive = true }) {
    const info = db
        .prepare(
            `INSERT INTO users (username, password_hash, role, rank, first_name, last_name, class_id, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(username, passwordHash, role, rank || null, firstName || null, lastName || null, classId || null, isActive ? 1 : 0);
    return findByIdPublic(info.lastInsertRowid);
}

function setActive(id, isActive) {
    const info = db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
    if (info.changes === 0) return null;
    return findByIdPublic(id);
}

/**
 * Updates a subset of editable profile fields. Only keys actually present
 * on `fields` are touched, so callers can send a partial patch.
 * Supported keys: rank, firstName, lastName, classId, username.
 */
function updateUser(id, fields) {
    const columnByKey = {
        rank: 'rank',
        firstName: 'first_name',
        lastName: 'last_name',
        classId: 'class_id',
        username: 'username',
    };

    const setClauses = [];
    const params = [];
    for (const [key, column] of Object.entries(columnByKey)) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
            setClauses.push(`${column} = ?`);
            params.push(fields[key]);
        }
    }

    if (setClauses.length === 0) {
        return findByIdPublic(id);
    }

    params.push(id);
    const info = db.prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    if (info.changes === 0) return null;
    return findByIdPublic(id);
}

function updatePasswordHash(id, passwordHash) {
    const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    return info.changes > 0;
}

/** Number of users (any role/status) currently assigned to a class. */
function countInClass(classId) {
    const row = db.prepare('SELECT COUNT(*) AS count FROM users WHERE class_id = ?').get(classId);
    return row.count;
}

module.exports = {
    toPublicUser,
    findByUsername,
    findById,
    findByIdPublic,
    countByRole,
    listAllPublic,
    search,
    createUser,
    setActive,
    updateUser,
    updatePasswordHash,
    countInClass,
};
