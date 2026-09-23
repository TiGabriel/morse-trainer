/**
 * Controller-level tests focused on exactly what Phase 9 asks for:
 * stale/invalid playback commands and server-authoritative timing being
 * enforced regardless of what a client claims. Uses plain mock
 * req/res objects (no Express, no HTTP) and a real isolated temp DB.
 *
 * IMPORTANT ordering note: sessionsController.js captures direct
 * references to sessionRuntime's exported functions at module-load time
 * (`makeTransitionHandler('start', ..., sessionRuntime.startSession)`),
 * not as lazy property lookups. So sessionRuntime's functions must be
 * monkey-patched BEFORE sessionsController.js is required for the first
 * time, or the controller will have already captured the real ones.
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-controller-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const sessionRepository = require('../sessionRepository');
const sessionEngine = require('../sessionEngine');
const hub = require('../../../realtime/hub');
const sessionRuntime = require('../sessionRuntime');

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
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (3, 'stud2', 'x', 'student', 2, 'Zed', 'Other')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (5, 'stud3', 'x', 'student', 1, 'Cara', 'Extra')"
).run(); // a second student in class 1, for participant-restriction tests

// --- Mocks, wired up BEFORE requiring the controller (see note above) ---
hub.broadcast = () => {};
hub.broadcastSessionState = () => {};

const runtimeCalls = [];
sessionRuntime.startSession = (id) => runtimeCalls.push(['start', id]);
sessionRuntime.pauseSession = (id) => runtimeCalls.push(['pause', id]);
sessionRuntime.resumeSession = (id) => runtimeCalls.push(['resume', id]);
sessionRuntime.haltSession = (id) => runtimeCalls.push(['halt', id]);
let mockRuntimeState = null;
sessionRuntime.getRuntimeState = () => mockRuntimeState;

const sessionsController = require('../sessionsController');

beforeEach(() => {
    runtimeCalls.length = 0;
    mockRuntimeState = null;
});

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

function makeSession(overrides = {}) {
    const session = sessionRepository.createSession({
        classId: 1,
        type: overrides.type || 'group',
        exerciseMode: overrides.exerciseMode || 'audio_to_text',
        difficulty: 'easy',
        wpm: undefined,
        farnsworthWpm: undefined,
        toneFrequencyHz: undefined,
        exerciseCount: 1,
        prepTimeMs: 5000,
        answerTimeMs: overrides.answerTimeMs ?? null,
        allowedAttempts: overrides.allowedAttempts ?? 1,
        passThresholdPercent: overrides.passThresholdPercent ?? null,
        createdBy: 1,
    });
    const { items } = sessionEngine.generateItems({
        exerciseMode: session.exerciseMode,
        difficulty: session.difficulty,
        exerciseCount: 1,
        characters: overrides.characters,
        length: overrides.length,
    });
    sessionRepository.insertItems(session.id, 1, items);
    const item = sessionRepository.getItemByIndex(session.id, 0);
    return { session, item };
}

function toRunning(sessionId) {
    sessionRepository.transitionStatus(sessionId, ['created'], 'waiting', {});
    sessionRepository.transitionStatus(sessionId, ['waiting'], 'running', {});
}

function submitReq({ sessionId, itemId, studentId = 2, submittedAnswer = 'X', role = 'student' }) {
    return { params: { id: String(sessionId), itemId: String(itemId) }, body: { submittedAnswer }, user: { id: studentId, role } };
}

// ---------------------------------------------------------------------
// submitAttempt: stale/invalid commands + server-authoritative timing
// ---------------------------------------------------------------------

test('submitAttempt: accepts a valid submission for the currently active item (group session gets immediate score)', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000, scheduledStartAt: null };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer: item.exercise.text }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.submitted, true);
    assert.equal(res.body.score.accuracyPercent, 100);
    assert.equal(res.body.expectedAnswer, item.exercise.text);
    assert.equal(res.body.characterGrade.grade, 10, 'a perfect group-practice submission uses the same centralized grading service');
});

test('submitAttempt: rejects a submission for an item that is no longer the active one', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    // Server says item 5 is current; the client is still stuck on item 0.
    mockRuntimeState = { currentItemIndex: 5, currentDeadlineAt: Date.now() + 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /not the currently active one/);
});

test('submitAttempt: rejects a submission after the server-computed deadline (plus grace) has passed', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() - 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /window.*closed/i);
});

test('submitAttempt: accepts a submission arriving just within the grace window past the deadline', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() - 1000 }; // within the 3000ms grace

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 201);
});

test('submitAttempt: rejects a stale command when no runtime state exists at all (e.g. after a server restart)', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    mockRuntimeState = null;

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 409);
});

test('submitAttempt: enforces allowedAttempts server-side, independent of anything the client sends', () => {
    const { session, item } = makeSession({ allowedAttempts: 1 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const res1 = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer: 'FIRST' }), res1);
    assert.equal(res1.statusCode, 201);

    const res2 = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer: 'SECOND' }), res2);
    assert.equal(res2.statusCode, 429);
});

test('submitAttempt: a session that is not "running" rejects submissions outright (e.g. still "waiting")', () => {
    const { session, item } = makeSession();
    sessionRepository.transitionStatus(session.id, ['created'], 'waiting', {}); // never started
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 409);
});

test('submitAttempt: a teacher cannot submit session answers', () => {
    const { session, item } = makeSession();
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, studentId: 1, role: 'teacher' }), res);

    assert.equal(res.statusCode, 403);
});

test('submitAttempt: a student outside the session\'s class is rejected', () => {
    const { session, item } = makeSession(); // class 1
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, studentId: 3 }), res); // student 3 is in class 2

    assert.equal(res.statusCode, 403);
});

test('submitAttempt: formal tests withhold score/answer from the immediate response', () => {
    const { session, item } = makeSession({ type: 'test' });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.submitted, true);
    assert.equal(res.body.score, undefined);
    assert.equal(res.body.expectedAnswer, undefined);
    assert.equal(res.body.characterGrade, undefined, 'a Formal Test must never reveal its character grade before the test ends, same as score/expectedAnswer');
});

// ---------------------------------------------------------------------
// Morse Transmission integration: security + grading via the shared
// submitAttempt endpoint (no separate transmission-specific endpoint —
// it reuses the exact same server-authoritative machinery every other
// mode goes through).
// ---------------------------------------------------------------------
const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { TransmissionEngine } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));
const { CHAR_TO_MORSE } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-map.js'));

function keyTextPerfectlyAsJson(text, wpm) {
    const engine = new TransmissionEngine({ wpm, toleranceFactor: 0.35 });
    const unitMs = 1200 / wpm;
    [...text].forEach((ch, charIndex) => {
        const morse = CHAR_TO_MORSE[ch.toUpperCase()];
        [...morse].forEach((sym, i) => {
            engine.feedTone(sym === '.' ? unitMs : 3 * unitMs);
            if (i < morse.length - 1) engine.feedGap(unitMs);
        });
        if (charIndex < text.length - 1) engine.feedGap(3 * unitMs);
    });
    engine.flush();
    return JSON.stringify(engine.elementLog);
}

test('submitAttempt (transmission): a Formal Test still withholds score/decoded text/timing stats from the immediate response', () => {
    const { session, item } = makeSession({ type: 'test', exerciseMode: 'transmission', characters: ['E', 'T'], length: 3 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const submittedAnswer = keyTextPerfectlyAsJson(item.exercise.text, item.exercise.wpm);
    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.submitted, true);
    assert.equal(res.body.score, undefined, 'score must stay hidden until the test ends');
    assert.equal(res.body.expectedAnswer, undefined);
    assert.equal(res.body.characterGrade, undefined);
    // The response body must not carry the raw element log or decoded
    // text anywhere either — nothing beyond the plain submission ack.
    assert.deepEqual(Object.keys(res.body).sort(), ['attemptCount', 'submitted']);
});

test('submitAttempt (transmission): Group Practice reveals score/grade immediately, same as every other mode', () => {
    const { session, item } = makeSession({ type: 'group', exerciseMode: 'transmission', characters: ['S', 'O'], length: 4 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const submittedAnswer = keyTextPerfectlyAsJson(item.exercise.text, item.exercise.wpm);
    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer }), res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.score.accuracyPercent, 100);
    assert.equal(res.body.expectedAnswer, item.exercise.expectedAnswer);
    assert.ok(res.body.characterGrade);
});

test('submitAttempt (transmission): the server re-derives the transmitted text — a submission with garbage timings cannot self-report a perfect score', () => {
    const { session, item } = makeSession({ type: 'group', exerciseMode: 'transmission', characters: ['S'], length: 1 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };
    assert.equal(item.exercise.text, 'S'); // S = "..." — a single long press decodes to something else entirely

    const unitMs = 1200 / item.exercise.wpm;
    const garbage = JSON.stringify([{ type: 'tone', durationMs: unitMs * 3 }]); // one dash-length press -> "T", not "S"
    const res = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer: garbage }), res);

    assert.notEqual(res.body.score.accuracyPercent, 100);
});

test('submitAttempt (transmission): allowedAttempts is enforced identically to every other mode', () => {
    const { session, item } = makeSession({ type: 'test', exerciseMode: 'transmission', allowedAttempts: 1, characters: ['E'], length: 1 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    const submittedAnswer = keyTextPerfectlyAsJson(item.exercise.text, item.exercise.wpm);
    const first = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer }), first);
    assert.equal(first.statusCode, 201);

    const second = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer }), second);
    assert.equal(second.statusCode, 429);
});

// ---------------------------------------------------------------------
// Transition handlers: legality is server-decided, never client-decided
// ---------------------------------------------------------------------

test('startSession handler: legal waiting->running transition invokes the sessionRuntime hook', () => {
    const { session } = makeSession();
    sessionRepository.transitionStatus(session.id, ['created'], 'waiting', {});

    const res = mockRes();
    sessionsController.startSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.session.status, 'running');
    assert.deepEqual(runtimeCalls, [['start', session.id]]);
});

test('startSession handler: rejects starting an already-running session and never calls the runtime hook', () => {
    const { session } = makeSession();
    toRunning(session.id);

    const res = mockRes();
    sessionsController.startSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(runtimeCalls, [], 'an illegal transition must never reach the scheduler');
});

test('pauseSession handler: legal running->paused invokes the hook; resumeSession invokes its own', () => {
    const { session } = makeSession();
    toRunning(session.id);

    const pauseRes = mockRes();
    sessionsController.pauseSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, pauseRes);
    assert.equal(pauseRes.statusCode, 200);
    assert.equal(pauseRes.body.session.status, 'paused');

    const resumeRes = mockRes();
    sessionsController.resumeSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, resumeRes);
    assert.equal(resumeRes.statusCode, 200);
    assert.equal(resumeRes.body.session.status, 'running');

    assert.deepEqual(runtimeCalls, [
        ['pause', session.id],
        ['resume', session.id],
    ]);
});

test('cancelSession handler: cancel is legal from "created" (before anything ever started)', () => {
    const { session } = makeSession();

    const res = mockRes();
    sessionsController.cancelSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.session.status, 'cancelled');
    assert.deepEqual(runtimeCalls, [['halt', session.id]]);
});

test('cancelSession handler: a second cancel on an already-terminal session is rejected (409), not silently accepted', () => {
    const { session } = makeSession();
    sessionsController.cancelSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, mockRes());
    runtimeCalls.length = 0;

    const res = mockRes();
    sessionsController.cancelSession({ params: { id: String(session.id) }, user: { username: 'teacher1' } }, res);

    assert.equal(res.statusCode, 409);
    assert.deepEqual(runtimeCalls, []);
});

// ---------------------------------------------------------------------
// Phase 10: formal-test creation body (instructions/participants/length)
// ---------------------------------------------------------------------

test('createSession handler: persists instructions, Farnsworth/tone, item length, and a validated participant subset', () => {
    const req = {
        body: {
            type: 'test',
            classId: 1,
            // Not audio_to_text: that mode is now always a fixed-shape
            // 3x10x4 radiogram (see sessionEngine.buildRadiogramExercise)
            // and deliberately ignores the `length` override being tested
            // here — this test is about generic item-length persistence,
            // which every other mode still honors unchanged.
            exerciseMode: 'morse_to_text',
            difficulty: 'easy',
            exerciseCount: 2,
            farnsworthWpm: 10,
            toneFrequencyHz: 700,
            length: 8,
            instructions: 'Answer in capital letters only.',
            participantIds: [2, 999], // 999 does not exist / is not in class 1
            allowedAttempts: 2,
            passThresholdPercent: 60,
        },
        user: { id: 1, username: 'teacher1' },
    };
    const res = mockRes();
    sessionsController.createSession(req, res);

    assert.equal(res.statusCode, 201);
    const { session } = res.body;
    assert.equal(session.instructions, 'Answer in capital letters only.');
    assert.equal(session.toneFrequencyHz, 700);
    assert.equal(session.farnsworthWpm, 10);
    assert.equal(session.itemLength, 8);
    assert.deepEqual(session.participantIds, [2], 'the bogus id 999 must be silently dropped, never trusted from the client');

    const items = sessionRepository.listItems(session.id);
    items.forEach((item) => assert.equal(item.exercise.text.replace(/\s/g, '').length, 8));
});

test('createSession handler: an explicit characters pool from the request body restricts every generated item to it', () => {
    const req = {
        body: {
            type: 'group',
            classId: 1,
            exerciseMode: 'morse_to_text',
            difficulty: 'hard',
            exerciseCount: 2,
            characters: ['Q', 'W'],
        },
        user: { id: 1, username: 'teacher1' },
    };
    const res = mockRes();
    sessionsController.createSession(req, res);

    assert.equal(res.statusCode, 201);
    const items = sessionRepository.listItems(res.body.session.id);
    items.forEach((item) => {
        const usedChars = new Set(item.exercise.text.replace(/\s/g, '').split(''));
        usedChars.forEach((ch) => assert.ok(['Q', 'W'].includes(ch)));
    });
});

test('createSession handler: rejects when none of the submitted participantIds are real students in that class', () => {
    const req = {
        body: {
            type: 'test',
            classId: 1,
            exerciseMode: 'audio_to_text',
            difficulty: 'easy',
            exerciseCount: 1,
            participantIds: [999, 888], // neither exists
        },
        user: { id: 1, username: 'teacher1' },
    };
    const res = mockRes();
    sessionsController.createSession(req, res);

    assert.equal(res.statusCode, 400);
});

test('createSession handler: rejects a classId that does not refer to any existing class', () => {
    const req = {
        body: { type: 'group', classId: 9999, exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1 },
        user: { id: 1, username: 'teacher1' },
    };
    const res = mockRes();
    sessionsController.createSession(req, res);

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /class/i);

    const countBefore = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    // Calling it again must not have left an orphaned session row behind either.
    sessionsController.createSession(req, mockRes());
    const countAfter = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
    assert.equal(countAfter, countBefore, 'rejecting an invalid classId must never create a session row');
});

test('createSession handler: omitting participantIds still means "everyone in the class" (Phase 8 default preserved)', () => {
    const req = {
        body: { type: 'group', classId: 1, exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1 },
        user: { id: 1, username: 'teacher1' },
    };
    const res = mockRes();
    sessionsController.createSession(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.session.participantIds, null);
});

test('submitAttempt: a student excluded from a participant-restricted test is rejected even though they share the class', () => {
    const createReq = {
        body: { type: 'test', classId: 1, exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 1, participantIds: [2] }, // only Ann (id 2)
        user: { id: 1, username: 'teacher1' },
    };
    const createRes = mockRes();
    sessionsController.createSession(createReq, createRes);
    const { session } = createRes.body;
    toRunning(session.id);

    const item = sessionRepository.getItemByIndex(session.id, 0);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };

    // Ann (id 2) — selected — succeeds.
    const annRes = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, studentId: 2 }), annRes);
    assert.equal(annRes.statusCode, 201);

    // Cara (id 5) — same class, NOT selected — must be rejected.
    const caraRes = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, studentId: 5 }), caraRes);
    assert.equal(caraRes.statusCode, 403);
});

// ---------------------------------------------------------------------
// Morse Transmission as a Group Session / Formal Test exercise mode
// ---------------------------------------------------------------------

function createReq(body) {
    return { body: { classId: 1, difficulty: 'easy', exerciseCount: 1, ...body }, user: { id: 1, username: 'teacher1' } };
}

test('createSession handler: accepts every Group Session exercise mode, including transmission', () => {
    ['audio_to_text', 'morse_to_text', 'text_to_morse', 'character_recognition', 'transmission'].forEach((exerciseMode) => {
        ['group', 'test'].forEach((type) => {
            const res = mockRes();
            sessionsController.createSession(createReq({ type, exerciseMode }), res);
            assert.equal(res.statusCode, 201, `${type}/${exerciseMode} should be creatable (got ${JSON.stringify(res.body)})`);
            assert.equal(res.body.session.exerciseMode, exerciseMode);
            const items = sessionRepository.listItems(res.body.session.id);
            assert.equal(items.length, 1);
            assert.equal(items[0].exercise.mode, exerciseMode === 'audio_to_text' ? 'audio_to_text' : exerciseMode);
        });
    });
});

test('createSession handler: a transmission session stores a visible target plus the teacher tolerance', () => {
    const res = mockRes();
    sessionsController.createSession(createReq({ type: 'group', exerciseMode: 'transmission', characters: ['E', 'T'], length: 4, toleranceFactor: 0.5 }), res);
    assert.equal(res.statusCode, 201);
    const [item] = sessionRepository.listItems(res.body.session.id);
    assert.equal(item.exercise.mode, 'transmission');
    assert.equal(item.exercise.toleranceFactor, 0.5);
    assert.ok(/^[ET\s]+$/.test(item.exercise.text));
    assert.equal(item.exercise.expectedAnswer, item.exercise.text);
});

test('createSession handler: still rejects an unknown exerciseMode', () => {
    const res = mockRes();
    sessionsController.createSession(createReq({ type: 'group', exerciseMode: 'bogus_mode' }), res);
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.error.includes('transmission'), 'the error lists transmission as a valid mode');
});

// ---------------------------------------------------------------------
// Electronic gradebook: automatic TEMPORARY Formal Test entries
// ---------------------------------------------------------------------

test('stopSession on a Formal Test creates ONE temporary gradebook entry per participating student, never duplicated', () => {
    const gradebookRepository = require('../../gradebook/gradebookRepository');
    const gradebookService = require('../../gradebook/gradebookService');

    const { session, item } = makeSession({ type: 'test', exerciseMode: 'morse_to_text', passThresholdPercent: 50 });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };
    const submitRes = mockRes();
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, studentId: 2, submittedAnswer: item.exercise.text }), submitRes);
    assert.equal(submitRes.statusCode, 201);

    const before = gradebookRepository.listForStudent(2).filter((e) => e.sourceSessionId === session.id);
    assert.equal(before.length, 0, 'nothing is recorded while the test is still running');

    const stopRes = mockRes();
    sessionsController.stopSession({ params: { id: String(session.id) }, user: { id: 1, username: 'teacher1' } }, stopRes);
    assert.equal(stopRes.statusCode, 200);

    const entries = gradebookRepository.listForStudent(2).filter((e) => e.sourceSessionId === session.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'formal_test');
    assert.equal(entries[0].isPermanent, false, 'automatic entries start temporary');
    assert.equal(entries[0].grade, 10, 'a perfect answer is the authoritative 4-10 grade 10');
    assert.equal(entries[0].details.accuracyPercent, 100);
    assert.equal(entries[0].details.passFail, 'pass');
    assert.equal(entries[0].teacherId, 1);

    // Cara (id 5) is in the class but never submitted — no result, no entry.
    assert.equal(gradebookRepository.listForStudent(5).filter((e) => e.sourceSessionId === session.id).length, 0);

    // Processing the "finished" event again must never duplicate.
    assert.equal(gradebookService.recordFormalTestResults(session.id), 0);
    assert.equal(gradebookRepository.listForStudent(2).filter((e) => e.sourceSessionId === session.id).length, 1);
});

test('stopSession on Group Practice never creates gradebook entries', () => {
    const gradebookRepository = require('../../gradebook/gradebookRepository');
    const { session, item } = makeSession({ type: 'group', exerciseMode: 'morse_to_text' });
    toRunning(session.id);
    mockRuntimeState = { currentItemIndex: 0, currentDeadlineAt: Date.now() + 10000 };
    sessionsController.submitAttempt(submitReq({ sessionId: session.id, itemId: item.id, submittedAnswer: item.exercise.text }), mockRes());
    sessionsController.stopSession({ params: { id: String(session.id) }, user: { id: 1, username: 'teacher1' } }, mockRes());
    assert.equal(gradebookRepository.listForStudent(2).filter((e) => e.sourceSessionId === session.id).length, 0);
});
