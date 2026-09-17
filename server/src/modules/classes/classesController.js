const classRepository = require('./classRepository');
const userRepository = require('../users/userRepository');
const logger = require('../../logger');

function listClasses(req, res) {
    return res.json({ classes: classRepository.listAll() });
}

function createClass(req, res) {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required.' });
    }
    const trimmed = name.trim();
    if (classRepository.findByName(trimmed)) {
        return res.status(409).json({ error: 'A class with that name already exists.' });
    }

    const created = classRepository.create(trimmed);
    logger.info(`Class created: "${created.name}" by teacher "${req.user.username}"`);
    return res.status(201).json({ class: created });
}

/** PATCH /api/classes/:id — rename a class. */
function updateClass(req, res) {
    const id = Number(req.params.id);
    const existing = classRepository.findById(id);
    if (!existing) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required.' });
    }
    const trimmed = name.trim();

    const clash = classRepository.findByName(trimmed);
    if (clash && clash.id !== id) {
        return res.status(409).json({ error: 'A class with that name already exists.' });
    }

    const updated = classRepository.rename(id, trimmed);
    logger.info(`Class renamed: "${existing.name}" -> "${trimmed}" by teacher "${req.user.username}"`);
    return res.json({ class: updated });
}

/** PATCH /api/classes/:id/status — deactivate/reactivate a class (soft, reversible). */
function setClassActive(req, res) {
    const { isActive } = req.body || {};
    if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive (boolean) is required.' });
    }

    const id = Number(req.params.id);
    const updated = classRepository.setActive(id, isActive);
    if (!updated) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    logger.info(
        `Class "${updated.name}" set to ${isActive ? 'ACTIVE' : 'INACTIVE'} by teacher "${req.user.username}"`
    );
    return res.json({ class: updated });
}

/**
 * DELETE /api/classes/:id — safe hard delete.
 * Refuses if any user (active or inactive) still references this class,
 * so a class can never be deleted out from under enrolled students by
 * accident. The teacher must reassign or remove those students first
 * (or use deactivate instead, which is always safe/reversible).
 */
function deleteClass(req, res) {
    const id = Number(req.params.id);
    const existing = classRepository.findById(id);
    if (!existing) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    const memberCount = userRepository.countInClass(id);
    if (memberCount > 0) {
        return res.status(409).json({
            error: `Cannot delete "${existing.name}": ${memberCount} account(s) are still assigned to it. ` +
                `Reassign or remove those accounts first, or deactivate the class instead of deleting it.`,
        });
    }

    classRepository.remove(id);
    logger.info(`Class deleted: "${existing.name}" by teacher "${req.user.username}"`);
    return res.json({ success: true });
}

module.exports = { listClasses, createClass, updateClass, setClassActive, deleteClass };
