/**
 * Shared normalization for typed copy answers (radiograms, reception,
 * group-session items). A student may type groups with or without spaces;
 * what counts is the character sequence, so:
 *
 *   - whitespace is stripped and the text uppercased (comparison
 *     normalization — the same convention scoreAnswer already uses),
 *   - anything beyond the exercise's own character count is dropped (the
 *     UI already refuses to accept more; this is the server-side guard),
 *   - the result is re-spaced every `groupSize` characters for storage and
 *     display, so "ABCDEFGH" typed without spaces is shown as "ABCD EFGH".
 */

/** Whitespace-free, uppercased, and capped at `maxLength` characters (no cap when maxLength is falsy). */
function normalizeAnswer(raw, maxLength) {
    const compact = String(raw ?? '')
        .replace(/\s+/g, '')
        .toUpperCase();
    return maxLength > 0 ? compact.slice(0, maxLength) : compact;
}

/** Inserts a space after every `groupSize` characters. groupSize 0/null returns the text unchanged. */
function formatIntoGroups(compact, groupSize) {
    if (!groupSize || groupSize < 1) return compact;
    const groups = [];
    for (let i = 0; i < compact.length; i += groupSize) {
        groups.push(compact.slice(i, i + groupSize));
    }
    return groups.join(' ');
}

module.exports = { normalizeAnswer, formatIntoGroups };
