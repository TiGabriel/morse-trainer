/**
 * Difficulty is DATA, not code. Adding, removing, or tuning a difficulty
 * level means editing this array — never adding a new folder or a new
 * branch of if/else logic elsewhere in the engine. Every preset is
 * resolved by the same generic `generateFromDifficulty()` function in
 * generator.js.
 *
 * `characters` may be the name of a set from CHARSETS (morseMap.js) or,
 * for a custom preset, an explicit array of characters.
 * `wpmRange` / `lengthRange` are inclusive [min, max] pairs; a concrete
 * value is picked from within the range at generation time (using the
 * same seeded RNG as the character selection, so the whole result is
 * reproducible from one seed).
 */
const DIFFICULTY_PRESETS = [
    {
        id: 'beginner',
        label: 'Beginner',
        description: 'A small high-frequency subset of letters, slow speed, short strings.',
        characters: ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T', 'L', 'O'],
        wpmRange: [5, 8],
        farnsworthWpmRange: [5, 5],
        lengthRange: [5, 8],
        groupSize: null,
    },
    {
        id: 'easy',
        label: 'Easy',
        description: 'Full alphabet, moderate speed, short-to-medium strings.',
        characters: 'letters',
        wpmRange: [8, 12],
        farnsworthWpmRange: [8, 10],
        lengthRange: [8, 15],
        groupSize: null,
    },
    {
        id: 'medium',
        label: 'Medium',
        description: 'Letters and numbers, standard speed, longer strings sent in 5-character groups.',
        characters: 'alphanumeric',
        wpmRange: [13, 18],
        farnsworthWpmRange: undefined,
        lengthRange: [15, 25],
        groupSize: 5,
    },
    {
        id: 'hard',
        label: 'Hard',
        description: 'Letters, numbers, and punctuation at full speed, longer strings in 5-character groups.',
        characters: 'all',
        wpmRange: [18, 25],
        farnsworthWpmRange: undefined,
        lengthRange: [20, 35],
        groupSize: 5,
    },
];

function findDifficultyPreset(id) {
    return DIFFICULTY_PRESETS.find((preset) => preset.id === id) || null;
}

module.exports = { DIFFICULTY_PRESETS, findDifficultyPreset };
