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

    // Phase 8 (group sessions + formal testing): plain additive columns,
    // safe as simple ALTER TABLE ADD COLUMN (no CHECK constraints involved).
    if (tableExists('sessions') && !columnExists('sessions', 'prep_time_ms')) {
        db.exec("ALTER TABLE sessions ADD COLUMN prep_time_ms INTEGER NOT NULL DEFAULT 5000");
        db.exec('ALTER TABLE sessions ADD COLUMN answer_time_ms INTEGER');
        db.exec('ALTER TABLE sessions ADD COLUMN allowed_attempts INTEGER NOT NULL DEFAULT 1');
        db.exec('ALTER TABLE sessions ADD COLUMN pass_threshold_percent REAL');
        db.exec('ALTER TABLE sessions ADD COLUMN current_item_index INTEGER NOT NULL DEFAULT 0');
        console.log('[migrate] Added Phase 8 timing/testing columns to sessions.');
    }
    if (tableExists('session_participants') && !columnExists('session_participants', 'is_ready')) {
        db.exec('ALTER TABLE session_participants ADD COLUMN is_ready INTEGER NOT NULL DEFAULT 0');
        console.log('[migrate] Added session_participants.is_ready.');
    }
    if (tableExists('session_items') && !columnExists('session_items', 'exercise_json')) {
        db.exec("ALTER TABLE session_items ADD COLUMN exercise_json TEXT NOT NULL DEFAULT '{}'");
        console.log('[migrate] Added session_items.exercise_json.');
    }
    if (tableExists('attempts') && !columnExists('attempts', 'attempt_count')) {
        db.exec('ALTER TABLE attempts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
        console.log('[migrate] Added attempts.attempt_count.');
    }

    // Phase 10 (formal testing): plain additive columns on sessions.
    if (tableExists('sessions') && !columnExists('sessions', 'instructions')) {
        db.exec('ALTER TABLE sessions ADD COLUMN instructions TEXT');
        db.exec('ALTER TABLE sessions ADD COLUMN participant_ids_json TEXT');
        db.exec('ALTER TABLE sessions ADD COLUMN item_length INTEGER');
        console.log('[migrate] Added Phase 10 formal-testing columns to sessions.');
    }

    // Morse Transmission: sessions.exercise_mode gains 'transmission' (Space-
    // bar keying, decoded automatically) — distinct from the pre-existing
    // 'text_to_morse' (typing literal dot/dash characters as text). SQLite
    // can't ALTER a CHECK constraint in place, so rebuild the table, this
    // time preserving every column (unlike the Phase 8 rebuild, this table
    // has been live and populated with real group/test sessions since
    // Phase 8) — child tables (session_items, session_participants,
    // attempts) reference sessions.id via FK, so ids must be preserved
    // exactly, which this explicit column-for-column copy does.
    if (tableExists('sessions')) {
        const checkRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get();
        const needsRebuild = checkRow && !checkRow.sql.includes('transmission');
        if (needsRebuild) {
            db.pragma('foreign_keys = OFF');
            // Modern SQLite's ALTER TABLE RENAME automatically rewrites
            // OTHER tables' FK clauses to point at the new name (e.g.
            // session_items' "REFERENCES sessions(id)" would silently
            // become "REFERENCES sessions_old_transmission_rebuild(id)"
            // the moment the line below runs) — exactly the opposite of
            // what a temporary rename-out-of-the-way needs. This table
            // has real child rows depending on it (session_items,
            // attempts, session_participants), unlike the Phase 8
            // rebuild above (which predates any real data), so this
            // legacy behavior must be restored for the duration of the
            // rebuild, or every child row's FK would end up dangling.
            db.pragma('legacy_alter_table = ON');
            const rebuild = db.transaction(() => {
                db.exec('ALTER TABLE sessions RENAME TO sessions_old_transmission_rebuild;');
                db.exec(`
                    CREATE TABLE sessions (
                        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                        class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                        type                TEXT NOT NULL DEFAULT 'group' CHECK (type IN ('individual', 'group', 'test')),
                        status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'waiting', 'running', 'paused', 'finished', 'cancelled')),
                        exercise_mode       TEXT NOT NULL CHECK (exercise_mode IN ('audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition', 'transmission')),
                        difficulty          TEXT NOT NULL,
                        wpm                 INTEGER,
                        farnsworth_wpm      INTEGER,
                        tone_frequency_hz   INTEGER,
                        exercise_count      INTEGER NOT NULL DEFAULT 5,
                        prep_time_ms        INTEGER NOT NULL DEFAULT 5000,
                        answer_time_ms      INTEGER,
                        allowed_attempts    INTEGER NOT NULL DEFAULT 1,
                        pass_threshold_percent REAL,
                        current_item_index  INTEGER NOT NULL DEFAULT 0,
                        instructions        TEXT,
                        participant_ids_json TEXT,
                        item_length         INTEGER,
                        created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
                        opened_at           TEXT,
                        started_at          TEXT,
                        paused_at           TEXT,
                        ended_at            TEXT,
                        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                    );
                `);
                db.exec(`
                    INSERT INTO sessions (
                        id, class_id, type, status, exercise_mode, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                        exercise_count, prep_time_ms, answer_time_ms, allowed_attempts, pass_threshold_percent,
                        current_item_index, instructions, participant_ids_json, item_length, created_by,
                        opened_at, started_at, paused_at, ended_at, created_at
                    )
                    SELECT
                        id, class_id, type, status, exercise_mode, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                        exercise_count, prep_time_ms, answer_time_ms, allowed_attempts, pass_threshold_percent,
                        current_item_index, instructions, participant_ids_json, item_length, created_by,
                        opened_at, started_at, paused_at, ended_at, created_at
                    FROM sessions_old_transmission_rebuild;
                `);
                db.exec('DROP TABLE sessions_old_transmission_rebuild;');
                db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_class_id ON sessions(class_id);');
                db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');
                db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON sessions(created_by);');
            });
            rebuild();
            db.pragma('legacy_alter_table = OFF');
            db.pragma('foreign_keys = ON');
            console.log('[migrate] Rebuilt sessions to allow the transmission exercise_mode (existing sessions and their ids preserved).');
        }
    }

    // Centralized grading service: results gains the raw correct-count
    // input the 4-10 school grade is computed from (see
    // grading/gradingService.js) — additive, existing rows just get
    // NULL and fall back to no character grade until re-graded.
    if (tableExists('results') && !columnExists('results', 'correct_count')) {
        db.exec('ALTER TABLE results ADD COLUMN correct_count INTEGER');
        console.log('[migrate] Added results.correct_count.');
    }

    // Individual Training redesign: practice_attempts.exercise_type gains
    // 'radiogram_training' and 'character_training' so the redesigned
    // Radiogram/Character Training screens (which replaced the original
    // four-mode practice UI) can persist results at all — previously
    // those two exercise types had no DB-backed attempt row and every
    // result was lost on navigation/refresh. SQLite can't ALTER a CHECK
    // constraint in place, so rebuild the table, this time copying over
    // any existing rows (unlike the Phase 8 `sessions` rebuild, this
    // table has been live and populated since Phase 7).
    if (tableExists('practice_attempts')) {
        const checkRow = db
            .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='practice_attempts'")
            .get();
        const needsRebuild = checkRow && !checkRow.sql.includes('radiogram_training');
        if (needsRebuild) {
            db.pragma('foreign_keys = OFF');
            const rebuild = db.transaction(() => {
                db.exec('ALTER TABLE practice_attempts RENAME TO practice_attempts_old_it_redesign_rebuild;');
                db.exec(`
                    CREATE TABLE practice_attempts (
                        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                        student_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        exercise_type       TEXT NOT NULL CHECK (exercise_type IN ('audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition', 'radiogram_training', 'character_training')),
                        difficulty          TEXT,
                        wpm                 INTEGER NOT NULL,
                        farnsworth_wpm      INTEGER,
                        tone_frequency_hz   INTEGER,
                        prompt_text         TEXT NOT NULL,
                        prompt_morse        TEXT NOT NULL,
                        expected_answer     TEXT NOT NULL,
                        submitted_answer    TEXT NOT NULL,
                        correct_count       INTEGER NOT NULL,
                        incorrect_count     INTEGER NOT NULL,
                        missing_count       INTEGER NOT NULL,
                        extra_count         INTEGER NOT NULL,
                        accuracy_percent    REAL NOT NULL,
                        duration_ms         INTEGER,
                        timing_stats_json   TEXT,
                        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                    );
                `);
                db.exec(`
                    INSERT INTO practice_attempts (
                        id, student_id, exercise_type, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                        prompt_text, prompt_morse, expected_answer, submitted_answer,
                        correct_count, incorrect_count, missing_count, extra_count, accuracy_percent,
                        duration_ms, created_at
                    )
                    SELECT
                        id, student_id, exercise_type, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                        prompt_text, prompt_morse, expected_answer, submitted_answer,
                        correct_count, incorrect_count, missing_count, extra_count, accuracy_percent,
                        duration_ms, created_at
                    FROM practice_attempts_old_it_redesign_rebuild;
                `);
                db.exec('DROP TABLE practice_attempts_old_it_redesign_rebuild;');
                db.exec('CREATE INDEX IF NOT EXISTS idx_practice_attempts_student_id ON practice_attempts(student_id);');
                db.exec('CREATE INDEX IF NOT EXISTS idx_practice_attempts_created_at ON practice_attempts(created_at);');
            });
            rebuild();
            db.pragma('foreign_keys = ON');
            console.log('[migrate] Rebuilt practice_attempts to allow radiogram_training/character_training exercise types (existing rows preserved).');
        }
    }

    // Morse Transmission: practice_attempts gains a nullable JSON column
    // for per-exercise timing statistics (avg dot/dash/gap durations,
    // actual WPM, rhythm consistency) — purely additive, no CHECK
    // constraint involved, so a plain ALTER TABLE is safe here (unlike
    // the exercise_type rebuild above).
    if (tableExists('practice_attempts') && !columnExists('practice_attempts', 'timing_stats_json')) {
        db.exec('ALTER TABLE practice_attempts ADD COLUMN timing_stats_json TEXT');
        console.log('[migrate] Added practice_attempts.timing_stats_json.');
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
    setMeta.run('schema_version', '9');
    setMeta.run('last_migrated_at', new Date().toISOString());

    console.log(`[migrate] Schema applied successfully. DB file: ${db.DB_PATH}`);
}

if (require.main === module) {
    migrate();
}

module.exports = migrate;
