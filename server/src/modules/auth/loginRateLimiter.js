/**
 * A minimal in-memory brute-force guard for /api/auth/login. Before this,
 * nothing stopped an unlimited number of password guesses against any one
 * account — a real concern on a classroom LAN where any student's laptop
 * can reach the login endpoint.
 *
 * Deliberately simple for this app's actual scale (~20 accounts, one
 * process, no horizontal scaling): an in-memory Map keyed by username is
 * enough. It resets on server restart, which is an acceptable trade-off
 * for a classroom tool — the alternative (persisting attempt counts) adds
 * real complexity for a threat model this small.
 */
const MAX_FAILED_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** @type {Map<string, { count: number, windowStartedAt: number }>} */
const attemptsByUsername = new Map();

function normalize(username) {
    return String(username || '').toLowerCase();
}

function getEntry(username) {
    const entry = attemptsByUsername.get(normalize(username));
    if (!entry) return null;
    if (Date.now() - entry.windowStartedAt > WINDOW_MS) {
        attemptsByUsername.delete(normalize(username));
        return null;
    }
    return entry;
}

function isRateLimited(username) {
    const entry = getEntry(username);
    return !!entry && entry.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(username) {
    const key = normalize(username);
    const entry = getEntry(username);
    if (entry) {
        entry.count += 1;
    } else {
        attemptsByUsername.set(key, { count: 1, windowStartedAt: Date.now() });
    }
}

function clearFailures(username) {
    attemptsByUsername.delete(normalize(username));
}

module.exports = { isRateLimited, recordFailure, clearFailures, MAX_FAILED_ATTEMPTS, WINDOW_MS };
