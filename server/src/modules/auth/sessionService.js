/**
 * Server-side session management.
 *
 * A session token is a random 256-bit value. The RAW token is sent to the
 * browser only inside an HTTP-only cookie; the DATABASE stores only a
 * SHA-256 hash of it (in auth_sessions.token_hash). This means:
 *   - The server can always validate a token presented by a browser.
 *   - Reading the database alone never yields a usable session token.
 *   - Logout is immediate and real (the row is deleted), unlike a
 *     stateless JWT which stays valid until it expires no matter what.
 *
 * Sessions use a sliding expiration: every validated request pushes
 * expires_at forward by another full TTL window, so an active user is
 * never logged out mid-session, but an idle one eventually is.
 */
const crypto = require('crypto');
const db = require('../../db/client');
const config = require('../../config');

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function ttlExpiryDate() {
    return new Date(Date.now() + config.auth.sessionTtlHours * 60 * 60 * 1000).toISOString();
}

/**
 * Creates a new session for a user. Returns the RAW token — this is the
 * only time it is ever available; only its hash is persisted.
 */
function createSession(userId, { userAgent, ipAddress } = {}) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = ttlExpiryDate();

    db.prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, expires_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?)`
    ).run(tokenHash, userId, expiresAt, userAgent || null, ipAddress || null);

    return { rawToken, expiresAt };
}

/**
 * Validates a raw token from a cookie. Returns the session row + joined
 * user row if valid and not expired, or null otherwise. Also slides the
 * expiration forward and updates last_seen_at (sliding session).
 */
function validateAndRefresh(rawToken) {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);

    const row = db
        .prepare(
            `SELECT auth_sessions.*, users.id AS user_id, users.username, users.role,
                    users.rank, users.first_name, users.last_name, users.class_id,
                    users.is_active
             FROM auth_sessions
             JOIN users ON users.id = auth_sessions.user_id
             WHERE auth_sessions.token_hash = ?`
        )
        .get(tokenHash);

    if (!row) return null;

    if (new Date(row.expires_at).getTime() <= Date.now()) {
        // Expired — clean it up and treat as invalid.
        db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
        return null;
    }

    if (!row.is_active) {
        // Account was deactivated after login — do not honor the session.
        return null;
    }

    const newExpiresAt = ttlExpiryDate();
    db.prepare(
        'UPDATE auth_sessions SET expires_at = ?, last_seen_at = datetime(\'now\') WHERE token_hash = ?'
    ).run(newExpiresAt, tokenHash);

    return {
        user: {
            id: row.user_id,
            username: row.username,
            role: row.role,
            rank: row.rank,
            firstName: row.first_name,
            lastName: row.last_name,
            classId: row.class_id,
            isActive: !!row.is_active,
        },
        expiresAt: newExpiresAt,
    };
}

function destroySession(rawToken) {
    if (!rawToken) return;
    const tokenHash = hashToken(rawToken);
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
}

/**
 * Destroys every active session belonging to a user. Used when a
 * teacher resets a student's password or deactivates their account, so
 * a session that was already open elsewhere doesn't stay usable.
 */
function destroySessionsForUser(userId) {
    const info = db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    return info.changes;
}

/** Removes all expired sessions. Cheap to call periodically or on startup. */
function purgeExpiredSessions() {
    const result = db.prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
    return result.changes;
}

module.exports = { createSession, validateAndRefresh, destroySession, destroySessionsForUser, purgeExpiredSessions };
