/**
 * Parses a Morse string (using this app's "." "-" space "/" convention)
 * into a nested structure: an array of words, each an array of
 * characters, each a string of "." / "-" symbols. Both
 * computeSequenceDurationMs and buildPlaybackPlan (in timingService.js
 * and playbackPlan.js) are built on this single parser so the two can
 * never silently drift apart.
 *
 * @param {string} morse
 * @returns {string[][]} words[wordIndex][charIndex] = ".-" etc.
 */
function parseMorseWords(morse) {
    if (typeof morse !== 'string') {
        throw new TypeError('parseMorseWords expects a string.');
    }
    const trimmed = morse.trim();
    if (trimmed.length === 0) return [];

    const normalized = trimmed.replace(/\s*\/\s*/g, ' / ');
    return normalized
        .split(' / ')
        .map((word) => word.trim().split(/\s+/).filter((c) => c.length > 0))
        .filter((word) => word.length > 0);
}

module.exports = { parseMorseWords };
