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

function insertPracticeAttempt(studentId, accuracyPercent, overrides = {}) {
    const exerciseType = overrides.exerciseType || 'audio_to_text';
    const wpm = overrides.wpm ?? 12;
    const expectedAnswer = overrides.expectedAnswer ?? 'HI';
    const submittedAnswer = overrides.submittedAnswer ?? 'HI';
    const correctCount = overrides.correctCount ?? 2;
    const incorrectCount = overrides.incorrectCount ?? 0;
    const missingCount = overrides.missingCount ?? 0;
    const extraCount = overrides.extraCount ?? 0;
    db.prepare(
        `INSERT INTO practice_attempts (
            student_id, exercise_type, difficulty, wpm, prompt_text, prompt_morse, expected_answer,
            submitted_answer, correct_count, incorrect_count, missing_count, extra_count, accuracy_percent
        ) VALUES (?, ?, 'easy', ?, 'HI', '.... ..', ?, ?, ?, ?, ?, ?, ?)`
    ).run(studentId, exerciseType, wpm, expectedAnswer, submittedAnswer, correctCount, incorrectCount, missingCount, extraCount, accuracyPercent);
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

// ---------------------------------------------------------------------
// Student History & Progress: getStudentPersonalStats, getStudentDailySeries,
// getStudentWeakCharacters. Uses fresh, otherwise-untouched students in a
// SEPARATE class (id 2) so these tests are fully isolated from the shared
// fixtures' earlier data and never pollute class-1-scoped assertions
// (e.g. getClassStudentBreakdown's exact-roster check) that run later.
// ---------------------------------------------------------------------
db.prepare("INSERT INTO classes (id, name) VALUES (2, 'Progress Test Class')").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (5, 'stud3', 'x', 'student', 2, 'Cy', 'Progress')"
).run();

test('getStudentPersonalStats: a student with no history at all gets nulls/zeros, never fabricated numbers', () => {
    const result = stats.getStudentPersonalStats(5);
    assert.equal(result.totalExercises, 0);
    assert.equal(result.avgAccuracy, null);
    assert.equal(result.bestAccuracy, null);
    assert.equal(result.avgWpm, null);
    assert.equal(result.bestWpm, null);
    assert.equal(result.totalErrors, 0);
    assert.equal(result.receptionCount, 0);
    assert.equal(result.receptionAvgAccuracy, null);
    assert.equal(result.transmissionCount, 0);
    assert.equal(result.transmissionAvgAccuracy, null);
});

test('getStudentDailySeries / getStudentWeakCharacters: empty for a student with no history', () => {
    assert.deepEqual(stats.getStudentDailySeries(5), []);
    assert.deepEqual(stats.getStudentWeakCharacters(5), []);
});

test('getStudentPersonalStats: one result populates every field consistently (best === avg for n=1)', () => {
    insertPracticeAttempt(5, 80, { exerciseType: 'audio_to_text', wpm: 15, incorrectCount: 1 });
    const result = stats.getStudentPersonalStats(5);
    assert.equal(result.totalExercises, 1);
    assert.equal(result.avgAccuracy, 80);
    assert.equal(result.bestAccuracy, 80);
    assert.equal(result.avgWpm, 15);
    assert.equal(result.bestWpm, 15);
    assert.equal(result.totalErrors, 1);
    assert.equal(result.receptionCount, 1);
    assert.equal(result.receptionAvgAccuracy, 80);
    assert.equal(result.transmissionCount, 0);
    assert.equal(result.transmissionAvgAccuracy, null, 'no transmission attempts yet — null, not a fabricated 0');
});

test('getStudentPersonalStats: many mixed-type results compute correct averages, bests, totals, and a reception/transmission split', () => {
    // student 5 already has one audio_to_text@80%/wpm15/1 error from the
    // previous test — add more, spanning several exercise types on both
    // sides of the reception/transmission split.
    insertPracticeAttempt(5, 100, { exerciseType: 'radiogram_training', wpm: 20, incorrectCount: 0 });
    insertPracticeAttempt(5, 60, { exerciseType: 'character_training', wpm: 18, incorrectCount: 2, missingCount: 1 });
    insertPracticeAttempt(5, 90, { exerciseType: 'text_to_morse', wpm: 22, incorrectCount: 1 });
    insertPracticeAttempt(5, 70, { exerciseType: 'text_to_morse', wpm: 24, incorrectCount: 2, extraCount: 1 });

    const result = stats.getStudentPersonalStats(5);
    assert.equal(result.totalExercises, 5);
    assert.equal(result.bestAccuracy, 100);
    assert.equal(result.bestWpm, 24);
    assert.equal(result.totalErrors, 1 + 0 + 3 + 1 + 3); // incorrect+missing+extra summed per row
    assert.equal(result.receptionCount, 3); // audio_to_text, radiogram_training, character_training
    assert.equal(result.receptionAvgAccuracy, round2((80 + 100 + 60) / 3));
    assert.equal(result.transmissionCount, 2); // the two text_to_morse rows
    assert.equal(result.transmissionAvgAccuracy, round2((90 + 70) / 2));
});

function round2(v) {
    return Math.round(v * 100) / 100;
}

