const crypto = require('crypto');

const userRepository = require('./userRepository');
const classRepository = require('../classes/classRepository');
const passwordService = require('../auth/passwordService');
const sessionService = require('../auth/sessionService');
const logger = require('../../logger');

const VALID_ROLES = ['teacher', 'student'];

function generateRandomPassword(length = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
}

/** Validates a classId value (null is allowed = "no class"). Returns an error string or null. */
function validateClassId(classId) {
    if (classId === null || classId === undefined) return null;
    const cls = classRepository.findById(classId);
    if (!cls) return 'classId does not refer to an existing class.';
    return null;
}

async function createUser(req, res) {
    const { username, password, role, rank, firstName, lastName, classId } = req.body || {};

    if (!username || !password || !role) {
        return res.status(400).json({ error: 'username, password, and role are required.' });
    }
    if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (userRepository.findByUsername(username)) {
        return res.status(409).json({ error: 'That username is already taken.' });
    }
    const classIdError = validateClassId(classId ?? null);
    if (classIdError) {
        return res.status(400).json({ error: classIdError });
    }

    const passwordHash = await passwordService.hashPassword(password);
    const user = userRepository.createUser({
        username,
        passwordHash,
        role,
        rank,
        firstName,
        lastName,
        classId: classId || null,
        isActive: true,
    });

    logger.info(`User created: "${username}" (role=${role}) by teacher "${req.user.username}"`);
    return res.status(201).json({ user });
}

/**
 * GET /api/users?role=student&search=smith&classId=1&status=active
 * All query params optional. Teacher-only (enforced in routes).
 */
function listUsers(req, res) {
    const { role, search, status } = req.query;
    let classId;
    if (req.query.classId === 'none') {
        classId = null;
    } else if (req.query.classId !== undefined && req.query.classId !== '') {
        classId = Number(req.query.classId);
    }

    const users = userRepository.search({
        role: role || undefined,
        search: search || undefined,
        classId,
        status: status || 'all',
    });
    return res.json({ users });
}

function getUser(req, res) {
    const user = userRepository.findByIdPublic(Number(req.params.id));
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }
    return res.json({ user });
}

/**
 * PATCH /api/users/:id — edit profile fields. Teacher-only.
 * Accepts a partial body: { rank, firstName, lastName, classId, username }
 */
function updateUser(req, res) {
    const id = Number(req.params.id);
    const existing = userRepository.findById(id);
    if (!existing) {
        return res.status(404).json({ error: 'User not found.' });
    }

    const { rank, firstName, lastName, classId, username } = req.body || {};
    const fields = {};

    if (rank !== undefined) fields.rank = rank;
    if (firstName !== undefined) fields.firstName = firstName;
    if (lastName !== undefined) fields.lastName = lastName;

    if (classId !== undefined) {
        const classIdError = validateClassId(classId);
        if (classIdError) {
            return res.status(400).json({ error: classIdError });
        }
        fields.classId = classId;
    }

    if (username !== undefined) {
        if (!username || typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'username cannot be empty.' });
        }
        const clash = userRepository.findByUsername(username);
        if (clash && clash.id !== id) {
            return res.status(409).json({ error: 'That username is already taken.' });
        }
        fields.username = username.trim();
    }

    const updated = userRepository.updateUser(id, fields);
    logger.info(`User "${existing.username}" (id=${id}) updated by teacher "${req.user.username}"`);
    return res.json({ user: updated });
}

/**
 * PATCH /api/users/:id/status — activate/deactivate. Teacher-only.
 * Deactivating immediately revokes any live sessions for that account.
 */
function setActiveStatus(req, res) {
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive (boolean) is required.' });
    }

    const id = Number(req.params.id);
    const user = userRepository.setActive(id, isActive);
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }

    if (!isActive) {
        sessionService.destroySessionsForUser(id);
    }

    logger.info(
        `User "${user.username}" set to ${isActive ? 'ACTIVE' : 'INACTIVE'} by teacher "${req.user.username}"`
    );
    return res.json({ user });
}

/**
 * POST /api/users/:id/reset-password — teacher-only.
 * Body: { newPassword?: string } — if omitted, a random password is
 * generated and returned ONCE in the response for the teacher to relay
 * to the student. All of that student's existing sessions are revoked.
 */
async function resetPassword(req, res) {
    const id = Number(req.params.id);
    const existing = userRepository.findById(id);
    if (!existing) {
        return res.status(404).json({ error: 'User not found.' });
    }

    let { newPassword } = req.body || {};
    let generated = false;

    if (newPassword) {
        if (typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'newPassword must be at least 8 characters.' });
        }
    } else {
        newPassword = generateRandomPassword();
        generated = true;
    }

    const passwordHash = await passwordService.hashPassword(newPassword);
    userRepository.updatePasswordHash(id, passwordHash);
    sessionService.destroySessionsForUser(id);

    logger.info(`Password reset for "${existing.username}" (id=${id}) by teacher "${req.user.username}"`);

    const response = { success: true };
    if (generated) {
        // Only echoed back when the server generated it — if the teacher
        // supplied their own password, they already know it.
        response.temporaryPassword = newPassword;
    }
    return res.json(response);
}

module.exports = { createUser, listUsers, getUser, updateUser, setActiveStatus, resetPassword };
