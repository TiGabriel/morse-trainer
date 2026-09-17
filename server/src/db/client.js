const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
// Overridable so automated tests can point at an isolated temp file
// instead of the real classroom database — unset, behavior is unchanged.
const DB_PATH = process.env.MORSE_DB_PATH || path.join(DATA_DIR, 'morse_trainer.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode handles concurrent reads/writes from ~20 clients much better
// than the default rollback journal mode.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
module.exports.DB_PATH = DB_PATH;
