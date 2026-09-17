/**
 * Minimal dependency-free logger. Writes timestamped, leveled lines to both
 * the console and a rotating-by-restart log file (server/logs/server.log).
 * Kept intentionally simple for this phase — no external logging service,
 * no log shipping, fully offline.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevelValue = LEVELS[config.logLevel] ?? LEVELS.info;

function formatArg(arg) {
    if (typeof arg === 'string') return arg;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

function write(level, args) {
    if (LEVELS[level] > currentLevelValue) return;

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${args.map(formatArg).join(' ')}`;

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(line);

    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
        // Never let a logging failure crash the server.
    }
}

module.exports = {
    error: (...args) => write('error', args),
    warn: (...args) => write('warn', args),
    info: (...args) => write('info', args),
    debug: (...args) => write('debug', args),
    LOG_FILE,
};
