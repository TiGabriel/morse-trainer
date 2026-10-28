/**
 * Class-based Morse Alphabet visibility: the teacher's per-class
 * selection (classesController get/setMorseCharacters) and the
 * role-aware GET /api/morse/alphabet that enforces it for students.
 * Plain mock req/res + a real isolated temp DB, same pattern as the
 * other controller tests. Route-level teacher-only authorization is
 * classesRoutes' requireRole('teacher').
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-class-morse-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const classesController = require('../classesController');
const morseController = require('../../morse-engine/morseController');
const { CHARSETS } = require('../../morse-engine/morseMap');

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Class A'), (2, 'Class B'), (3, 'Class C')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'teacher1', 'x', 'teacher')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (2, 'stud1', 'x', 'student', 1)").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (3, 'stud2', 'x', 'student', 2)").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (4, 'stud3', 'x', 'student', NULL)").run();

const teacher = { id: 1, username: 'teacher1', role: 'teacher' };
const student = (id) => ({ id, username: `stud${id}`, role: 'student' });

function call(handler, { user = teacher, params = {}, body } = {}) {
    const res = { statusCode: 200, body: undefined };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    handler({ params, body, user }, res);
    return res;
}

function chars(alphabetBody) {
    return [...alphabetBody.letters, ...alphabetBody.numbers, ...alphabetBody.punctuation].map((e) => e.char);
}

test('a class with nothing configured gives students no characters (never the full alphabet)', () => {
    const res = call(morseController.alphabet, { user: student(2) });
    assert.equal(res.body.restricted, true);
    assert.equal(res.body.configured, false);
    assert.deepEqual(chars(res.body), []);
});

test('teacher always gets the complete alphabet', () => {
    const res = call(morseController.alphabet);
    assert.equal(res.body.restricted, false);
    assert.deepEqual(chars(res.body), CHARSETS.all);
});

test('setMorseCharacters saves a normalized, canonical-order selection; student sees only it', () => {
    const put = call(classesController.setMorseCharacters, { params: { id: '1' }, body: { characters: ['z', 'A', 'R', 'A'] } });
    assert.equal(put.statusCode, 200);
    assert.deepEqual(put.body.characters, ['A', 'R', 'Z']);

    assert.deepEqual(call(classesController.getMorseCharacters, { params: { id: '1' } }).body.characters, ['A', 'R', 'Z']);

    const res = call(morseController.alphabet, { user: student(2) });
    assert.equal(res.body.configured, true);
    assert.deepEqual(chars(res.body), ['A', 'R', 'Z']);
    assert.deepEqual(res.body.letters.map((e) => e.morse), ['.-', '.-.', '--..']);
    // No trace of any unauthorized character anywhere in the payload.
    assert.ok(!JSON.stringify(res.body).includes('"B"'));
});

test('edits apply on the next request; other classes are unaffected', () => {
    call(classesController.setMorseCharacters, { params: { id: '1' }, body: { characters: ['A', 'Z', 'B', 'C'] } });
    call(classesController.setMorseCharacters, { params: { id: '2' }, body: { characters: ['1', '2', '?', '/'] } });
    assert.deepEqual(chars(call(morseController.alphabet, { user: student(2) }).body), ['A', 'B', 'C', 'Z']);
    assert.deepEqual(chars(call(morseController.alphabet, { user: student(3) }).body), ['1', '2', '?', '/']);
});

test('moving a student to another class switches their alphabet immediately', () => {
    db.prepare('UPDATE users SET class_id = 2 WHERE id = 2').run();
    assert.deepEqual(chars(call(morseController.alphabet, { user: student(2) }).body), ['1', '2', '?', '/']);
    db.prepare('UPDATE users SET class_id = 1 WHERE id = 2').run();
});

test('a student with no class sees nothing', () => {
    const res = call(morseController.alphabet, { user: student(4) });
    assert.equal(res.body.configured, false);
    assert.deepEqual(chars(res.body), []);
});

test('clearing the selection returns students to the "not configured" state', () => {
    const put = call(classesController.setMorseCharacters, { params: { id: '1' }, body: { characters: [] } });
    assert.deepEqual(put.body.characters, []);
    const res = call(morseController.alphabet, { user: student(2) });
    assert.equal(res.body.configured, false);
    assert.deepEqual(chars(res.body), []);
});

test('setMorseCharacters rejects unsupported characters, bad bodies and unknown classes', () => {
    assert.equal(call(classesController.setMorseCharacters, { params: { id: '2' }, body: { characters: ['A', '#'] } }).statusCode, 400);
    assert.equal(call(classesController.setMorseCharacters, { params: { id: '2' }, body: { characters: ['AB'] } }).statusCode, 400);
    assert.equal(call(classesController.setMorseCharacters, { params: { id: '2' }, body: { characters: 'A' } }).statusCode, 400);
    assert.equal(call(classesController.setMorseCharacters, { params: { id: '99' }, body: { characters: ['A'] } }).statusCode, 404);
    // The rejected request did not half-save anything.
    assert.deepEqual(call(classesController.getMorseCharacters, { params: { id: '2' } }).body.characters, ['1', '2', '?', '/']);
});

test('listClasses includes each class selection for teachers only', () => {
    const asTeacher = call(classesController.listClasses).body.classes;
    assert.deepEqual(asTeacher.find((c) => c.id === 2).morseCharacters, ['1', '2', '?', '/']);
    assert.deepEqual(asTeacher.find((c) => c.id === 3).morseCharacters, []);
    const asStudent = call(classesController.listClasses, { user: student(3) }).body.classes;
    asStudent.forEach((c) => assert.equal(c.morseCharacters, undefined));
});

test('deleting a class removes its selection', () => {
    call(classesController.setMorseCharacters, { params: { id: '3' }, body: { characters: ['E'] } });
    db.prepare('DELETE FROM classes WHERE id = 3').run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM class_morse_characters WHERE class_id = 3').get().n, 0);
});
