/**
 * Tests the server-authoritative scheduler directly against a real,
 * isolated temp database (see sessionRepository.test.js for why —
 * MORSE_DB_PATH), with the realtime hub's broadcast functions replaced
 * by simple recorders so these tests don't need a live WebSocket server.
 * sessionRuntime.js calls `hub.broadcast(...)` as a property lookup at
 * call time, so monkey-patching the hub module's exports after requiring
 * it is enough to intercept every broadcast without touching real sockets.
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-runtime-${process.pid}-${Date.now()}.db`);
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

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Runtime Test Class')").run();
db.prepare("INSERT INTO users (id, username, password_hash, role, class_id) VALUES (1, 'teacher1', 'x', 'teacher', NULL)").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')"
).run();

let broadcasts = [];
hub.broadcast = (sessionId, message) => broadcasts.push({ sessionId, ...message });
hub.broadcastSessionState = () => {
    broadcasts.push({ type: 'session_state_broadcast' });
};

beforeEach(() => {
    broadcasts = [];
});

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * wpm:60 AND farnsworthWpm:60 keep generated audio short so these tests
 * run fast in real time — the "beginner" preset otherwise pins
 * farnsworthWpm to a fixed slow 5 WPM regardless of the wpm override,
 * which stretches inter-character/word gaps far more than the dots and
 * dashes themselves (found by this test taking 12s instead of ~1s).
 */
function makeRunningSession({ exerciseCount = 1, prepTimeMs = 80, answerTimeMs = 80, type = 'group' } = {}) {
    const session = sessionRepository.createSession({
        classId: 1,
        type,
        exerciseMode: 'audio_to_text',
        difficulty: 'beginner',
        wpm: 60,
        farnsworthWpm: 60,
        toneFrequencyHz: undefined,
        exerciseCount,
        prepTimeMs,
        answerTimeMs,
        allowedAttempts: 1,
        passThresholdPercent: null,
        createdBy: 1,
    });
    const { items } = sessionEngine.generateItems({
        exerciseMode: session.exerciseMode,
        difficulty: session.difficulty,
        wpm: session.wpm,
        farnsworthWpm: session.farnsworthWpm,
        exerciseCount,
    });
    sessionRepository.insertItems(session.id, 1, items);
    sessionRepository.transitionStatus(session.id, ['created'], 'waiting', {});
    sessionRepository.transitionStatus(session.id, ['waiting'], 'running', {});
    return { session: sessionRepository.findByIdPublic(session.id), items };
}

test('startSession: broadcasts scheduled_start immediately with a future startAt and the full item payload', () => {
    const { session } = makeRunningSession({ prepTimeMs: 5000 });
    sessionRuntime.startSession(session.id);

    assert.equal(broadcasts.length, 1);
    const msg = broadcasts[0];
    assert.equal(msg.type, 'scheduled_start');
    assert.equal(msg.itemIndex, 0);
    assert.equal(msg.itemsTotal, 1);
    assert.ok(msg.startAt > Date.now(), 'startAt must be in the future');
    assert.ok(msg.startAt - Date.now() <= 5000);
    assert.ok(Array.isArray(msg.item.plan), 'audio_to_text item should carry a playback plan');
    assert.equal(msg.item.expectedAnswer, undefined, 'the expected answer must never be sent to the client ahead of time');

    sessionRuntime.haltSession(session.id); // cleanup — don't let this session's timers leak into later tests
});

test('single-item lifecycle: scheduled_start -> item_active -> item_closed -> session_finished, in order', async () => {
    const { session, items } = makeRunningSession({ prepTimeMs: 80, answerTimeMs: 80 });
    const durationMs = items[0].exercise.durationMs;

    sessionRuntime.startSession(session.id);
    await wait(80 + durationMs + 80 + 150); // prep + play + answer window + safety margin

    const types = broadcasts.map((b) => b.type);
    assert.deepEqual(types, ['scheduled_start', 'item_active', 'item_closed', 'session_finished', 'session_state_broadcast']);

    const itemActive = broadcasts.find((b) => b.type === 'item_active');
    assert.equal(itemActive.itemIndex, 0);
    assert.ok(itemActive.deadlineAt > Date.now() - 500, 'deadline should be close to now, not stale');
    assert.ok(Array.isArray(itemActive.item.plan));

    assert.equal(sessionRepository.findByIdPublic(session.id).status, 'finished');
    assert.equal(sessionRuntime.getRuntimeState(session.id), null, 'runtime state should be cleaned up after finishing');
});

