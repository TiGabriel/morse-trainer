/**
 * Controller-level tests for the Individual Training redesign's result
 * persistence — Radiogram Training and Character Training previously had
 * no DB-backed attempt row at all (see practiceController.js's old
 * "Stateless" doc comment on analyzeRadiogram), so every result was lost
 * on navigation/refresh/logout and invisible to teachers. These tests
 * cover the gap: student identity attached to results, results actually
 * saved, reload persistence (read back from the DB, not from memory),
 * restart/new-exercise not clobbering prior results, different character
 * pools, and different exercise lengths.
 *
 * Uses plain mock req/res objects (no Express/HTTP) and a real isolated
 * temp DB, same pattern as sessionsController.test.js.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmpDbPath = path.join(os.tmpdir(), `morse-trainer-test-practice-controller-${process.pid}-${Date.now()}.db`);
process.env.MORSE_DB_PATH = tmpDbPath;

const migrate = require('../../../db/migrate');
migrate();

const db = require('../../../db/client');
const practiceRepository = require('../practiceRepository');
const practiceController = require('../practiceController');

const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { TransmissionEngine } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));
const { CHAR_TO_MORSE } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-map.js'));

after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmpDbPath + suffix, { force: true });
    }
});

db.prepare("INSERT INTO classes (id, name) VALUES (1, 'Class A')").run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (2, 'stud1', 'x', 'student', 1, 'Ann', 'Smith')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (3, 'stud2', 'x', 'student', 1, 'Bob', 'Jones')"
).run();
db.prepare(
    "INSERT INTO users (id, username, password_hash, role, class_id, first_name, last_name) VALUES (4, 'stud3', 'x', 'student', 1, 'Cy', 'History')"
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

function reqAs(studentId, username, body) {
    return { user: { id: studentId, username, role: 'student' }, body, query: {} };
}

// ---------------------------------------------------------------------
// Radiogram Training: analyzeRadiogram now persists
// ---------------------------------------------------------------------

test('analyzeRadiogram: saves a practice_attempts row tied to the authenticated student', () => {
    const genRes = mockRes();
    practiceController.generateRadiogram(reqAs(2, 'stud1', { characters: 'letters', wpm: 15, seed: 100 }), genRes);
    const radiogram = genRes.body;

    const analyzeRes = mockRes();
    practiceController.analyzeRadiogram(
        reqAs(2, 'stud1', {
            characters: radiogram.characters,
            wpm: radiogram.timing.wpm,
            farnsworthWpm: radiogram.timing.farnsworthWpm,
            toneFrequencyHz: radiogram.timing.toneFrequencyHz,
            seed: radiogram.seed,
            submittedAnswer: radiogram.text.replace(/\s+/g, ''), // perfect transcription
            durationMs: 45000,
        }),
        analyzeRes
    );

    assert.equal(analyzeRes.statusCode, 200);
    assert.ok(analyzeRes.body.attemptId, 'response should include the saved attempt id');
    assert.equal(analyzeRes.body.score.accuracyPercent, 100);

    const saved = practiceRepository.findById(analyzeRes.body.attemptId);
    assert.ok(saved, 'attempt row should exist in the DB');
    assert.equal(saved.studentId, 2, 'result must be tied to the student who submitted it, not a hardcoded/default id');
    assert.equal(saved.exerciseType, 'radiogram_training');
    assert.equal(saved.wpm, 15);
    assert.equal(saved.durationMs, 45000);
    assert.equal(saved.accuracyPercent, 100);
});

test('analyzeRadiogram: reload persistence — a saved result is readable back from the DB, not just returned once in memory', () => {
    const genRes = mockRes();
    practiceController.generateRadiogram(reqAs(2, 'stud1', { characters: 'letters', wpm: 18, seed: 101 }), genRes);
    const radiogram = genRes.body;

    const analyzeRes = mockRes();
    practiceController.analyzeRadiogram(
        reqAs(2, 'stud1', {
            characters: radiogram.characters,
            wpm: radiogram.timing.wpm,
            farnsworthWpm: radiogram.timing.farnsworthWpm,
            toneFrequencyHz: radiogram.timing.toneFrequencyHz,
            seed: radiogram.seed,
            submittedAnswer: radiogram.text.replace(/\s+/g, ''),
        }),
        analyzeRes
    );
    const attemptId = analyzeRes.body.attemptId;

    // Simulates the student refreshing/logging back in: a fresh read from
    // the repository, independent of any server-memory state.
    const reread = practiceRepository.findById(attemptId);
    assert.ok(reread);
    assert.equal(reread.id, attemptId);
    assert.equal(reread.accuracyPercent, 100);
});

test('analyzeRadiogram: restart/new exercise does not clobber the previous result — both remain in history', () => {
    const before = practiceRepository.countForStudent(2);

    for (let i = 0; i < 2; i += 1) {
        const genRes = mockRes();
        practiceController.generateRadiogram(reqAs(2, 'stud1', { characters: 'numbers', wpm: 20, seed: 200 + i }), genRes);
        const radiogram = genRes.body;
        const analyzeRes = mockRes();
        practiceController.analyzeRadiogram(
            reqAs(2, 'stud1', {
                characters: radiogram.characters,
                wpm: radiogram.timing.wpm,
                farnsworthWpm: radiogram.timing.farnsworthWpm,
                toneFrequencyHz: radiogram.timing.toneFrequencyHz,
                seed: radiogram.seed,
                submittedAnswer: '', // intentionally blank — still must save (0% is a real result)
            }),
            analyzeRes
        );
        assert.equal(analyzeRes.statusCode, 200);
    }

    assert.equal(practiceRepository.countForStudent(2), before + 2, 'generating another exercise must add a new row, not replace the previous one');
});

test('analyzeRadiogram: honors the selected custom character pool in the saved prompt', () => {
    const genRes = mockRes();
    practiceController.generateRadiogram(reqAs(2, 'stud1', { characters: ['A', 'B'], wpm: 15, seed: 300 }), genRes);
    const radiogram = genRes.body;
    assert.deepEqual([...radiogram.characters].sort(), ['A', 'B']);
    for (const ch of radiogram.text.replace(/\s+/g, '')) {
        assert.ok(['A', 'B'].includes(ch));
    }

    const analyzeRes = mockRes();
    practiceController.analyzeRadiogram(
        reqAs(2, 'stud1', {
            characters: radiogram.characters,
            wpm: radiogram.timing.wpm,
            farnsworthWpm: radiogram.timing.farnsworthWpm,
            toneFrequencyHz: radiogram.timing.toneFrequencyHz,
            seed: radiogram.seed,
            submittedAnswer: radiogram.text.replace(/\s+/g, ''),
        }),
        analyzeRes
    );
    const saved = practiceRepository.findById(analyzeRes.body.attemptId);
    for (const ch of saved.promptText.replace(/\s+/g, '')) {
        assert.ok(['A', 'B'].includes(ch));
    }
});

test('analyzeRadiogram: rejects a request missing submittedAnswer or seed', () => {
    const res1 = mockRes();
    practiceController.analyzeRadiogram(reqAs(2, 'stud1', { characters: 'letters', wpm: 15, seed: 400 }), res1);
    assert.equal(res1.statusCode, 400);

    const res2 = mockRes();
    practiceController.analyzeRadiogram(reqAs(2, 'stud1', { characters: 'letters', wpm: 15, submittedAnswer: 'X' }), res2);
    assert.equal(res2.statusCode, 400);
});

// ---------------------------------------------------------------------
// Character Training: submitCharacterTrainingAttempt
// ---------------------------------------------------------------------

function buildAndFinishCtSession(req, submittedChars) {
    const genRes = mockRes();
    practiceController.generateCharacterTrainingSession(req, genRes);
    const session = genRes.body;

    const submittedAnswer = submittedChars ?? session.items.map((item) => item.char).join(''); // default: perfect run
    const submitRes = mockRes();
    practiceController.submitCharacterTrainingAttempt(
        reqAs(req.user.id, req.user.username, {
            characters: session.characters,
            length: session.length,
            wpm: session.timing.wpm,
            farnsworthWpm: session.timing.farnsworthWpm,
            toneFrequencyHz: session.timing.toneFrequencyHz,
            seed: session.seed,
            submittedAnswer,
            durationMs: 12000,
        }),
        submitRes
    );
    return { session, submitRes };
}

test('submitCharacterTrainingAttempt: saves a result tied to the authenticated student, for different pools and lengths', () => {
    const { session, submitRes } = buildAndFinishCtSession(
        reqAs(2, 'stud1', { characters: ['A', 'B', 'C'], length: 8, wpm: 15, seed: 500 })
    );

    assert.equal(submitRes.statusCode, 201);
    assert.ok(submitRes.body.attemptId);
    assert.equal(submitRes.body.score.accuracyPercent, 100);
    assert.equal(session.length, 8);
    assert.equal(session.items.length, 8);

    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 2);
    assert.equal(saved.exerciseType, 'character_training');
    assert.equal(saved.durationMs, 12000);
    assert.equal(saved.promptText.length, 8);
    for (const ch of saved.promptText) assert.ok(['A', 'B', 'C'].includes(ch));
});

test('submitCharacterTrainingAttempt: a different, shorter length is honored and independently persisted', () => {
    const { session, submitRes } = buildAndFinishCtSession(
        reqAs(3, 'stud2', { characters: 'numbers', length: 3, wpm: 20, seed: 501 })
    );
    assert.equal(session.length, 3);
    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 3, 'must be tied to the student who actually submitted it, not another student');
    assert.equal(saved.promptText.length, 3);
});

test('submitCharacterTrainingAttempt: server recomputes correctness from the seed rather than trusting the client', () => {
    // Build a real session, then submit a deliberately WRONG answer for
    // every round and confirm the server grades it as wrong (0%), not
    // whatever the client might have separately claimed client-side.
    const genRes = mockRes();
    practiceController.generateCharacterTrainingSession(
        reqAs(2, 'stud1', { characters: ['A', 'B'], length: 4, wpm: 15, seed: 502 }),
        genRes
    );
    const session = genRes.body;
    // Every char in the pool is A or B — submit the opposite pool member
    // (or a garbage char never in the pool) for every round so nothing
    // can accidentally match.
    const wrongAnswer = session.items.map(() => 'Z').join('');

    const submitRes = mockRes();
    practiceController.submitCharacterTrainingAttempt(
        reqAs(2, 'stud1', {
            characters: session.characters,
            length: session.length,
            wpm: session.timing.wpm,
            seed: session.seed,
            submittedAnswer: wrongAnswer,
        }),
        submitRes
    );

    assert.equal(submitRes.body.score.accuracyPercent, 0);
    assert.equal(submitRes.body.score.correctCount, 0);
    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.accuracyPercent, 0);
});

test('submitCharacterTrainingAttempt: rejects a request missing submittedAnswer or seed', () => {
    const res1 = mockRes();
    practiceController.submitCharacterTrainingAttempt(
        reqAs(2, 'stud1', { characters: 'letters', length: 5, wpm: 15, seed: 503 }),
        res1
    );
    assert.equal(res1.statusCode, 400);

    const res2 = mockRes();
    practiceController.submitCharacterTrainingAttempt(
        reqAs(2, 'stud1', { characters: 'letters', length: 5, wpm: 15, submittedAnswer: 'ABCDE' }),
        res2
    );
    assert.equal(res2.statusCode, 400);
});

// ---------------------------------------------------------------------
// listHistory: what a page-refresh/re-login actually reads back
// ---------------------------------------------------------------------

test('listHistory: only returns the authenticated student\'s own attempts, newest first, including both new exercise types', () => {
    buildAndFinishCtSession(reqAs(2, 'stud1', { characters: 'letters', length: 5, wpm: 15, seed: 600 }));

    const res = mockRes();
    practiceController.listHistory({ user: { id: 2, username: 'stud1', role: 'student' }, query: {} }, res);

    assert.ok(res.body.total > 0);
    assert.ok(res.body.attempts.every((a) => a.studentId === 2), 'must never leak another student\'s attempts');
    const types = new Set(res.body.attempts.map((a) => a.exerciseType));
    assert.ok(types.has('radiogram_training') || types.has('character_training'));
});

// ---------------------------------------------------------------------
// Reception Training (Audio -> Text, blind copy)
// ---------------------------------------------------------------------

function generateReception(req) {
    const res = mockRes();
    practiceController.generateReceptionExercise(req, res);
    return res;
}

function submitReception(studentId, username, exercise, submittedAnswer, extra = {}) {
    const res = mockRes();
    practiceController.submitReceptionAttempt(
        reqAs(studentId, username, {
            characters: exercise.characters,
            groupSize: exercise.groupSize || 0,
            groupCount: exercise.groupCount,
            wpm: exercise.timing.wpm,
            farnsworthWpm: exercise.timing.farnsworthWpm,
            toneFrequencyHz: exercise.timing.toneFrequencyHz,
            seed: exercise.seed,
            submittedAnswer,
            ...extra,
        }),
        res
    );
    return res;
}

test('generateReceptionExercise: never reveals the answer — no text/groups/morse in the response', () => {
    const res = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 10, wpm: 15, seed: 700 }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.text, undefined);
    assert.equal(res.body.groups, undefined);
    assert.equal(res.body.morse, undefined);
    assert.ok(Array.isArray(res.body.plan) && res.body.plan.length > 0, 'a playback plan must still be provided');
    assert.equal(res.body.totalCharacters, 50);
});

test('submitReceptionAttempt: saves a result tied to the authenticated student, for a perfect answer', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 701 }));
    const exercise = genRes.body;

    // Regenerate server-side (as the real submit endpoint does internally)
    // just to know what the perfect answer is, for this test's purposes —
    // production never does this from the client.
    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: exercise.groupSize || 0, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });

    const submitRes = submitReception(2, 'stud1', exercise, full.text.replace(/\s+/g, ''), { durationMs: 9000 });
    assert.equal(submitRes.statusCode, 201);
    assert.equal(submitRes.body.score.accuracyPercent, 100);
    assert.ok(submitRes.body.attemptId);

    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 2);
    assert.equal(saved.exerciseType, 'audio_to_text');
    assert.equal(saved.durationMs, 9000);
    assert.equal(saved.accuracyPercent, 100);
});

test('submitReceptionAttempt: a 120-character exercise scores and saves correctly', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 4, groupCount: 30, wpm: 18, seed: 702 }));
    const exercise = genRes.body;
    assert.equal(exercise.totalCharacters, 120);

    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: exercise.groupSize, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });
    const submitRes = submitReception(2, 'stud1', exercise, full.text.replace(/\s+/g, ''));
    assert.equal(submitRes.body.score.totalExpected, 120);
    assert.equal(submitRes.body.score.accuracyPercent, 100);
});

test('submitReceptionAttempt: a short exercise (single small group) scores correctly', () => {
    const genRes = generateReception(reqAs(3, 'stud2', { characters: 'numbers', groupSize: 3, groupCount: 1, wpm: 15, seed: 703 }));
    const exercise = genRes.body;
    assert.equal(exercise.totalCharacters, 3);

    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: exercise.groupSize, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });
    const submitRes = submitReception(3, 'stud2', exercise, full.text.replace(/\s+/g, ''));
    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 3);
    assert.equal(saved.promptText.replace(/\s+/g, '').length, 3);
});

test('submitReceptionAttempt: correctly categorizes wrong, missing, and extra characters', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: ['A', 'B', 'C', 'D', 'E'], groupSize: 0, groupCount: 5, wpm: 15, seed: 704 }));
    const exercise = genRes.body;
    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: 0, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });
    const reference = full.text; // ungrouped, 5 chars

    // Wrong-character case: replace every character with 'Z', which is
    // outside the pool ('A'-'E') and therefore shares no character with
    // the reference at all — the alignment scorer can't find any cheaper
    // realignment via insertion/deletion, so this is a guaranteed
    // same-length, all-substitution mismatch (unlike e.g. shifting the
    // pool's own letters around, which the aligner can — correctly —
    // score as a cheaper insert/delete instead of n substitutions).
    const wrong = 'Z'.repeat(reference.length);
    const wrongRes = submitReception(2, 'stud1', exercise, wrong);
    assert.equal(wrongRes.body.score.correctCount, 0);
    assert.equal(wrongRes.body.score.incorrectCount, reference.length);
    assert.equal(wrongRes.body.score.missingCount, 0);
    assert.equal(wrongRes.body.score.extraCount, 0);

    // Missing-character case: submit one character short.
    const missingRes = submitReception(2, 'stud1', exercise, reference.slice(0, -1));
    assert.equal(missingRes.body.score.missingCount, 1);
    assert.equal(missingRes.body.score.correctCount, reference.length - 1);

    // Extra-character case: submit one character too many.
    const extraRes = submitReception(2, 'stud1', exercise, reference + 'X');
    assert.equal(extraRes.body.score.extraCount, 1);
    assert.equal(extraRes.body.score.correctCount, reference.length);
});

test('submitReceptionAttempt: normalizes group-separator spacing so formatting alone never creates false errors', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 705 }));
    const exercise = genRes.body;
    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: exercise.groupSize, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });
    const reference = full.text.replace(/\s+/g, '');

    // Student types it with completely different (extra/irregular) spacing
    // than the reference's own 5-char grouping.
    const oddlySpaced = reference.match(/.{1,2}/g).join('   ');
    const res = submitReception(2, 'stud1', exercise, oddlySpaced);
    assert.equal(res.body.score.accuracyPercent, 100, 'spacing differences alone must not count as errors');

    // The raw, literally-typed answer (with its own spacing) is still
    // stored verbatim — never silently corrected.
    const saved = practiceRepository.findById(res.body.attemptId);
    assert.equal(saved.submittedAnswer, oddlySpaced);
});

test('submitReceptionAttempt: replay/restart (same seed, submitted twice) does not regenerate the answer and both attempts persist independently', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 706 }));
    const exercise = genRes.body;
    const { buildReceptionExercise } = require('../receptionEngine');
    const full = buildReceptionExercise({ characters: exercise.characters, groupSize: exercise.groupSize, groupCount: exercise.groupCount, wpm: exercise.timing.wpm, seed: exercise.seed });
    const reference = full.text.replace(/\s+/g, '');

    const before = practiceRepository.countForStudent(2);
    const first = submitReception(2, 'stud1', exercise, reference);
    const second = submitReception(2, 'stud1', exercise, reference);

    assert.equal(first.body.reference, second.body.reference, 'the same seed must always regenerate the exact same answer');
    assert.notEqual(first.body.attemptId, second.body.attemptId, 'each submission is its own persisted attempt');
    assert.equal(practiceRepository.countForStudent(2), before + 2);
});

test('submitReceptionAttempt: reload persistence — saved result is readable back from the DB', () => {
    const genRes = generateReception(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 707 }));
    const exercise = genRes.body;
    const submitRes = submitReception(2, 'stud1', exercise, 'WRONG');
    const reread = practiceRepository.findById(submitRes.body.attemptId);
    assert.ok(reread);
    assert.equal(reread.id, submitRes.body.attemptId);
});

test('generateReceptionExercise: rejects an empty pool, and submitReceptionAttempt rejects missing submittedAnswer/seed', () => {
    const badGen = generateReception(reqAs(2, 'stud1', { characters: [], groupSize: 5, groupCount: 4, wpm: 15, seed: 708 }));
    assert.equal(badGen.statusCode, 400);

    const res1 = mockRes();
    practiceController.submitReceptionAttempt(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, seed: 709 }), res1);
    assert.equal(res1.statusCode, 400);

    const res2 = mockRes();
    practiceController.submitReceptionAttempt(reqAs(2, 'stud1', { characters: 'letters', groupSize: 5, groupCount: 4, wpm: 15, submittedAnswer: 'X' }), res2);
    assert.equal(res2.statusCode, 400);
});

// ---------------------------------------------------------------------
// Morse Transmission (keyboard -> Morse)
// ---------------------------------------------------------------------

/** Perfectly keys `text` (which may contain group-separating spaces, exactly like target.text) at the given WPM and returns the raw element log a real Space-key session would have produced. */
function keyTextPerfectly(text, wpm) {
    const engine = new TransmissionEngine({ wpm, toleranceFactor: 0.35 });
    const unitMs = 1200 / wpm;
    const words = text.split(' ');
    words.forEach((word, wordIndex) => {
        [...word].forEach((ch, charIndex) => {
            const morse = CHAR_TO_MORSE[ch.toUpperCase()];
            [...morse].forEach((sym, i) => {
                engine.feedTone(sym === '.' ? unitMs : 3 * unitMs);
                if (i < morse.length - 1) engine.feedGap(unitMs);
            });
            if (charIndex < word.length - 1) engine.feedGap(3 * unitMs);
        });
        if (wordIndex < words.length - 1) engine.feedGap(7 * unitMs);
    });
    engine.flush();
    return engine.elementLog;
}

