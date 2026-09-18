/**
 * Verifies the statistics queries against a real, isolated temp database
 * — and specifically that they never fabricate a number (0%, NaN) when
 * there simply isn't any data yet, since that's the exact "misleading
 * statistic" failure mode this module was built to avoid.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-stats-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const sessionRepository = require('../../sessions/sessionRepository');
const sessionEngine = require('../../sessions/sessionEngine');
const stats = require('../statsRepository');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Stats Class')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (1, 'teacher1', 'x', 'teacher', NULL)").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (3, 'stud2', 'x', 'student', 1, 'Bob', 'Jones')"
).run();

function insertPracticeAttempt(studentId, accuracyPercent) {
    db.prepare(
        `INSERT INTO practice_attempts (
            student_id, exercise_type, difficulty, wpm, prompt_text, prompt_morse, expected_answer,
            submitted_answer, correct_count, incorrect_count, missing_count, extra_count, accuracy_percent
        ) VALUES (?, 'audio_to_text', 'easy', 12, 'HI', '.... ..', 'HI', 'HI', 2, 0, 0, 0, ?)`
    ).run(studentId, accuracyPercent);
}

// ---------------------------------------------------------------------
// A student with zero data — must get nulls/empty, never fabricated zeros
// ---------------------------------------------------------------------

test('getStudentPracticeSummary: a student with no attempts gets null/empty, not misleading zeros', () => {
    const summary = stats.getStudentPracticeSummary(3);
    assert.equal(summary.attemptCount, 0);
    assert.equal(summary.avgAccuracy, null);
    assert.deepEqual(summary.byExerciseType, []);
    assert.equal(summary.recentTrend, null);
});

test('getStudentSessionSummary: a student with no finished sessions gets an empty array', () => {
    assert.deepEqual(stats.getStudentSessionSummary(3), []);
});

// ---------------------------------------------------------------------
// Practice summary with real data
// ---------------------------------------------------------------------

test('getStudentPracticeSummary: computes count/average correctly and omits the trend below 10 attempts', () => {
    for (let i = 0; i < 5; i += 1) insertPracticeAttempt(2, 80);
    const summary = stats.getStudentPracticeSummary(2);
    assert.equal(summary.attemptCount, 5);
    assert.equal(summary.avgAccuracy, 80);
    assert.equal(summary.recentTrend, null, 'fewer than 10 attempts should not produce a "trend" — not enough data to mean anything');
});

test('getStudentPracticeSummary: reveals a recentTrend once there are at least 10 attempts', () => {
    for (let i = 0; i < 5; i += 1) insertPracticeAttempt(2, 100); // 5 more, all perfect, on top of the 5×80 above
    const summary = stats.getStudentPracticeSummary(2);
    assert.equal(summary.attemptCount, 10);
    assert.ok(summary.recentTrend);
    assert.equal(summary.recentTrend.recentAvgAccuracy, 100);
    assert.equal(summary.recentTrend.overallAvgAccuracy, 90);
});

test('getStudentAccuracyByDay: groups by day and never fabricates a day with no attempts', () => {
    const rows = stats.getStudentAccuracyByDay(2, { days: 14 });
    assert.equal(rows.length, 1, 'all attempts were inserted today, so exactly one day-row should exist');
    assert.equal(rows[0].count, 10);
});

// ---------------------------------------------------------------------
// Session/test summary — finished-only, null-vs-zero pass rate
// ---------------------------------------------------------------------

function makeFinishedTestSession({ passThresholdPercent = 70 } = {}) {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 2 });
    const session = sessionRepository.createSessionWithItems(
        {
            classId: 1,
            type: 'test',
            exerciseMode: 'audio_to_text',
            difficulty: 'easy',
            exerciseCount: 2,
            prepTimeMs: 5000,
            answerTimeMs: 20000,
            allowedAttempts: 1,
            passThresholdPercent,
            createdBy: 1,
        },
        items
    );
    const sessionItems = sessionRepository.listItems(session.id);
    sessionItems.forEach((item, idx) => {
        const attempt = sessionRepository.upsertAttempt({
            sessionItemId: item.id,
            studentId: 2,
            submittedText: idx === 0 ? item.exercise.text : 'WRONGANSWER',
            durationMs: 100,
        });
        const score = sessionEngine.gradeSubmission(item.exercise, idx === 0 ? item.exercise.text : 'WRONGANSWER');
        sessionRepository.upsertResult({
            attemptId: attempt.id,
            score: score.accuracyPercent,
            errorCount: 0,
            grade: sessionEngine.computeGrade(score.accuracyPercent, passThresholdPercent),
        });
    });
    sessionRepository.transitionStatus(session.id, ['created'], 'finished', { ended_at: new Date().toISOString() });
    return session;
}

test('getStudentSessionSummary: only counts finished sessions, and computes a real pass rate from graded results', () => {
    makeFinishedTestSession();
    const rows = stats.getStudentSessionSummary(2);
    const testRow = rows.find((r) => r.type === 'test');
    assert.ok(testRow);
    assert.equal(testRow.sessionCount, 1);
    assert.equal(testRow.gradedItemCount, 2);
    assert.equal(testRow.passCount + testRow.failCount, 2);
    assert.equal(testRow.passRatePercent, (testRow.passCount / 2) * 100);
});

test('getStudentSessionSummary: an ungraded group session (no pass threshold) reports passRatePercent as null, not 0', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1 });
    const session = sessionRepository.createSessionWithItems(
        {
            classId: 1,
            type: 'group',
            exerciseMode: 'audio_to_text',
            difficulty: 'easy',
            exerciseCount: 1,
            prepTimeMs: 5000,
            answerTimeMs: null,
            allowedAttempts: 1,
            passThresholdPercent: null,
            createdBy: 1,
        },
        items
    );
    const item = sessionRepository.getItemByIndex(session.id, 0);
    const attempt = sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: item.exercise.text, durationMs: 50 });
    const score = sessionEngine.gradeSubmission(item.exercise, item.exercise.text);
    sessionRepository.upsertResult({ attemptId: attempt.id, score: score.accuracyPercent, errorCount: 0, grade: sessionEngine.computeGrade(score.accuracyPercent, null) });
    sessionRepository.transitionStatus(session.id, ['created'], 'finished', { ended_at: new Date().toISOString() });

    const rows = stats.getStudentSessionSummary(2);
    const groupRow = rows.find((r) => r.type === 'group');
    assert.ok(groupRow);
    assert.equal(groupRow.passCount, 0);
    assert.equal(groupRow.failCount, 0);
    assert.equal(groupRow.passRatePercent, null, 'no pass threshold was ever configured, so there is nothing to compute a pass rate from');
});

test('an in-progress (not finished) session never appears in the summary', () => {
    const { items } = sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1 });
    const session = sessionRepository.createSessionWithItems(
        { classId: 1, type: 'test', exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, prepTimeMs: 5000, answerTimeMs: 20000, allowedAttempts: 1, passThresholdPercent: 70, createdBy: 1 },
        items
    );
    // Deliberately left in 'created' status — never finished.
    const before = stats.getStudentSessionSummary(2).find((r) => r.type === 'test');
    const item = sessionRepository.getItemByIndex(session.id, 0);
    sessionRepository.upsertAttempt({ sessionItemId: item.id, studentId: 2, submittedText: 'X', durationMs: 50 });
    const after = stats.getStudentSessionSummary(2).find((r) => r.type === 'test');
    assert.deepEqual(before, after, 'an attempt on a not-yet-finished session must not change the summary at all');
});

// ---------------------------------------------------------------------
// Class-level aggregates
// ---------------------------------------------------------------------

test('getClassStudentBreakdown: includes every active student, even ones with zero data', () => {
    const breakdown = stats.getClassStudentBreakdown(1);
    const ids = breakdown.map((r) => r.studentId).sort();
    assert.deepEqual(ids, [2, 3]);
    const bob = breakdown.find((r) => r.studentId === 3);
    assert.equal(bob.practiceAttemptCount, 0);
    assert.equal(bob.practiceAvgAccuracy, null);
});

test('getClassPracticeSummary: aggregates across the whole class, not just one student', () => {
    const summary = stats.getClassPracticeSummary(1);
    assert.equal(summary.attemptCount, 10); // only Ann's 10 practice attempts exist
});
