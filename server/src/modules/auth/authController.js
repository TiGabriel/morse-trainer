const config = require('../../config');
const logger = require('../../logger');
const userRepository = require('../users/userRepository');
const passwordService = require('./passwordService');
const sessionService = require('./sessionService');

const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    // This app is designed to run over plain HTTP on a local classroom
    // LAN (see README) — so `secure` is intentionally left false. If this
    // is ever deployed behind HTTPS, set secure: true.
    secure: false,
    path: '/',
};

async function login(req, res) {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required.' });
    }

    const userRow = userRepository.findByUsername(username);

    // Deliberately generic message for both "unknown username" and "wrong
    // password" — this avoids revealing which usernames exist on the
    // system (standard login-security practice).
    if (!userRow) {
        logger.info(`Login failed (unknown username): "${username}"`);
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const passwordOk = await passwordService.verifyPassword(password, userRow.password_hash);
    if (!passwordOk) {
        logger.info(`Login failed (wrong password): "${username}"`);
        return res.status(401).json({ error: 'Invalid username or password.' });
    }

    if (!userRow.is_active) {
        logger.info(`Login rejected (inactive account): "${username}"`);
        return res.status(403).json({ error: 'This account has been deactivated. Contact your teacher.' });
    }

    const { rawToken, expiresAt } = sessionService.createSession(userRow.id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
    });

    res.cookie(config.auth.cookieName, rawToken, {
        ...cookieOptions,
        expires: new Date(expiresAt),
    });

    logger.info(`Login succeeded: "${username}" (role=${userRow.role})`);

    return res.json({ user: userRepository.findByIdPublic(userRow.id) });
}

function logout(req, res) {
    const rawToken = req.cookies ? req.cookies[config.auth.cookieName] : null;
    if (rawToken) {
        sessionService.destroySession(rawToken);
    }
    res.clearCookie(config.auth.cookieName, cookieOptions);
    return res.json({ success: true });
}

function me(req, res) {
    // req.user is populated by the requireAuth middleware.
    return res.json({ user: userRepository.findByIdPublic(req.user.id) });
}

module.exports = { login, logout, me };
