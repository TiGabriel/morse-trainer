/**
 * Applies schema.sql to the local SQLite database.
 * Safe to run multiple times (all statements use IF NOT EXISTS).
 *
 * Beyond schema.sql (which only ever CREATEs), this also runs small
 * hand-written "add column if missing" steps for changes to tables that
 * already existed in an earlier phase — SQLite's CREATE TABLE IF NOT
 * EXISTS does not retroactively add new columns to an existing table.
 *
 * Usage: node src/db/migrate.js
 */
const fs = require('fs');
const path = require('path');
const db = require('./client');

function columnExists(table, column) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === column);
}

function tableExists(table) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    return !!row;
}

function applyColumnMigrations() {
    // Phase 4: classes can be soft-deactivated without losing history.
    if (!columnExists('classes', 'is_active')) {
        db.exec('ALTER TABLE classes ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
        console.log('[migrate] Added classes.is_active column.');
    }

    // Phase 8: sessions gained a 6-state machine (created/waiting/running/
    // paused/finished/cancelled) and self-contained exercise config
    // columns. SQLite can't ALTER a CHECK constraint in place, so if the
    // table is still in its pre-Phase-8 shape, rebuild it. This table
    // was never populated by any earlier phase's code (nothing wrote to
    // it before Phase 8), so a clean rebuild is safe — no data migration
    // needed, only a structural one.
    if (tableExists('sessions') && !columnExists('sessions', 'exercise_mode')) {
        db.pragma('foreign_keys = OFF');
        db.exec(`
            DROP TABLE IF EXISTS sessions_old_phase8_rebuild;
            ALTER TABLE sessions RENAME TO sessions_old_phase8_rebuild;
        `);
        // schema.sql (already executed above) created the new-shape
        // `sessions` table under its real name only if one didn't
        // already exist — since we just renamed the old one out of the
        // way, re-run just that CREATE statement now.
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                type                TEXT NOT NULL DEFAULT 'group' CHECK (type IN ('individual', 'group', 'test')),
                status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'waiting', 'running', 'paused', 'finished', 'cancelled')),
                exercise_mode       TEXT NOT NULL CHECK (exercise_mode IN ('audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition')),
                difficulty          TEXT NOT NULL,
                wpm                 INTEGER,
                farnsworth_wpm      INTEGER,
                tone_frequency_hz   INTEGER,
                exercise_count      INTEGER NOT NULL DEFAULT 5,
                created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                opened_at           TEXT,
                started_at          TEXT,
                paused_at           TEXT,
                ended_at            TEXT,
                created_at          TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
        db.exec('DROP TABLE sessions_old_phase8_rebuild;');
        db.pragma('foreign_keys = ON');
        console.log('[migrate] Rebuilt sessions table for the Phase 8 state machine (no prior data existed to migrate).');
    }
}

function migrate() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    db.exec(schemaSql);
    applyColumnMigrations();

    const setMeta = db.prepare(
        'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    setMeta.run('schema_version', '5');
    setMeta.run('last_migrated_at', new Date().toISOString());

    console.log(`[migrate] Schema applied successfully. DB file: ${db.DB_PATH}`);
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