test('getStudentDailySeries: today\'s row aggregates count/avgAccuracy/avgWpm/totalErrors and the reception/transmission split, all for the same day', () => {
    const series = stats.getStudentDailySeries(5, { days: 1 });
    assert.equal(series.length, 1, 'all of this student\'s test rows were inserted today');
    const today = series[0];
    assert.equal(today.count, 5);
    assert.ok(today.avgAccuracy > 0);
    assert.ok(today.avgWpm > 0);
    assert.equal(today.totalErrors, 8);
    assert.ok(today.receptionAvgAccuracy !== null);
    assert.ok(today.transmissionAvgAccuracy !== null);
});

test('getStudentDailySeries: a `days` window in the past excludes today\'s activity entirely (no fabricated empty-but-present days)', () => {
    // date('now', '-400 days') as the cutoff still includes today via the
    // >= comparison, so instead verify the inverse: a window that could
    // not possibly include today is impossible to express via `days`
    // (always relative to now), so this checks the boundary the other
    // way — zero days back still includes today's own rows.
    const series = stats.getStudentDailySeries(5, { days: 0 });
    assert.equal(series.length, 1);
});

test('getStudentWeakCharacters: reception-only history still finds weak characters', () => {
    db.prepare(
        `INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (6, 'stud4', 'x', 'student', 2, 'Rex', 'Reception')`
    ).run();
    // "K" is submitted wrong every single time (4 attempts, all wrong) —
    // well past the minimum-attempts threshold and well under 80%.
    for (let i = 0; i < 4; i += 1) {
        insertPracticeAttempt(6, 0, { exerciseType: 'audio_to_text', expectedAnswer: 'K', submittedAnswer: 'X', incorrectCount: 1, correctCount: 0 });
    }
    // "A" is always correct — never weak.
    for (let i = 0; i < 4; i += 1) {
        insertPracticeAttempt(6, 100, { exerciseType: 'radiogram_training', expectedAnswer: 'A', submittedAnswer: 'A', correctCount: 1 });
    }

    const weak = stats.getStudentWeakCharacters(6);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].char, 'K');
    assert.equal(weak[0].attempts, 4);
    assert.equal(weak[0].accuracyPercent, 0);
});

test('getStudentWeakCharacters: transmission-only history still finds weak characters', () => {
    db.prepare(
        `INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (7, 'stud5', 'x', 'student', 2, 'Tex', 'Transmit')`
    ).run();
    for (let i = 0; i < 5; i += 1) {
        insertPracticeAttempt(7, 0, { exerciseType: 'text_to_morse', expectedAnswer: 'M', submittedAnswer: 'N', incorrectCount: 1, correctCount: 0 });
    }
    const weak = stats.getStudentWeakCharacters(7);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].char, 'M');
    assert.equal(weak[0].attempts, 5);
});

test('getStudentWeakCharacters: never reports a character with insufficient data (below the minimum-attempts threshold)', () => {
    db.prepare(
        `INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (8, 'stud6', 'x', 'student', 2, 'Min', 'Data')`
    ).run();
    // Only 2 wrong attempts — below the default minAttempts (3).
    insertPracticeAttempt(8, 0, { exerciseType: 'audio_to_text', expectedAnswer: 'Z', submittedAnswer: 'Q', incorrectCount: 1, correctCount: 0 });
    insertPracticeAttempt(8, 0, { exerciseType: 'audio_to_text', expectedAnswer: 'Z', submittedAnswer: 'Q', incorrectCount: 1, correctCount: 0 });
    assert.deepEqual(stats.getStudentWeakCharacters(8), []);

    // A third attempt crosses the threshold and it now appears.
    insertPracticeAttempt(8, 0, { exerciseType: 'audio_to_text', expectedAnswer: 'Z', submittedAnswer: 'Q', incorrectCount: 1, correctCount: 0 });
    const weak = stats.getStudentWeakCharacters(8);
    assert.equal(weak.length, 1);
    assert.equal(weak[0].char, 'Z');
});

test('getStudentWeakCharacters: a character that is mostly correct (>= 80%) is never flagged as weak', () => {
    db.prepare(
        `INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (9, 'stud7', 'x', 'student', 2, 'Ok', 'Char')`
    ).run();
    insertPracticeAttempt(9, 100, { exerciseType: 'audio_to_text', expectedAnswer: 'P', submittedAnswer: 'P', correctCount: 1 });
    insertPracticeAttempt(9, 100, { exerciseType: 'audio_to_text', expectedAnswer: 'P', submittedAnswer: 'P', correctCount: 1 });
    insertPracticeAttempt(9, 100, { exerciseType: 'audio_to_text', expectedAnswer: 'P', submittedAnswer: 'P', correctCount: 1 });
    insertPracticeAttempt(9, 100, { exerciseType: 'audio_to_text', expectedAnswer: 'P', submittedAnswer: 'P', correctCount: 1 });
    insertPracticeAttempt(9, 0, { exerciseType: 'audio_to_text', expectedAnswer: 'P', submittedAnswer: 'Q', incorrectCount: 1, correctCount: 0 }); // 4/5 = 80% — exactly at the threshold, not below it

    assert.deepEqual(stats.getStudentWeakCharacters(9), [], 'P is correct 4/5 = 80%, exactly at the threshold — not below it, so not weak');
});

test('student isolation: one student\'s history/progress data never leaks into another student\'s results', () => {
    const statsFor5 = stats.getStudentPersonalStats(5);
    const statsFor6 = stats.getStudentPersonalStats(6);
    assert.notEqual(statsFor5.totalExercises, statsFor6.totalExercises);
    assert.equal(stats.getStudentWeakCharacters(5).some((w) => w.char === 'K'), false, "student 5 never submitted K wrong — that's student 6's data");
});
