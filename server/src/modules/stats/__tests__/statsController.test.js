/**
 * Teacher result management: viewing a student's/class's per-exercise
 * history, deleting individual practice attempts, resetting a student's
 * training history, and CSV export. Same mock req/res + real isolated
 * temp DB pattern as sessionsController.test.js. Route-level permission
 * enforcement (requireRole('teacher')/requireSelfOrTeacher) is not
 * re-tested here — this codebase has no per-route permission tests
 * anywhere (that's exercised live; see the session's own manual HTTP
 * smoke test) — these tests cover what each controller function itself
 * does once past that gate.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-stats-controller-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const practiceRepository = require('../../practice/practiceRepository');
const statsController = require('../statsController');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Class A')").run();
db.prepare("INSERT INTO classes (id, name) VALUES (2, 'Class B')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (1, 'teacher1', 'x', 'teacher', NULL)").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (3, 'stud2', 'x', 'student', 1, 'Bob', 'Jones')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (4, 'other1', 'x', 'student', 2, 'Zed', 'Other')"
).run();

function mockRes() {
    const res = { statusCode: 200, body: undefined, headers: {} };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    res.setHeader = (name, value) => {
        res.headers[name] = value;
    };
    res.send = (body) => {
        res.body = body;
        return res;
    };
    return res;
}

function reqAsTeacher(params, query = {}) {
    return { params, query, user: { id: 1, username: 'teacher1', role: 'teacher' } };
}

function insertAttempt(studentId, overrides = {}) {
    const exerciseType = overrides.exerciseType || 'audio_to_text';
    const wpm = overrides.wpm ?? 15;
    const accuracyPercent = overrides.accuracyPercent ?? 90;
    const correctCount = overrides.correctCount ?? 9;
    const incorrectCount = overrides.incorrectCount ?? 1;
    return db
        .prepare(
            `INSERT INTO practice_attempts (
                student_id, exercise_type, difficulty, wpm, prompt_text, prompt_morse, expected_answer,
                submitted_answer, correct_count, incorrect_count, missing_count, extra_count, accuracy_percent, timing_stats_json
            ) VALUES (?, ?, NULL, ?, 'X', 'X', 'X', 'X', ?, ?, 0, 0, ?, ?)`
        )
        .run(studentId, exerciseType, wpm, correctCount, incorrectCount, accuracyPercent, overrides.timingStats ? JSON.stringify(overrides.timingStats) : null).lastInsertRowid;
}

// ---------------------------------------------------------------------
// getStudentHistory
// ---------------------------------------------------------------------

test('getStudentHistory: a teacher sees the full, filterable history for a student, with grade/direction/timing data', () => {
    insertAttempt(2, { exerciseType: 'radiogram_training', wpm: 15, accuracyPercent: 100, correctCount: 10, incorrectCount: 0 });
    insertAttempt(2, {
        exerciseType: 'text_to_morse',
        wpm: 25,
        accuracyPercent: 80,
        correctCount: 4,
        incorrectCount: 1,
        timingStats: { actualWpm: 24.5, rhythmConsistencyPercent: 88 },
    });

    const res = mockRes();
    statsController.getStudentHistory(reqAsTeacher({ id: '2' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 2);
    const tx = res.body.attempts.find((a) => a.exerciseType === 'text_to_morse');
    assert.equal(tx.direction, 'transmission');
    assert.ok(tx.characterGrade);
    assert.equal(tx.timingStats.actualWpm, 24.5);
    const rx = res.body.attempts.find((a) => a.exerciseType === 'radiogram_training');
    assert.equal(rx.direction, 'reception');
});

test('getStudentHistory: 404 for a non-student id (e.g. a teacher account)', () => {
    const res = mockRes();
    statsController.getStudentHistory(reqAsTeacher({ id: '1' }), res);
    assert.equal(res.statusCode, 404);
});

test('getStudentHistory: direction filter narrows correctly for a teacher-viewed student', () => {
    const res = mockRes();
    statsController.getStudentHistory(reqAsTeacher({ id: '2' }, { direction: 'transmission' }), res);
    assert.equal(res.body.total, 1);
    assert.ok(res.body.attempts.every((a) => a.direction === 'transmission'));
});

// ---------------------------------------------------------------------
// deleteStudentAttempt
// ---------------------------------------------------------------------

test('deleteStudentAttempt: deletes exactly the targeted attempt', () => {
    const id = insertAttempt(3, { exerciseType: 'audio_to_text' });
    const before = practiceRepository.countForStudent(3);

    const res = mockRes();
    statsController.deleteStudentAttempt(reqAsTeacher({ id: '3', attemptId: String(id) }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deleted, true);
    assert.equal(practiceRepository.countForStudent(3), before - 1);
    assert.equal(practiceRepository.findById(id), null);
});

test('deleteStudentAttempt: 404 when the attempt does not exist', () => {
    const res = mockRes();
    statsController.deleteStudentAttempt(reqAsTeacher({ id: '3', attemptId: '999999' }), res);
    assert.equal(res.statusCode, 404);
});

test('deleteStudentAttempt: cannot delete another student\'s attempt by passing a mismatched id in the URL (defense in depth)', () => {
    const idBelongingToStudent2 = insertAttempt(2, { exerciseType: 'audio_to_text' });
    const before = practiceRepository.countForStudent(2);

    // Attacker/bug scenario: attemptId is real, but :id in the URL names a DIFFERENT student.
    const res = mockRes();
    statsController.deleteStudentAttempt(reqAsTeacher({ id: '3', attemptId: String(idBelongingToStudent2) }), res);

    assert.equal(res.statusCode, 404, 'must refuse — the attempt does not belong to student 3');
    assert.equal(practiceRepository.countForStudent(2), before, 'student 2\'s attempt must be untouched');
});

// ---------------------------------------------------------------------
// resetStudentHistory
// ---------------------------------------------------------------------

test('resetStudentHistory: with no filters, deletes the student\'s entire practice history', () => {
    insertAttempt(4, { exerciseType: 'audio_to_text' });
    insertAttempt(4, { exerciseType: 'text_to_morse' });
    const countBefore = practiceRepository.countForStudent(4);
    assert.ok(countBefore >= 2);

    const res = mockRes();
    statsController.resetStudentHistory(reqAsTeacher({ id: '4' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.deletedCount, countBefore);
    assert.equal(practiceRepository.countForStudent(4), 0);
});

test('resetStudentHistory: a direction filter resets only that part of the history, leaving the rest intact', () => {
    insertAttempt(4, { exerciseType: 'audio_to_text' });
    insertAttempt(4, { exerciseType: 'radiogram_training' });
    insertAttempt(4, { exerciseType: 'text_to_morse' });
    const beforeTotal = practiceRepository.countForStudent(4);

    const res = mockRes();
    statsController.resetStudentHistory(reqAsTeacher({ id: '4' }, { direction: 'reception' }), res);

    assert.equal(res.body.deletedCount, 2); // audio_to_text + radiogram_training
    const remaining = practiceRepository.listForStudent(4);
    assert.equal(remaining.length, beforeTotal - 2);
    assert.ok(remaining.every((a) => a.direction === 'transmission'));
});

test('resetStudentHistory: never touches formal test / session data (only practice_attempts)', () => {
    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    const res = mockRes();
    statsController.resetStudentHistory(reqAsTeacher({ id: '2' }), res);
    assert.equal(res.statusCode, 200);
    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    assert.equal(countAfter, countBefore, 'resetting practice history must never touch the sessions table');
});

// ---------------------------------------------------------------------
// getClassAttempts
// ---------------------------------------------------------------------

test('getClassAttempts: spans every student in the class, and never leaks a different class\'s students', () => {
    insertAttempt(2, { exerciseType: 'audio_to_text' });
    insertAttempt(3, { exerciseType: 'text_to_morse' });
    insertAttempt(4, { exerciseType: 'audio_to_text' }); // class 2 — must never appear in class 1's results

    const res = mockRes();
    statsController.getClassAttempts(reqAsTeacher({ id: '1' }), res);

    assert.equal(res.statusCode, 200);
    assert.ok(res.body.attempts.length > 0);
    assert.ok(res.body.attempts.every((a) => a.studentId === 2 || a.studentId === 3), 'class-1 view must never include student 4 (class 2)');
});

test('getClassAttempts: narrows to one student within the class via studentId', () => {
    const res = mockRes();
    statsController.getClassAttempts(reqAsTeacher({ id: '1' }, { studentId: '3' }), res);
    assert.ok(res.body.attempts.every((a) => a.studentId === 3));
});

test('getClassAttempts: 404 for a class that does not exist', () => {
    const res = mockRes();
    statsController.getClassAttempts(reqAsTeacher({ id: '999' }), res);
    assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------
// exportClassCsv
// ---------------------------------------------------------------------

test('exportClassCsv: produces a well-formed CSV with the expected columns and Excel-friendly headers', () => {
    const res = mockRes();
    statsController.exportClassCsv(reqAsTeacher({ id: '1' }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.ok(res.headers['Content-Disposition'].includes('attachment'));
    assert.ok(res.headers['Content-Disposition'].includes('.csv'));
    assert.ok(res.body.startsWith('﻿'), 'CSV export must start with a UTF-8 BOM for Excel');

    const lines = res.body.slice(1).trim().split('\r\n');
    const header = 'Student,Username,Class,Date/Time,Exercise Type,Direction,WPM,Correct,Errors,Accuracy %,Grade,Actual WPM (Transmission),Rhythm Consistency % (Transmission)';
    assert.ok(lines[0].startsWith('Class Report,'), 'the report opens with a class heading');
    // One clearly separated section per student: a heading line, the
    // column headers repeated, that student's rows, then a blank line.
    const headingIndexes = lines.map((l, i) => (l.startsWith('Student: ') ? i : -1)).filter((i) => i >= 0);
    assert.ok(headingIndexes.length >= 1, 'must include at least one student section');
    headingIndexes.forEach((i) => assert.equal(lines[i + 1], header));
    headingIndexes.slice(1).forEach((i) => assert.equal(lines[i - 1], '', 'sections are separated by a blank line'));
    const dataRows = lines.filter((l) => l && l !== header && !l.startsWith('Student: ') && !/^(Class Report|Generated|Students|Results),/.test(l));
    assert.ok(dataRows.length > 0, 'must include at least one data row');
    dataRows.forEach((l) => assert.equal(l.split(',').length, header.split(',').length, 'every data row keeps every column'));
});

test('exportClassCsv: narrowing to one student only exports that student\'s rows', () => {
    const res = mockRes();
    statsController.exportClassCsv(reqAsTeacher({ id: '1' }, { studentId: '3' }), res);
    const allLines = res.body.slice(1).trim().split('\r\n');
    assert.equal(allLines.filter((l) => l.startsWith('Student: ')).length, 1, 'exactly one student section');
    const lines = allLines.filter((l) => l.includes(',stud') && !l.startsWith('Student: ') && !l.startsWith('Student,Username'));
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.startsWith('Bob Jones,stud2,')));
});

test('exportClassCsv: 404 for a class that does not exist', () => {
    const res = mockRes();
    statsController.exportClassCsv(reqAsTeacher({ id: '999' }), res);
    assert.equal(res.statusCode, 404);
});
