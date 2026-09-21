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

test('listAvailableForStudent: only returns waiting/running/paused sessions, scoped to the right class', () => {
    const created = makeSession(); // status stays 'created'
    const waiting = makeSession();
    sessionRepository.transitionStatus(waiting.id, ['created'], 'waiting', {});
    const otherClass = makeSession({ classId: 2 });
    sessionRepository.transitionStatus(otherClass.id, ['created'], 'waiting', {});

    const availableForClass1 = sessionRepository.listAvailableForStudent(2, 1); // student 2 ("stud1") is in class 1
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

test('listResultsForSession: exposes the exact original exercise text alongside a student answer that differs from it', () => {
    const session = makeSession();
    const item = sessionRepository.getItemByIndex(session.id, 0);

    sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: 'WRONG ANSWER', durationMs: 800 });

    const results = sessionRepository.listResultsForSession(session.id);
    const row = results.find((r) => r.sessionItemId === item.id && r.studentId === 2);

    // The stored original is read back from session_items.exercise_json —
    // never regenerated — so it must equal exactly what was generated at
    // session-creation time, and must not have been overwritten by the
    // (deliberately different) student submission.
    assert.equal(row.expectedAnswer, item.exercise.expectedAnswer);
    assert.notEqual(row.expectedAnswer, row.submittedText);
    assert.equal(row.submittedText, 'WRONG ANSWER');

    // A perfect answer (correct === submitted) still keeps both fields present and equal to each other.
    const item2 = sessionRepository.getItemByIndex(session.id, 1);
    sessionRepository.upsertAttempt({ sessionItemId: item2.id, studentId: 2, submittedText: item2.exercise.expectedAnswer, durationMs: 400 });
    const results2 = sessionRepository.listResultsForSession(session.id);
    const row2 = results2.find((r) => r.sessionItemId === item2.id && r.studentId === 2);
    assert.equal(row2.expectedAnswer, item2.exercise.expectedAnswer);
    assert.equal(row2.submittedText, row2.expectedAnswer);
});

test('listResultsForSession: characterGrade is computed from the persisted correct_count and the item\'s own expectedAnswer length', () => {
    const session = makeSession();
    const item = sessionRepository.getItemByIndex(session.id, 0);
    const totalCharacters = item.exercise.expectedAnswer.replace(/\s+/g, '').length;

    const attempt = sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: 'X', durationMs: 100 });
    sessionRepository.upsertResult({ attemptId: attempt.id, score: 100, errorCount: 0, grade: 'pass', correctCount: totalCharacters });

    const rows = sessionRepository.listResultsForSession(session.id);
    const row = rows.find((r) => r.sessionItemId === item.id && r.studentId === 2);
    assert.ok(row.characterGrade, 'a graded row with a correct_count must carry a characterGrade');
    assert.equal(row.characterGrade.grade, 10, 'correctCount === total should be a perfect grade 10');
    assert.equal(row.characterGrade.correctCharacters, totalCharacters);
    assert.equal(row.characterGrade.totalCharacters, totalCharacters);

    // A row that has never been graded (no attempt/result at all) has no characterGrade.
    const otherRow = rows.find((r) => r.sessionItemId === item.id && r.studentId === 3);
    assert.equal(otherRow.characterGrade, null);
});

// ---------------------------------------------------------------------
// Phase 10: formal-test extras — instructions, item length, participant restriction
// ---------------------------------------------------------------------

test('createSession: persists instructions and itemLength verbatim', () => {
    const session = makeSession({ instructions: 'Type in capital letters.', itemLength: 7 });
    assert.equal(session.instructions, 'Type in capital letters.');
    assert.equal(session.itemLength, 7);

    const reloaded = sessionRepository.findByIdPublic(session.id);
    assert.equal(reloaded.instructions, 'Type in capital letters.');
    assert.equal(reloaded.itemLength, 7);
});

test('createSession: a session with no participantIds has participantIds === null (whole-class default, unchanged from Phase 8)', () => {
    const session = makeSession();
    assert.equal(session.participantIds, null);
});

test('validateParticipantIds: keeps only real, active students actually in the given class', () => {
    // 2 and 3 are real students in class 1; 4 is in class 2; 999 doesn't exist.
    const valid = sessionRepository.validateParticipantIds(1, [2, 3, 4, 999]);
    assert.deepEqual(valid.sort(), [2, 3]);
});

test('validateParticipantIds: empty/missing input returns an empty list', () => {
    assert.deepEqual(sessionRepository.validateParticipantIds(1, []), []);
    assert.deepEqual(sessionRepository.validateParticipantIds(1, undefined), []);
});

