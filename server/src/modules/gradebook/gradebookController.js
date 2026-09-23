/**
 * Electronic gradebook ("Catalog electronic") — teacher-only HTTP layer.
 * Every route is mounted behind requireAuth + requireRole('teacher') (see
 * gradebookRoutes.js), so a student can never read, create, edit or
 * delete any entry, including their own.
 *
 * Lifecycle rules enforced here (not just in the UI):
 *   - manual entries are permanent as soon as they're saved;
 *   - automatic Formal Test entries start temporary and only become
 *     permanent through the explicit POST .../confirm action;
 *   - a permanent Formal Test entry's grade is locked (it's the official
 *     result) and it can't be deleted — only its note can still change.
 */
const gradebookRepository = require('./gradebookRepository');
const userRepository = require('../users/userRepository');
const logger = require('../../logger');

const MAX_NOTE_LENGTH = 2000;

/** Integer grade 1-10, null for "no grade", or undefined when the value is invalid. */
function parseGrade(value) {
    if (value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 10) return undefined;
    return n;
}

function parseNote(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return undefined;
    return value.trim().slice(0, MAX_NOTE_LENGTH);
}

function findStudentOr404(req, res) {
    const studentId = Number(req.params.studentId);
    const student = Number.isInteger(studentId) ? userRepository.findByIdPublic(studentId) : null;
    if (!student || student.role !== 'student') {
        res.status(404).json({ error: 'Student not found.' });
        return null;
    }
    return student;
}

function findEntryOr404(req, res) {
    const entry = gradebookRepository.findById(Number(req.params.entryId));
    if (!entry) {
        res.status(404).json({ error: 'Gradebook entry not found.' });
        return null;
    }
    return entry;
}

/** GET /api/gradebook/pending-counts — { [studentId]: count } of temporary entries awaiting confirmation. */
function getPendingCounts(req, res) {
    return res.json({ pending: gradebookRepository.countPendingByStudent() });
}

/** GET /api/gradebook/students/:studentId/entries */
function listStudentEntries(req, res) {
    const student = findStudentOr404(req, res);
    if (!student) return undefined;
    return res.json({ student, entries: gradebookRepository.listForStudent(student.id) });
}

/** POST /api/gradebook/students/:studentId/entries — body { type: 'grade'|'note', grade?, note? } */
function createEntry(req, res) {
    const student = findStudentOr404(req, res);
    if (!student) return undefined;
    const body = req.body || {};

    if (!gradebookRepository.ENTRY_TYPES.includes(body.type)) {
        return res.status(400).json({ error: `type must be one of: ${gradebookRepository.ENTRY_TYPES.join(', ')}` });
    }
    const note = parseNote(body.note);
    if (note === undefined) return res.status(400).json({ error: 'note must be text.' });

    let grade = null;
    if (body.type === 'grade') {
        grade = parseGrade(body.grade);
        if (grade === undefined || grade === null) {
            return res.status(400).json({ error: 'grade must be a whole number from 1 to 10.' });
        }
    } else if (!note) {
        return res.status(400).json({ error: 'A note cannot be empty.' });
    }

    const entry = gradebookRepository.createManualEntry({ studentId: student.id, teacherId: req.user.id, type: body.type, grade, note });
    logger.info(`Gradebook: ${body.type} entry ${entry.id} added for student ${student.id} by teacher "${req.user.username}"`);
    return res.status(201).json({ entry });
}

/** PATCH /api/gradebook/entries/:entryId — body { grade?, note? } */
function updateEntry(req, res) {
    const entry = findEntryOr404(req, res);
    if (!entry) return undefined;
    const body = req.body || {};
    const changes = {};

    if (body.note !== undefined) {
        const note = parseNote(body.note);
        if (note === undefined) return res.status(400).json({ error: 'note must be text.' });
        if (entry.type === 'note' && !note) return res.status(400).json({ error: 'A note cannot be empty.' });
        changes.note = note;
    }
    if (body.grade !== undefined) {
        if (entry.type !== 'grade') return res.status(400).json({ error: 'A note entry has no grade.' });
        if (entry.source === 'formal_test' && entry.isPermanent) {
            return res.status(409).json({ error: 'A permanently saved Formal Test grade cannot be changed.' });
        }
        const grade = parseGrade(body.grade);
        if (grade === undefined || grade === null) {
            return res.status(400).json({ error: 'grade must be a whole number from 1 to 10.' });
        }
        changes.grade = grade;
    }

    const updated = gradebookRepository.updateEntry(entry.id, changes);
    logger.info(`Gradebook: entry ${entry.id} edited by teacher "${req.user.username}"`);
    return res.json({ entry: updated });
}

/** POST /api/gradebook/entries/:entryId/confirm — "Save permanently" for a temporary Formal Test entry. */
function confirmEntry(req, res) {
    const entry = findEntryOr404(req, res);
    if (!entry) return undefined;
    if (entry.isPermanent) return res.json({ entry });
    if (entry.type === 'grade' && (entry.grade === null || entry.grade === undefined)) {
        return res.status(400).json({ error: 'Set a grade before saving this entry permanently.' });
    }
    const updated = gradebookRepository.markPermanent(entry.id);
    logger.info(`Gradebook: entry ${entry.id} saved permanently by teacher "${req.user.username}"`);
    return res.json({ entry: updated });
}

/** DELETE /api/gradebook/entries/:entryId */
function deleteEntry(req, res) {
    const entry = findEntryOr404(req, res);
    if (!entry) return undefined;
    if (entry.source === 'formal_test' && entry.isPermanent) {
        return res.status(409).json({ error: 'A permanently saved Formal Test grade cannot be deleted.' });
    }
    gradebookRepository.deleteEntry(entry.id);
    logger.info(`Gradebook: entry ${entry.id} (${entry.source}) deleted by teacher "${req.user.username}"`);
    return res.json({ deleted: true });
}

module.exports = { getPendingCounts, listStudentEntries, createEntry, updateEntry, confirmEntry, deleteEntry };
