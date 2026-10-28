const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { localDate } = require('../utils/serverTime');

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

// local_date(created_at) -> "YYYY-MM-DD" of that UTC timestamp in the
// server PC's own time zone (see utils/serverTime.js). Used instead of
// SQLite's date() wherever results are grouped or filtered by calendar
// day, so a result saved at 01:30 local time counts for that day, not
// the previous (UTC) one.
db.function('local_date', { deterministic: true }, (value) => localDate(value));

module.exports = db;
module.exports.DB_PATH = DB_PATH;