test('Formal Test: item_active includes expectedAnswer once the item goes live, but scheduled_start still never does', async () => {
    const { session, items } = makeRunningSession({ prepTimeMs: 80, answerTimeMs: 80, type: 'test' });
    const durationMs = items[0].exercise.durationMs;

    sessionRuntime.startSession(session.id);

    const scheduledStart = broadcasts.find((b) => b.type === 'scheduled_start');
    assert.equal(
        scheduledStart.item.expectedAnswer,
        undefined,
        'the upcoming item must still never reveal its answer before it has actually begun'
    );

    await wait(80 + durationMs + 150); // prep + play, well before the answer window closes

    const itemActive = broadcasts.find((b) => b.type === 'item_active');
    assert.equal(
        itemActive.item.expectedAnswer,
        items[0].exercise.expectedAnswer,
        "a live Formal Test item's answer is intentionally included once that item goes active"
    );

    sessionRuntime.haltSession(session.id); // cleanup — don't let this session's timers leak into later tests
});

test('multi-item session auto-advances to the next item after the inter-item gap', async () => {
    const { session, items } = makeRunningSession({ exerciseCount: 2, prepTimeMs: 60, answerTimeMs: 60 });
    const duration0 = items[0].exercise.durationMs;

    sessionRuntime.startSession(session.id);
    // Wait past item 0's full window (prep + play + answer) plus the fixed
    // 2s inter-item gap sessionRuntime uses before scheduling item 1.
    await wait(60 + duration0 + 60 + 2000 + 200);

    const scheduledStarts = broadcasts.filter((b) => b.type === 'scheduled_start');
    assert.equal(scheduledStarts.length, 2, 'should have scheduled both item 0 and item 1');
    assert.equal(scheduledStarts[0].itemIndex, 0);
    assert.equal(scheduledStarts[1].itemIndex, 1);
    assert.ok(scheduledStarts[1].startAt > scheduledStarts[0].startAt);

    sessionRuntime.haltSession(session.id); // cleanup — item 1 hasn't finished yet
});

test('pauseSession freezes progress; resumeSession restarts the SAME item with a fresh scheduled_start (documented behavior)', async () => {
    const { session } = makeRunningSession({ prepTimeMs: 150, answerTimeMs: 100 });
    sessionRuntime.startSession(session.id);
    const firstStart = broadcasts.find((b) => b.type === 'scheduled_start');
    assert.ok(firstStart);

    // Mirror exactly what the controller does: DB transition first, then the runtime hook.
    sessionRepository.transitionStatus(session.id, ['running'], 'paused', { paused_at: new Date().toISOString() });
    sessionRuntime.pauseSession(session.id);

    // Wait past when the item would have activated if it hadn't been paused.
    await wait(250);
    assert.equal(broadcasts.filter((b) => b.type === 'item_active').length, 0, 'a paused session must never activate an item');

    sessionRepository.transitionStatus(session.id, ['paused'], 'running', {});
    sessionRuntime.resumeSession(session.id);

    const scheduledStartsAfterResume = broadcasts.filter((b) => b.type === 'scheduled_start');
    assert.equal(scheduledStartsAfterResume.length, 2, 'resume should broadcast a fresh scheduled_start');
    assert.equal(scheduledStartsAfterResume[1].itemIndex, 0, 'resume restarts the SAME item, not the next one');
    assert.ok(scheduledStartsAfterResume[1].startAt > firstStart.startAt);

    sessionRuntime.haltSession(session.id); // cleanup
});

test('server-authoritative check: a stale scheduled timer that fires after the session was cancelled out-of-band does nothing', async () => {
    const { session } = makeRunningSession({ prepTimeMs: 100 });
    sessionRuntime.startSession(session.id);
    assert.equal(broadcasts.filter((b) => b.type === 'scheduled_start').length, 1);

    // Simulate a status change that did NOT go through sessionRuntime.haltSession
    // (e.g. a differently-timed code path, or — the actual point of this test —
    // proving the timer callback's own authoritative status check is what
    // actually protects it, not just the controller remembering to clear timers).
    sessionRepository.transitionStatus(session.id, ['running'], 'cancelled', { ended_at: new Date().toISOString() });

    // Let the original activateItem timer fire anyway.
    await wait(250);

    assert.equal(
        broadcasts.filter((b) => b.type === 'item_active').length,
        0,
        'activateItem must refuse to act once the session is no longer running, even if its timer was never cleared'
    );
    assert.equal(sessionRepository.findByIdPublic(session.id).status, 'cancelled', 'the out-of-band cancellation must stick');
});

test('Group Practice: item_active also includes the live item\'s expectedAnswer (answer reveal), scheduled_start still never does', async () => {
    const { session, items } = makeRunningSession({ prepTimeMs: 80, answerTimeMs: 80, type: 'group' });
    const durationMs = items[0].exercise.durationMs;

    sessionRuntime.startSession(session.id);
    const scheduledStart = broadcasts.find((b) => b.type === 'scheduled_start');
    assert.equal(scheduledStart.item.expectedAnswer, undefined, 'never before the item has begun');

    await wait(80 + durationMs + 150);
    const itemActive = broadcasts.find((b) => b.type === 'item_active');
    assert.equal(itemActive.item.expectedAnswer, items[0].exercise.expectedAnswer);

    sessionRuntime.haltSession(session.id);
});
