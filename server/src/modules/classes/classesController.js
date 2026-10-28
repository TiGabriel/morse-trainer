const classRepository = require('./classRepository');
const classMorseRepository = require('./classMorseRepository');
const { CHAR_TO_MORSE } = require('../morse-engine/morseMap');
const userRepository = require('../users/userRepository');
const logger = require('../../logger');

function listClasses(req, res) {
    const classes = classRepository.listAll();
    // Each class's Morse Alphabet selection is teacher-only data: this
    // route is also open to students, who must never learn another
    // class's (or even their own class's) configuration from it.
    if (req.user.role === 'teacher') {
        const byClass = classMorseRepository.listAllByClass();
        classes.forEach((cls) => {
            cls.morseCharacters = byClass[cls.id] || [];
        });
    }
    return res.json({ classes });
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

/** GET /api/classes/:id/morse-characters — teacher-only: the class's Morse Alphabet selection. */
function getMorseCharacters(req, res) {
    const id = Number(req.params.id);
    if (!classRepository.findById(id)) {
        return res.status(404).json({ error: 'Class not found.' });
    }
    return res.json({ classId: id, characters: classMorseRepository.listForClass(id) });
}

/**
 * PUT /api/classes/:id/morse-characters — teacher-only.
 * Body: { characters: string[] } — replaces the class's whole selection
 * (an empty array clears it). Every entry must be a character the Morse
 * engine actually supports (CHAR_TO_MORSE); anything else is rejected
 * rather than silently dropped, so the teacher's intent is never
 * half-saved.
 */
function setMorseCharacters(req, res) {
    const id = Number(req.params.id);
    const existing = classRepository.findById(id);
    if (!existing) {
        return res.status(404).json({ error: 'Class not found.' });
    }

    const { characters } = req.body || {};
    if (!Array.isArray(characters)) {
        return res.status(400).json({ error: 'characters (array) is required.' });
    }
    const normalized = new Set();
    for (const raw of characters) {
        const ch = typeof raw === 'string' ? raw.toUpperCase() : '';
        if (ch.length !== 1 || !Object.prototype.hasOwnProperty.call(CHAR_TO_MORSE, ch)) {
            return res.status(400).json({ error: `Unsupported Morse character: ${JSON.stringify(raw)}` });
        }
        normalized.add(ch);
    }

    const sorted = classMorseRepository.sortCanonical([...normalized]);
    classMorseRepository.replaceForClass(id, sorted);
    logger.info(
        `Morse Alphabet for class "${existing.name}" set to [${sorted.join(' ')}] (${sorted.length}) by teacher "${req.user.username}"`
    );
    return res.json({ classId: id, characters: sorted });
}

module.exports = {
    listClasses,
    createClass,
    updateClass,
    setClassActive,
    deleteClass,
    getMorseCharacters,
    setMorseCharacters,
};
