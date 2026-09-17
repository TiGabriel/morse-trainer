const config = require('../config');
const sessionService = require('../modules/auth/sessionService');
const logger = require('../logger');

/**
 * Reads the session cookie, validates it, and attaches req.user if valid.
 * Responds 401 if there is no valid, active session.
 */
function requireAuth(req, res, next) {
    const rawToken = req.cookies ? req.cookies[config.auth.cookieName] : null;
    const session = sessionService.validateAndRefresh(rawToken);

    if (!session) {
        return res.status(401).json({ error: 'Not authenticated. Please log in.' });
    }

    req.user = session.user;
    next();
}

/**
 * Restricts a route to one or more roles. Must run AFTER requireAuth.
 * Usage: requireRole('teacher') or requireRole('teacher', 'student')
 */
function requireRole(...allowedRoles) {
    return function (req, res, next) {
        if (!req.user) {
            // Defensive: requireAuth should always run first.
            return res.status(401).json({ error: 'Not authenticated. Please log in.' });
        }
        if (!allowedRoles.includes(req.user.role)) {
            logger.warn(
                `Authorization denied: user "${req.user.username}" (role=${req.user.role}) ` +
                    `attempted ${req.method} ${req.originalUrl}, requires role in [${allowedRoles.join(', ')}]`
            );
            return res.status(403).json({ error: 'You do not have permission to access this resource.' });
        }
        next();
    };
}

/**
 * Allows teachers to act on any user, but restricts students to only
 * themselves. Reads the target id from req.params[paramName] (default "id").
 * Must run after requireAuth.
 */
function requireSelfOrTeacher(paramName = 'id') {
    return function (req, res, next) {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated. Please log in.' });
        }
        const targetId = Number(req.params[paramName]);
        if (req.user.role === 'teacher' || req.user.id === targetId) {
            return next();
        }
        logger.warn(
            `Authorization denied: user "${req.user.username}" (id=${req.user.id}) attempted to access ` +
                `user id=${targetId}'s data via ${req.method} ${req.originalUrl}`
        );
        return res.status(403).json({ error: 'You may only access your own data.' });
    };
}

module.exports = { requireAuth, requireRole, requireSelfOrTeacher };
