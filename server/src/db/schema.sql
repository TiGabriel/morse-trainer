-- Morse Trainer Platform - Initial Schema (Phase 1)
-- SQLite. Foreign keys must be enabled by the connection (PRAGMA foreign_keys = ON).

CREATE TABLE IF NOT EXISTS classes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
    rank            TEXT,
    first_name      TEXT,
    last_name       TEXT,
    class_id        INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_class_id ON users(class_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS morse_configs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT,
    wpm                 INTEGER NOT NULL DEFAULT 15,
    farnsworth_wpm      INTEGER,
    tone_freq_hz        INTEGER NOT NULL DEFAULT 600,
    char_set            TEXT NOT NULL DEFAULT 'letters',   -- letters | numbers | punctuation | mixed
    difficulty          TEXT NOT NULL DEFAULT 'easy',
    radiogram_length    INTEGER NOT NULL DEFAULT 25,
    spacing_params_json TEXT,                              -- JSON blob for extra timing params
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS radiograms (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_text         TEXT NOT NULL,
    generated_or_manual TEXT NOT NULL CHECK (generated_or_manual IN ('generated', 'manual')),
    config_id           INTEGER REFERENCES morse_configs(id) ON DELETE SET NULL,
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grading_configs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT NOT NULL,
    scoring_rules_json  TEXT NOT NULL,   -- JSON: points per correct char, penalty per error, etc.
    created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Teacher-controlled group training sessions (Phase 8).
-- Self-contained config (mode/difficulty/wpm/etc.) rather than an
-- indirection through morse_configs — the same pattern practice_attempts
-- already uses, and morse_configs was never populated by any real code.
CREATE TABLE IF NOT EXISTS sessions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id            INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    type                TEXT NOT NULL DEFAULT 'group' CHECK (type IN ('individual', 'group', 'test')),
    -- CREATED -> WAITING -> RUNNING <-> PAUSED -> FINISHED
    --    \-> CANCELLED (reachable from CREATED, WAITING, RUNNING, or PAUSED)
    status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'waiting', 'running', 'paused', 'finished', 'cancelled')),
    exercise_mode       TEXT NOT NULL CHECK (exercise_mode IN ('audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition')),
    difficulty          TEXT NOT NULL,
    wpm                 INTEGER,
    farnsworth_wpm      INTEGER,
    tone_frequency_hz   INTEGER,
    exercise_count      INTEGER NOT NULL DEFAULT 5,
    -- Phase 8: server-authoritative timing/testing configuration.
    -- prep_time_ms is the countdown/preload buffer before each item's
    -- scheduled start broadcast; answer_time_ms is the submission window
    -- after an item finishes playing (NULL = untimed group practice, still
    -- resolved to a default by the application layer so sessions always
    -- auto-advance). allowed_attempts/pass_threshold_percent only matter
    -- for type='test'; harmless/unused for type='group'.
    prep_time_ms        INTEGER NOT NULL DEFAULT 5000,
    answer_time_ms      INTEGER,
    allowed_attempts    INTEGER NOT NULL DEFAULT 1,
    pass_threshold_percent REAL,
    current_item_index  INTEGER NOT NULL DEFAULT 0,
    -- Phase 10 (formal testing): optional student-facing instructions
    -- text; an optional JSON array of specific student user ids this
    -- session is restricted to (NULL/empty = every student in the
    -- class, the original Phase 8 default — this is additive, not a
    -- replacement, since most group practice has no need to narrow the
    -- roster); an optional override of how many characters each
    -- generated item contains (NULL = the difficulty preset's default
    -- range, same as before this phase).
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

CREATE INDEX IF NOT EXISTS idx_sessions_class_id ON sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_created_by ON sessions(created_by);

-- Tracks which eligible students have actually connected to a session
-- (via the real-time layer) and their live connection status. The
-- ELIGIBLE roster itself is not stored here — it's derived on the fly
-- from `users` where class_id matches the session's class — so it
-- always reflects current class membership. A row here only exists once
-- a student has connected at least once.
CREATE TABLE IF NOT EXISTS session_participants (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    student_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_status   TEXT NOT NULL DEFAULT 'disconnected' CHECK (connection_status IN ('connected', 'disconnected')),
    -- Phase 8: readiness is a persisted attribute (not socket-only state)
    -- so a brief LAN drop/reconnect does not silently un-ready a student
    -- the teacher already saw as ready.
    is_ready            INTEGER NOT NULL DEFAULT 0,
    joined_at           TEXT,
    last_seen_at        TEXT,
    UNIQUE (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_session_participants_session_id ON session_participants(session_id);

CREATE TABLE IF NOT EXISTS session_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    radiogram_id    INTEGER NOT NULL REFERENCES radiograms(id) ON DELETE RESTRICT,
    order_index     INTEGER NOT NULL DEFAULT 0,
    -- Phase 8: the fully pre-generated exercise (mode, promptText/Morse,
    -- playback plan, timing, expectedAnswer) as JSON, generated ONCE at
    -- session-creation time so every student in the group receives byte-
    -- identical content — unlike individual practice, this cannot be
    -- regenerated per-student from a seed on demand.
    exercise_json   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_items_session_id ON session_items(session_id);

CREATE TABLE IF NOT EXISTS attempts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_item_id     INTEGER NOT NULL REFERENCES session_items(id) ON DELETE CASCADE,
    student_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submitted_text      TEXT,
    submitted_at        TEXT,
    duration_ms         INTEGER,
    -- Phase 8: how many submissions this student has made for this item so
    -- far, so allowed_attempts can be enforced server-side even though the
    -- row itself only ever holds the latest submission.
    attempt_count       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (session_item_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_attempts_student_id ON attempts(student_id);

CREATE TABLE IF NOT EXISTS results (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id          INTEGER NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
    grading_config_id   INTEGER REFERENCES grading_configs(id) ON DELETE SET NULL,
    score               REAL,
    error_count         INTEGER,
    grade               TEXT,
    graded_at           TEXT
);

-- Authentication sessions (Phase 3). One row per logged-in browser/session.
-- The `token` column stores a SHA-256 hash of the session token, never the
-- raw token itself — the raw token lives only in the client's cookie, so a
-- copy of this database alone cannot be used to impersonate a session.
CREATE TABLE IF NOT EXISTS auth_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash      TEXT NOT NULL UNIQUE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent      TEXT,
    ip_address      TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

-- Individual practice attempts (Phase 7). Deliberately a SEPARATE table
-- from `attempts`/`results` (which are reserved for teacher-controlled
-- group/test sessions) so ungraded self-practice can never affect an
-- official test grade — there is no shared table between the two.
CREATE TABLE IF NOT EXISTS practice_attempts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exercise_type       TEXT NOT NULL CHECK (exercise_type IN ('audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition')),
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
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_practice_attempts_student_id ON practice_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_practice_attempts_created_at ON practice_attempts(created_at);

-- Schema version bookkeeping for future migrations
CREATE TABLE IF NOT EXISTS schema_meta (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);