function generateTransmission(req) {
    const res = mockRes();
    practiceController.generateTransmissionExercise(req, res);
    return res;
}

function submitTransmission(studentId, username, target, elementLog, extra = {}) {
    const res = mockRes();
    practiceController.submitTransmissionAttempt(
        reqAs(studentId, username, {
            characters: target.characters,
            groupSize: target.groupSize || 0,
            groupCount: target.groupCount,
            seed: target.seed,
            wpm: 20,
            elementLog,
            ...extra,
        }),
        res
    );
    return res;
}

test('generateTransmissionExercise: the target text IS visible (unlike Reception) — nothing withheld', () => {
    const res = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 1, groupCount: 5, seed: 900 }));
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.body.text, 'string');
    assert.equal(res.body.text.replace(/\s+/g, '').length, 5);
    assert.ok(Array.isArray(res.body.groups));
});

test('submitTransmissionAttempt: a perfectly-keyed multi-character target scores 100% and saves a result tied to the student', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 5, seed: 901 }));
    const target = genRes.body;
    const log = keyTextPerfectly(target.text, 20);

    const submitRes = submitTransmission(2, 'stud1', target, log);
    assert.equal(submitRes.statusCode, 201);
    assert.equal(submitRes.body.transmittedText, target.text); // ungrouped -> only character gaps, no word boundary ever crossed
    assert.equal(submitRes.body.score.accuracyPercent, 100);
    assert.ok(submitRes.body.attemptId);
    assert.equal(submitRes.body.stats.timingErrorCount, 0);

    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 2);
    assert.equal(saved.exerciseType, 'text_to_morse');
    assert.equal(saved.accuracyPercent, 100);
    assert.ok(saved.timingStats, 'timing stats must be persisted');
    assert.equal(saved.timingStats.timingErrorCount, 0);
});