test('participant restriction: narrows availability, roster, join-eligibility, and results to only the selected students', () => {
    const restricted = makeSession({ type: 'test', participantIds: [2] }); // only Ann (id 2), not Bob (id 3)
    sessionRepository.transitionStatus(restricted.id, ['created'], 'waiting', {});

    // Availability: Ann sees it, Bob does not, even though both are in the same class.
    const availableToAnn = sessionRepository.listAvailableForStudent(2, 1).map((s) => s.id);
    const availableToBob = sessionRepository.listAvailableForStudent(3, 1).map((s) => s.id);
    assert.ok(availableToAnn.includes(restricted.id));
    assert.ok(!availableToBob.includes(restricted.id));

    // Roster: only Ann appears, not the whole class.
    const roster = sessionRepository.listRoster(restricted.id, 1, sessionRepository.findByIdPublic(restricted.id).participantIds);
    assert.deepEqual(
        roster.map((r) => r.studentId),
        [2]
    );

    // Join-eligibility: Ann passes, Bob is rejected outright despite being a real classmate.
    assert.equal(sessionRepository.isStudentInSessionClass(restricted.id, 2), true);
    assert.equal(sessionRepository.isStudentInSessionClass(restricted.id, 3), false);

    // Results: only Ann's row(s) appear in the teacher-facing full results view.
    const item = sessionRepository.getItemByIndex(restricted.id, 0);
    sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: item.exercise.text, durationMs: 100 });
    const results = sessionRepository.listResultsForSession(restricted.id);
    assert.ok(results.every((r) => r.studentId === 2), 'Bob must never appear in a test he was not selected for');
});

test('a session without a participant restriction still behaves exactly as before (whole class eligible)', () => {
    const open = makeSession(); // no participantIds override
    sessionRepository.transitionStatus(open.id, ['created'], 'waiting', {});
    assert.equal(sessionRepository.isStudentInSessionClass(open.id, 2), true);
    assert.equal(sessionRepository.isStudentInSessionClass(open.id, 3), true);
    const roster = sessionRepository.listRoster(open.id, 1, sessionRepository.findByIdPublic(open.id).participantIds);
    assert.equal(roster.length, 2);
});

test('generateItems: an explicit length override produces items of exactly that length', () => {
    // Not audio_to_text: that mode is now always a fixed-shape 3x10x4
    // radiogram (see buildRadiogramExercise) and deliberately ignores
    // length overrides — this test covers the still-unchanged generic
    // practiceEngine.buildExercise path every other mode uses.
    const { items } = sessionEngine.generateItems({ exerciseMode: 'morse_to_text', difficulty: 'medium', exerciseCount: 3, length: 9 });
    items.forEach((item) => {
        assert.equal(item.exercise.text.replace(/\s/g, '').length, 9);
    });
});

// ---------------------------------------------------------------------
// Phase 11: createSessionWithItems atomicity
// ---------------------------------------------------------------------

test('createSessionWithItems: creates the session and inserts all items in one atomic transaction', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 3 });
    const session = sessionRepository.createSessionWithItems(
        {
            classId: 1,
            type: 'test',
            exerciseMode: 'audio_to_text',
            difficulty: 'easy',
            exerciseCount: 3,
            prepTimeMs: 5000,
            answerTimeMs: 20000,
            allowedAttempts: 1,
            passThresholdPercent: 70,
            createdBy: 1,
        },
        items
    );
    const persisted = sessionRepository.listItems(session.id);
    assert.equal(persisted.length, 3);
});

test('createSessionWithItems: if item insertion fails, the session row is rolled back too (nothing half-created)', () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;

    // A malformed item (missing the fields insertItemsTxn requires) forces insertion to throw
    // partway through, which must roll back the whole transaction — including the session row
    // created earlier in the same call — not leave an orphaned session with zero items.
    assert.throws(() => {
        sessionRepository.createSessionWithItems(
            {
                classId: 1,
                type: 'test',
                exerciseMode: 'audio_to_text',
                difficulty: 'easy',
                exerciseCount: 1,
                prepTimeMs: 5000,
                answerTimeMs: 20000,
                allowedAttempts: 1,
                passThresholdPercent: 70,
                createdBy: 1,
            },
            [{ /* deliberately malformed: no exercise/plan data */ }]
        );
    });

    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    assert.equal(countAfter, countBefore, 'a failed item-insert must roll back the session row created in the same transaction');
});
