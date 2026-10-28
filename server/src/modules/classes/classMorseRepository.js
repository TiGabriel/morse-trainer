const db = require('../../db/client');
const { CHARSETS } = require('../morse-engine/morseMap');

/**
 * Per-class Morse Alphabet visibility (table class_morse_characters).
 * Characters are returned in the canonical CHARSETS.all order (letters,
 * numbers, punctuation) regardless of insertion order, so every caller
 * gets a stable, readable list.
 */
const CANONICAL_ORDER = new Map(CHARSETS.all.map((ch, i) => [ch, i]));

function sortCanonical(chars) {
    return chars
        .filter((ch) => CANONICAL_ORDER.has(ch))
        .sort((a, b) => CANONICAL_ORDER.get(a) - CANONICAL_ORDER.get(b));
}

/** The allowed characters for one class ([] when nothing is configured). */
function listForClass(classId) {
    const rows = db.prepare('SELECT morse_char FROM class_morse_characters WHERE class_id = ?').all(classId);
    return sortCanonical(rows.map((r) => r.morse_char));
}

/** { [classId]: [chars...] } for every class that has at least one character configured. */
function listAllByClass() {
    const rows = db.prepare('SELECT class_id, morse_char FROM class_morse_characters').all();
    const byClass = {};
    rows.forEach((r) => {
        (byClass[r.class_id] = byClass[r.class_id] || []).push(r.morse_char);
    });
    Object.keys(byClass).forEach((id) => {
        byClass[id] = sortCanonical(byClass[id]);
    });
    return byClass;
}

/** Replaces a class's whole character set atomically. `chars` must already be validated. */
const replaceForClass = db.transaction((classId, chars) => {
    db.prepare('DELETE FROM class_morse_characters WHERE class_id = ?').run(classId);
    const insert = db.prepare('INSERT INTO class_morse_characters (class_id, morse_char) VALUES (?, ?)');
    chars.forEach((ch) => insert.run(classId, ch));
});

module.exports = { listForClass, listAllByClass, replaceForClass, sortCanonical };