test('submitTransmissionAttempt: correctly categorizes a wrong character', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: ['A', 'B'], groupSize: 0, groupCount: 3, seed: 902 }));
    const target = genRes.body; // e.g. "ABA" or similar, 3 chars from {A,B}
    // Key the target but swap every character for the OTHER pool member.
    const swapped = [...target.text].map((ch) => (ch === 'A' ? 'B' : 'A')).join('');
    const log = keyTextPerfectly(swapped, 20);

    const submitRes = submitTransmission(2, 'stud1', target, log);
    assert.equal(submitRes.body.score.correctCount, 0);
    assert.equal(submitRes.body.score.incorrectCount, target.text.length);
});

test('submitTransmissionAttempt: correctly categorizes a missing character', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 5, seed: 903 }));
    const target = genRes.body;
    const log = keyTextPerfectly(target.text.slice(0, -1), 20); // key everything except the last character

    const submitRes = submitTransmission(2, 'stud1', target, log);
    assert.equal(submitRes.body.score.missingCount, 1);
    assert.equal(submitRes.body.score.correctCount, target.text.length - 1);
});

test('submitTransmissionAttempt: correctly categorizes an extra character', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 5, seed: 904 }));
    const target = genRes.body;
    const log = keyTextPerfectly(target.text + 'Q', 20); // key the whole target plus an extra character

    const submitRes = submitTransmission(2, 'stud1', target, log);
    assert.equal(submitRes.body.score.extraCount, 1);
    assert.equal(submitRes.body.score.correctCount, target.text.length);
});

