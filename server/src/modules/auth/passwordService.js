/**
 * Password hashing. Uses bcryptjs (a pure-JavaScript bcrypt implementation)
 * rather than the native `bcrypt` package, specifically so a fresh
 * `npm install` on a classroom Windows PC never needs a C++ build
 * toolchain — it just works offline, the same way on every machine.
 *
 * Passwords are NEVER stored or logged in plaintext anywhere in this
 * application.
 */
const bcrypt = require('bcryptjs');
const config = require('../../config');

async function hashPassword(plainPassword) {
    if (typeof plainPassword !== 'string' || plainPassword.length < 8) {
        throw new Error('Password must be a string of at least 8 characters.');
    }
    return bcrypt.hash(plainPassword, config.auth.bcryptCost);
}

async function verifyPassword(plainPassword, passwordHash) {
    if (!plainPassword || !passwordHash) return false;
    return bcrypt.compare(plainPassword, passwordHash);
}

module.exports = { hashPassword, verifyPassword };
