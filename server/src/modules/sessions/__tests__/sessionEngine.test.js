const test = require('node:test');
const assert = require('node:assert/strict');
const sessionEngine = require('../sessionEngine');

test('nextStatus: created --open--> waiting', () => {
    assert.equal(sessionEngine.nextStatus('created', 'open'), 'waiting');
});

test('nextStatus: waiting --start--> running', () => {
    assert.equal(sessionEngine.nextStatus('waiting', 'start'), 'running');
});

test('nextStatus: running --pause--> paused, paused --resume--> running', () => {
    assert.equal(sessionEngine.nextStatus('running', 'pause'), 'paused');
    assert.equal(sessionEngine.nextStatus('paused', 'resume'), 'running');
});

test('nextStatus: running/paused --stop--> finished', () => {
    assert.equal(sessionEngine.nextStatus('running', 'stop'), 'finished');
    assert.equal(sessionEngine.nextStatus('paused', 'stop'), 'finished');
});

test('nextStatus: cancel is legal from every non-terminal status', () => {
    for (const status of ['created', 'waiting', 'running', 'paused']) {
        assert.equal(sessionEngine.nextStatus(status, 'cancel'), 'cancelled');
    }
});

test('nextStatus: throws on an illegal transition', () => {
    assert.throws(() => sessionEngine.nextStatus('created', 'start'), sessionEngine.SessionError);
    assert.throws(() => sessionEngine.nextStatus('waiting', 'pause'), sessionEngine.SessionError);
});

test('nextStatus: terminal statuses accept no further actions', () => {
    for (const status of sessionEngine.TERMINAL_STATUSES) {
        assert.deepEqual(sessionEngine.availableActions(status), []);
        assert.throws(() => sessionEngine.nextStatus(status, 'open'));
        assert.throws(() => sessionEngine.nextStatus(status, 'cancel'));
    }
});

test('availableActions: matches what the schema/UI expect per status', () => {
    assert.deepEqual(sessionEngine.availableActions('created').sort(), ['cancel', 'open']);
    assert.deepEqual(sessionEngine.availableActions('waiting').sort(), ['cancel', 'start']);
    assert.deepEqual(sessionEngine.availableActions('running').sort(), ['cancel', 'pause', 'stop']);
    assert.deepEqual(sessionEngine.availableActions('paused').sort(), ['cancel', 'resume', 'stop']);
});

test('generateItems: produces the requested count, each with a distinct expected answer', () => {
    const { items } = sessionEngine.generateItems({
        exerciseMode: 'audio_to_text',
        difficulty: 'easy',
        exerciseCount: 5,
    });
    assert.equal(items.length, 5);
    items.forEach((item, i) => {
        assert.equal(item.orderIndex, i);
        assert.ok(item.exercise.text.length > 0);
        assert.ok(item.exercise.plan.length > 0);
        assert.ok(item.exercise.durationMs > 0);
    });
    const uniqueTexts = new Set(items.map((i) => i.exercise.text));
    assert.equal(uniqueTexts.size, items.length, 'items should not all be identical');
});

test('generateItems: is fully reproducible from the same baseSeed', () => {
    const a = sessionEngine.generateItems({ exerciseMode: 'morse_to_text', difficulty: 'medium', exerciseCount: 3, baseSeed: 'fixed-seed' });
    const b = sessionEngine.generateItems({ exerciseMode: 'morse_to_text', difficulty: 'medium', exerciseCount: 3, baseSeed: 'fixed-seed' });
    assert.deepEqual(
        a.items.map((i) => i.exercise.text),
        b.items.map((i) => i.exercise.text)
    );
});

test('generateItems: rejects a non-positive exerciseCount', () => {
    assert.throws(() => sessionEngine.generateItems({ exerciseMode: 'audio_to_text', difficulty: 'easy', exerciseCount: 0 }), sessionEngine.SessionError);
});

test('gradeSubmission: reuses the engine scoring — perfect match is 100%', () => {
    const exercise = { expectedAnswer: 'PARIS' };
    const score = sessionEngine.gradeSubmission(exercise, 'PARIS');
    assert.equal(score.accuracyPercent, 100);
});

test('computeGrade: null threshold means ungraded (no pass/fail)', () => {
    assert.equal(sessionEngine.computeGrade(95, null), null);
    assert.equal(sessionEngine.computeGrade(95, undefined), null);
});

test('computeGrade: pass/fail against a configured threshold', () => {
    assert.equal(sessionEngine.computeGrade(80, 70), 'pass');
    assert.equal(sessionEngine.computeGrade(60, 70), 'fail');
    assert.equal(sessionEngine.computeGrade(70, 70), 'pass'); // exactly at threshold passes
});