test('submitTransmissionAttempt: honors a numbers-only pool and a different (short) exercise length', () => {
    const genRes = generateTransmission(reqAs(3, 'stud2', { characters: 'numbers', groupSize: 0, groupCount: 3, seed: 905 }));
    const target = genRes.body;
    for (const ch of target.text) assert.ok(/[0-9]/.test(ch));
    const log = keyTextPerfectly(target.text, 20);

    const submitRes = submitTransmission(3, 'stud2', target, log);
    const saved = practiceRepository.findById(submitRes.body.attemptId);
    assert.equal(saved.studentId, 3, 'must be tied to the student who actually transmitted it');
    assert.equal(saved.promptText.length, 3);
});

test('submitTransmissionAttempt: grading is delegated to the centralized gradingService, not recomputed locally', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 5, seed: 906 }));
    const target = genRes.body;
    const log = keyTextPerfectly(target.text, 20);
    const submitRes = submitTransmission(2, 'stud1', target, log);
    assert.ok(submitRes.body.characterGrade);
    assert.equal(submitRes.body.characterGrade.grade, 10); // perfect score, any length -> grade 10 (see gradingService.test.js)
});

test('submitTransmissionAttempt: reload persistence — saved result (including timing stats) is readable back from the DB', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 907 }));
    const target = genRes.body;
    const log = keyTextPerfectly(target.text, 20);
    const submitRes = submitTransmission(2, 'stud1', target, log);

    const reread = practiceRepository.findById(submitRes.body.attemptId);
    assert.ok(reread);
    assert.equal(reread.id, submitRes.body.attemptId);
    assert.ok(reread.timingStats);
    assert.equal(reread.timingStats.targetWpm, 20);
});

