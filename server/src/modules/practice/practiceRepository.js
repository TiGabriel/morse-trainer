const db = require('../../db/client');

function toPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        studentId: row.student_id,
        exerciseType: row.exercise_type,
        difficulty: row.difficulty,
        wpm: row.wpm,
        farnsworthWpm: row.farnsworth_wpm,
        toneFrequencyHz: row.tone_frequency_hz,
        promptText: row.prompt_text,
        promptMorse: row.prompt_morse,
        expectedAnswer: row.expected_answer,
        submittedAnswer: row.submitted_answer,
        correctCount: row.correct_count,
        incorrectCount: row.incorrect_count,
        missingCount: row.missing_count,
        extraCount: row.extra_count,
        accuracyPercent: row.accuracy_percent,
        durationMs: row.duration_ms,
        createdAt: row.created_at,
    };
}

function insertAttempt(data) {
    const info = db
        .prepare(
            `INSERT INTO practice_attempts (
                student_id, exercise_type, difficulty, wpm, farnsworth_wpm, tone_frequency_hz,
                prompt_text, prompt_morse, expected_answer, submitted_answer,
                correct_count, incorrect_count, missing_count, extra_count, accuracy_percent, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            data.studentId,
            data.exerciseType,
            data.difficulty || null,
            data.wpm,
            data.farnsworthWpm || null,
            data.toneFrequencyHz || null,
            data.promptText,
            data.promptMorse,
            data.expectedAnswer,
            data.submittedAnswer,
            data.correctCount,
            data.incorrectCount,
            data.missingCount,
            data.extraCount,
            data.accuracyPercent,
            data.durationMs || null
        );
    return findById(info.lastInsertRowid);
}

function findById(id) {
    return toPublic(db.prepare('SELECT * FROM practice_attempts WHERE id = ?').get(id));
}

function listForStudent(studentId, { limit = 20, offset = 0 } = {}) {
    const rows = db
        .prepare('SELECT * FROM practice_attempts WHERE student_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(studentId, limit, offset);
    return rows.map(toPublic);
}

function countForStudent(studentId) {
    return db.prepare('SELECT COUNT(*) AS count FROM practice_attempts WHERE student_id = ?').get(studentId).count;
}

module.exports = { insertAttempt, findById, listForStudent, countForStudent };
