/**
 * Integration-style tests against a REAL (but isolated, temporary)
 * SQLite database — unlike the morse-engine/practice suites, which are
 * pure-function tests, this module is mostly SQL. MORSE_DB_PATH (see
 * db/client.js) points the whole app's DB singleton at a throwaway file
 * for the lifetime of this process, so these tests never touch the real
 * classroom database in server/data/.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const sessionRepository = require('../sessionRepository');
const sessionEngine = require('../sessionEngine');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

// ---- Fixtures --------------------------------------------------------
db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Test Class')").run();
db.prepare("INSERT INTO classes (id, name) VALUES (2, 'Other Class')").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id) VALUES (1, 'teacher1', 'x', 'teacher', NULL)"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (3, 'stud2', 'x', 'student', 1, 'Bob', 'Jones')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (4, 'other1', 'x', 'student', 2, 'Zed', 'Other')"
).run();

function makeSession(overrides = {}) {
    const session = sessionRepository.createSession({
        classId: 1,
        type: 'group',
        exerciseMode: 'audio_to_text',
        difficulty: 'easy',
        wpm: undefined,
        farnsworthWpm: undefined,
        toneFrequencyHz: undefined,
        exerciseCount: 2,
        prepTimeMs: 5000,
        answerTimeMs: null,
        allowedAttempts: 1,
        passThresholdPercent: null,
        createdBy: 1,
        ...overrides,
    });
    const { items } = sessionEngine.generateItems({
        exerciseMode: session.exerciseMode,
        difficulty: session.difficulty,
        exerciseCount: session.exerciseCount,
    });
    sessionRepository.insertItems(session.id, 1, items);
    return session;
}

test('createSession + insertItems: session and its items persist correctly', () => {
    const session = makeSession();
    assert.equal(session.status, 'created');
    assert.equal(session.classId, 1);

    const items = sessionRepository.listItems(session.id);
    assert.equal(items.length, 2);
    assert.equal(items[0].orderIndex, 0);
    assert.ok(items[0].exercise.text.length > 0);
});

test('transitionStatus: only succeeds when the current status matches expectations (race-safety)', () => {
    const session = makeSession();

    const ok = sessionRepository.transitionStatus(session.id, ['created'], 'waiting', {});
    assert.equal(ok.changes, 1);
    assert.equal(sessionRepository.findByIdPublic(session.id).status, 'waiting');

    // Retrying the same "created -> waiting" transition should now no-op —
    // this is what stops a double-click (or a stale concurrent request)
    // from applying the same transition twice.
    const retried = sessionRepository.transitionStatus(session.id, ['created'], 'waiting', {});
    assert.equal(retried.changes, 0);
});

test('listAvailableForClass: only returns waiting/running/paused sessions, scoped to the right class', () => {
    const created = makeSession(); // status stays 'created'
    const waiting = makeSession();
    sessionRepository.transitionStatus(waiting.id, ['created'], 'waiting', {});
    const otherClass = makeSession({ classId: 2 });
    sessionRepository.transitionStatus(otherClass.id, ['created'], 'waiting', {});

    const availableForClass1 = sessionRepository.listAvailableForClass(1);
    const ids = availableForClass1.map((s) => s.id);
    assert.ok(ids.includes(waiting.id));
    assert.ok(!ids.includes(created.id), 'a still-"created" session should not be available to join');
    assert.ok(!ids.includes(otherClass.id), 'a session from another class should not leak into this class\'s list');
});

test('roster: derived live from class membership, with connection/ready state layered on top', () => {
    const session = makeSession();

    let roster = sessionRepository.listRoster(session.id, 1);
    assert.equal(roster.length, 2); // stud1 + stud2, both in class 1
    assert.ok(roster.every((r) => r.connectionStatus === 'disconnected' && !r.isReady));

    sessionRepository.markParticipantConnected(session.id, 2);
    sessionRepository.setParticipantReady(session.id, 2, true);

    roster = sessionRepository.listRoster(session.id, 1);
    const ann = roster.find((r) => r.studentId === 2);
    assert.equal(ann.connectionStatus, 'connected');
    assert.equal(ann.isReady, true);
    const bob = roster.find((r) => r.studentId === 3);
    assert.equal(bob.connectionStatus, 'disconnected');

    sessionRepository.markParticipantDisconnected(session.id, 2);
    roster = sessionRepository.listRoster(session.id, 1);
    const annAfter = roster.find((r) => r.studentId === 2);
    assert.equal(annAfter.connectionStatus, 'disconnected');
    // Readiness survives a disconnect — a brief LAN drop shouldn't silently un-ready someone.
    assert.equal(annAfter.isReady, true);
});

test('isStudentInSessionClass: true only for students actually in the session\'s class', () => {
    const session = makeSession();
    assert.equal(sessionRepository.isStudentInSessionClass(session.id, 2), true);
    assert.equal(sessionRepository.isStudentInSessionClass(session.id, 4), false); // other class
    assert.equal(sessionRepository.isStudentInSessionClass(session.id, 999), false); // nonexistent
});

test('attempts/results: upsert increments attempt_count and grading is queryable per-student', () => {
    const session = makeSession({ passThresholdPercent: 50 });
    const item = sessionRepository.getItemByIndex(session.id, 0);

    const first = sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: 'WRONG', durationMs: 1000 });
    assert.equal(first.attemptCount, 1);

    const second = sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: item.exercise.text, durationMs: 500 });
    assert.equal(second.attemptCount, 2, 'attempt_count should increment on a resubmission, not reset');
    assert.equal(second.submittedText, item.exercise.text, 'the row holds the latest submission');

    const score = sessionEngine.gradeSubmission(item.exercise, item.exercise.text);
    const grade = sessionEngine.computeGrade(score.accuracyPercent, session.passThresholdPercent);
    sessionRepository.upsertResult({ attemptId: second.id, score: score.accuracyPercent, errorCount: 0, grade });

    const studentResults = sessionRepository.listResultsForStudent(session.id, 2);
    const row = studentResults.find((r) => r.sessionItemId === item.id);
    assert.equal(row.score, 100);
    assert.equal(row.grade, 'pass');
    assert.equal(row.attemptCount, 2);

    // A different student's results are listed separately and start ungraded.
    const otherResults = sessionRepository.listResultsForStudent(session.id, 3);
    const otherRow = otherResults.find((r) => r.sessionItemId === item.id);
    assert.equal(otherRow.score, null);
    assert.equal(otherRow.attemptCount, 0);

    // The full-session view (teacher-facing) includes every class member for every item.
    const fullResults = sessionRepository.listResultsForSession(session.id);
    assert.equal(fullResults.length, 2 /* students */ * 2 /* items */);
});