test('submitTransmissionAttempt: never trusts a client-reported decoding — the server re-derives it from the raw element log', () => {
    const genRes = generateTransmission(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 908 }));
    const target = genRes.body;
    // Deliberately garbage timings that do NOT spell out the target.
    const log = [
        { type: 'tone', durationMs: 60 },
        { type: 'gap', durationMs: 180 },
    ];
    const submitRes = submitTransmission(2, 'stud1', target, log, { transmittedText: target.text }); // extra field a malicious client might add — must be ignored
    assert.notEqual(submitRes.body.transmittedText, target.text, 'the response must reflect the raw log, not any client-supplied override');
});

test('generateTransmissionExercise/submitTransmissionAttempt: rejects invalid pool/elementLog/seed/wpm', () => {
    const badGen = generateTransmission(reqAs(2, 'stud1', { characters: [], groupSize: 0, groupCount: 3, seed: 909 }));
    assert.equal(badGen.statusCode, 400);

    const noLog = mockRes();
    practiceController.submitTransmissionAttempt(reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 910, wpm: 20 }), noLog);
    assert.equal(noLog.statusCode, 400);

    const noSeed = mockRes();
    practiceController.submitTransmissionAttempt(
        reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, wpm: 20, elementLog: [{ type: 'tone', durationMs: 60 }] }),
        noSeed
    );
    assert.equal(noSeed.statusCode, 400);

    const noWpm = mockRes();
    practiceController.submitTransmissionAttempt(
        reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 911, elementLog: [{ type: 'tone', durationMs: 60 }] }),
        noWpm
    );
    assert.equal(noWpm.statusCode, 400);

    const badLog = mockRes();
    practiceController.submitTransmissionAttempt(
        reqAs(2, 'stud1', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 912, wpm: 20, elementLog: [{ type: 'nonsense', durationMs: 60 }] }),
        badLog
    );
    assert.equal(badLog.statusCode, 400);
});

