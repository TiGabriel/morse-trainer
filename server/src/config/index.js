/**
 * Centralized configuration, loaded once from environment variables
 * (optionally supplied via server/.env — see .env.example).
 *
 * All other modules should read settings from here rather than
 * touching process.env directly, so there is a single source of truth.
 */
const path = require('path');

// Loads server/.env into process.env if the file exists. Safe no-op otherwise.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const VALID_LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

function parsePort(value, fallback) {
    const parsed = parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
        return parsed;
    }
    return fallback;
}

function parsePositiveInt(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const logLevel = VALID_LOG_LEVELS.includes(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : 'info';

const config = {
    port: parsePort(process.env.PORT, 8080),
    // 0.0.0.0 binds to ALL network interfaces, which is required for LAN
    // access. Overriding this to 127.0.0.1 would make the server
    // reachable only from the teacher's own machine.
    host: process.env.HOST || '0.0.0.0',
    nodeEnv,
    isProduction: nodeEnv === 'production',
    logLevel,

    // --- Authentication (Phase 3) ---
    auth: {
        // How long a login session stays valid without activity. Refreshed
        // (slides forward) on every authenticated request.
        sessionTtlHours: parsePositiveInt(process.env.SESSION_TTL_HOURS, 8),
        cookieName: process.env.SESSION_COOKIE_NAME || 'morse_session',
        // bcrypt cost factor. 10-12 is a reasonable range for a classroom
        // app running on ordinary laptop hardware with ~20 users.
        bcryptCost: parsePositiveInt(process.env.BCRYPT_COST, 11),
        // Optional: set these in .env to choose the initial teacher
        // account's credentials explicitly. If left unset, the seed script
        // generates a random password and writes it once to
        // server/data/INITIAL_TEACHER_CREDENTIALS.txt (gitignored).
        initialTeacherUsername: process.env.INITIAL_TEACHER_USERNAME || 'admin',
        initialTeacherPassword: process.env.INITIAL_TEACHER_PASSWORD || null,
    },
};

module.exports = config;
