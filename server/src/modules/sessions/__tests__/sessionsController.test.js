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
        exerciseMode: 'audio_to_text',
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
    const { items } = sessionEngine.generateItems({ exerciseMode: session.exerciseMode, difficulty: session.difficulty, exerciseCount: 1 });
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