// ---------------------------------------------------------------------
// listHistory filters: student History & Progress page
// ---------------------------------------------------------------------

/** Builds a small, controlled mixed history for student 4: 2 reception (radiogram) rows at wpm 15, 1 transmission row at wpm 25. */
function buildStudent4History() {
    for (const seed of [1001, 1002]) {
        const genRes = mockRes();
        practiceController.generateRadiogram(reqAs(4, 'stud3', { characters: 'letters', wpm: 15, seed }), genRes);
        const radiogram = genRes.body;
        const analyzeRes = mockRes();
        practiceController.analyzeRadiogram(
            reqAs(4, 'stud3', {
                characters: radiogram.characters,
                wpm: radiogram.timing.wpm,
                farnsworthWpm: radiogram.timing.farnsworthWpm,
                toneFrequencyHz: radiogram.timing.toneFrequencyHz,
                seed: radiogram.seed,
                submittedAnswer: radiogram.text.replace(/\s+/g, ''),
            }),
            analyzeRes
        );
    }

    const txGenRes = mockRes();
    practiceController.generateTransmissionExercise(reqAs(4, 'stud3', { characters: 'letters', groupSize: 0, groupCount: 3, seed: 1003 }), txGenRes);
    const target = txGenRes.body;
    const { TransmissionEngine } = require(path.join(CLIENT_JS_DIR, 'morse-transmitter-core.js'));
    const engine = new TransmissionEngine({ wpm: 25, toleranceFactor: 0.35 });
    const unitMs = 1200 / 25;
    [...target.text].forEach((ch, i) => {
        const morse = CHAR_TO_MORSE[ch.toUpperCase()];
        [...morse].forEach((sym, j) => {
            engine.feedTone(sym === '.' ? unitMs : 3 * unitMs);
            if (j < morse.length - 1) engine.feedGap(unitMs);
        });
        if (i < target.text.length - 1) engine.feedGap(3 * unitMs);
    });
    engine.flush();
    const txSubmitRes = mockRes();
    practiceController.submitTransmissionAttempt(
        reqAs(4, 'stud3', { characters: target.characters, groupSize: target.groupSize || 0, groupCount: target.groupCount, seed: target.seed, wpm: 25, elementLog: engine.elementLog }),
        txSubmitRes
    );
}

