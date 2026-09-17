/**
 * Creates the initial teacher/admin account, if one doesn't already exist.
 * Safe to run every time the server starts (idempotent) — it only acts
 * when there are zero teacher accounts in the database.
 *
 * Credential source, in priority order:
 *   1. INITIAL_TEACHER_USERNAME / INITIAL_TEACHER_PASSWORD from .env, if set.
 *   2. Otherwise: username "admin" (or configured) + a freshly generated
 *      random password, written ONCE to
 *      server/data/INITIAL_TEACHER_CREDENTIALS.txt (gitignored) and
 *      never logged or printed in full elsewhere.
 *
 * This file is intentionally NOT part of the regular schema migration —
 * it's data, not structure — so it lives alongside migrate.js but is a
 * separate step.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../config');
const logger = require('../logger');
const userRepository = require('../modules/users/userRepository');
const passwordService = require('../modules/auth/passwordService');

const CREDENTIALS_FILE = path.join(__dirname, '..', '..', 'data', 'INITIAL_TEACHER_CREDENTIALS.txt');

function generateRandomPassword(length = 14) {
    // Avoids visually ambiguous characters (0/O, 1/l/I) for easier manual
    // transcription when the teacher reads it off the credentials file.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
}

async function seed() {
    const existingTeachers = userRepository.countByRole('teacher');
    if (existingTeachers > 0) {
        logger.debug(`Seed: ${existingTeachers} teacher account(s) already exist — skipping initial teacher creation.`);
        return;
    }

    const username = config.auth.initialTeacherUsername;
    let password = config.auth.initialTeacherPassword;
    let generated = false;

    if (!password) {
        password = generateRandomPassword();
        generated = true;
    }

    const passwordHash = await passwordService.hashPassword(password);
    userRepository.createUser({
        username,
        passwordHash,
        role: 'teacher',
        rank: null,
        firstName: 'Teacher',
        lastName: 'Account',
        classId: null,
        isActive: true,
    });

    if (generated) {
        const contents =
            `Morse Trainer — initial teacher account\n` +
            `Generated: ${new Date().toISOString()}\n\n` +
            `Username: ${username}\n` +
            `Password: ${password}\n\n` +
            `Log in, then DELETE THIS FILE. You can change the password by\n` +
            `re-creating the account or (once implemented) via a profile screen.\n`;
        fs.writeFileSync(CREDENTIALS_FILE, contents, { mode: 0o600 });
        logger.info(
            `Initial teacher account created (username: "${username}"). ` +
                `Generated password written to ${CREDENTIALS_FILE} — read it, log in, then delete that file.`
        );
    } else {
        logger.info(`Initial teacher account created (username: "${username}") using credentials from .env.`);
    }
}

if (require.main === module) {
    seed()
        .then(() => process.exit(0))
        .catch((err) => {
            logger.error('Seed failed:', err.message);
            process.exit(1);
        });
}

module.exports = seed;
