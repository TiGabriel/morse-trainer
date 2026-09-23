/**
 * Electronic gradebook controller: manual grade/note entries, the
 * temporary -> permanent lifecycle of automatic Formal Test entries, and
 * the rules that protect a permanently saved Formal Test grade. Plain
 * mock req/res (no Express) + a real isolated temp DB, same pattern as
 * the sessions/stats controller tests. Route-level teacher-only
 * authorization is covered by gradebookRoutes' requireRole('teacher')
 * and checked end-to-end over HTTP separately.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-gradebook-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const gradebookRepository = require('../gradebookRepository');
const gradebookController = require('../gradebookController');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Class A')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, first_name, last_name) VALUES (1, 'teacher1', 'x', 'teacher', 'Tina', 'Teach')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')").run();
db.prepare(
    "INSERT INTO sessions (id, class_id, type, status, exercise_mode, difficulty, created_by) VALUES (7, 1, 'test', 'finished', 'morse_to_text', 'easy', 1)"
).run();

function mockRes() {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    return res;
}

const teacher = { id: 1, username: 'teacher1', role: 'teacher' };

function call(handler, { params = {}, body } = {}) {
    const res = mockRes();
    handler({ params, body, user: teacher }, res);
    return res;
}

test('createEntry: a manual grade is saved permanently, with teacher and timestamps', () => {
    const res = call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'grade', grade: 9, note: 'Oral test' } });
    assert.equal(res.statusCode, 201);
    const { entry } = res.body;
    assert.equal(entry.type, 'grade');
    assert.equal(entry.grade, 9);
    assert.equal(entry.note, 'Oral test');
    assert.equal(entry.source, 'manual');
    assert.equal(entry.isPermanent, true);
    assert.equal(entry.teacherId, 1);
    assert.equal(entry.teacherName, 'Tina Teach');
    assert.ok(entry.createdAt);
});

test('createEntry: a manual note needs text; a grade must be a whole number 1-10', () => {
    assert.equal(call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'note', note: '  ' } }).statusCode, 400);
    assert.equal(call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'grade', grade: 11 } }).statusCode, 400);
    assert.equal(call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'grade', grade: 7.5 } }).statusCode, 400);
    assert.equal(call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'bogus' } }).statusCode, 400);
    const ok = call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'note', note: 'Keeps a steady rhythm.' } });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.body.entry.grade, null);
});

test('createEntry / listStudentEntries: 404 for a non-student or unknown id', () => {
    assert.equal(call(gradebookController.createEntry, { params: { studentId: '1' }, body: { type: 'note', note: 'x' } }).statusCode, 404);
    assert.equal(call(gradebookController.listStudentEntries, { params: { studentId: '999' } }).statusCode, 404);
});

test('listStudentEntries: returns the student and every entry, newest first', () => {
    const res = call(gradebookController.listStudentEntries, { params: { studentId: '2' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.student.id, 2);
    assert.ok(res.body.entries.length >= 2);
    const ids = res.body.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
});

test('Formal Test entry lifecycle: temporary -> edit grade -> Save permanently -> grade locked, cannot delete', () => {
    assert.equal(
        gradebookRepository.insertFormalTestEntry({ studentId: 2, teacherId: 1, sessionId: 7, grade: 6, details: { accuracyPercent: 55 } }),
        true
    );
    assert.equal(
        gradebookRepository.insertFormalTestEntry({ studentId: 2, teacherId: 1, sessionId: 7, grade: 6 }),
        false,
        'a second insert for the same student/test is ignored'
    );
    const entry = gradebookRepository.listForStudent(2).find((e) => e.source === 'formal_test');
    assert.equal(entry.isPermanent, false);
    assert.deepEqual(entry.details, { accuracyPercent: 55 });

    const pending = call(gradebookController.getPendingCounts);
    assert.equal(pending.body.pending[2], 1);

    const edited = call(gradebookController.updateEntry, { params: { entryId: String(entry.id) }, body: { grade: 7, note: 'Reviewed' } });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.body.entry.grade, 7);

    const confirmed = call(gradebookController.confirmEntry, { params: { entryId: String(entry.id) } });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.body.entry.isPermanent, true);
    assert.equal(call(gradebookController.getPendingCounts).body.pending[2], undefined);

    assert.equal(call(gradebookController.updateEntry, { params: { entryId: String(entry.id) }, body: { grade: 10 } }).statusCode, 409);
    assert.equal(call(gradebookController.deleteEntry, { params: { entryId: String(entry.id) } }).statusCode, 409);
    // Its note can still be annotated.
    assert.equal(call(gradebookController.updateEntry, { params: { entryId: String(entry.id) }, body: { note: 'Signed off' } }).statusCode, 200);
    assert.equal(gradebookRepository.findById(entry.id).grade, 7);
});

test('deleteEntry: manual entries and temporary automatic entries can be deleted', () => {
    const manual = call(gradebookController.createEntry, { params: { studentId: '2' }, body: { type: 'grade', grade: 5 } }).body.entry;
    assert.equal(call(gradebookController.deleteEntry, { params: { entryId: String(manual.id) } }).statusCode, 200);
    assert.equal(gradebookRepository.findById(manual.id), null);

    db.prepare(
        "INSERT INTO sessions (id, class_id, type, status, exercise_mode, difficulty, created_by) VALUES (8, 1, 'test', 'finished', 'morse_to_text', 'easy', 1)"
    ).run();
    gradebookRepository.insertFormalTestEntry({ studentId: 2, teacherId: 1, sessionId: 8, grade: 8 });
    const temp = gradebookRepository.listForStudent(2).find((e) => e.sourceSessionId === 8);
    assert.equal(call(gradebookController.deleteEntry, { params: { entryId: String(temp.id) } }).statusCode, 200);
    assert.equal(call(gradebookController.deleteEntry, { params: { entryId: String(temp.id) } }).statusCode, 404);
});