test('listHistory: every row carries a characterGrade and a reception/transmission direction', () => {
    buildStudent4History();
    const res = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: {} }, res);

    assert.equal(res.body.total, 3);
    res.body.attempts.forEach((a) => {
        assert.ok(a.characterGrade, `attempt ${a.id} (${a.exerciseType}) should carry a characterGrade`);
        assert.ok(a.direction === 'reception' || a.direction === 'transmission');
    });
    const directions = new Set(res.body.attempts.map((a) => a.direction));
    assert.deepEqual([...directions].sort(), ['reception', 'transmission']);
});

test('listHistory: filters by direction (reception vs transmission)', () => {
    const receptionRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { direction: 'reception' } }, receptionRes);
    assert.equal(receptionRes.body.total, 2);
    assert.ok(receptionRes.body.attempts.every((a) => a.direction === 'reception'));

    const transmissionRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { direction: 'transmission' } }, transmissionRes);
    assert.equal(transmissionRes.body.total, 1);
    assert.ok(transmissionRes.body.attempts.every((a) => a.direction === 'transmission'));
});

test('listHistory: filters by exerciseType', () => {
    const res = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { exerciseType: 'radiogram_training' } }, res);
    assert.equal(res.body.total, 2);
    assert.ok(res.body.attempts.every((a) => a.exerciseType === 'radiogram_training'));
});

test('listHistory: filters by WPM range', () => {
    const lowRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { minWpm: '20' } }, lowRes);
    assert.equal(lowRes.body.total, 1); // only the wpm-25 transmission row

    const highRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { maxWpm: '20' } }, highRes);
    assert.equal(highRes.body.total, 2); // the two wpm-15 radiogram rows
});

test('listHistory: filters by date (since/until), and an impossible future date range returns nothing', () => {
    const todayRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { since: '2020-01-01' } }, todayRes);
    assert.equal(todayRes.body.total, 3, 'everything was inserted today, well after 2020');

    const futureRes = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { since: '2999-01-01' } }, futureRes);
    assert.equal(futureRes.body.total, 0);
});

test('listHistory: an invalid exerciseType/direction is ignored rather than erroring (falls back to "no filter")', () => {
    const res = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { exerciseType: 'not-a-real-type', direction: 'sideways' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.total, 3);
});

test('listHistory: filters combine with AND, and student isolation still holds under filters', () => {
    const res = mockRes();
    practiceController.listHistory({ user: { id: 4, username: 'stud3', role: 'student' }, query: { direction: 'reception', minWpm: '10' } }, res);
    assert.equal(res.body.total, 2);
    assert.ok(res.body.attempts.every((a) => a.studentId === 4));

    // Student 2 (a completely different student, with lots of their own
    // unrelated history from earlier tests in this file) must never leak
    // into student 4's filtered results, and vice versa.
    const otherRes = mockRes();
    practiceController.listHistory({ user: { id: 2, username: 'stud1', role: 'student' }, query: {} }, otherRes);
    assert.ok(otherRes.body.attempts.every((a) => a.studentId === 2));
});
