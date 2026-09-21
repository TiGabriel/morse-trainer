/**
 * Centralized character-based grading service: turns "how many
 * characters were scored correctly, out of how many were scored" into a
 * school grade from 4 to 10. Single source of truth for every exercise
 * type that produces a character-based score — Individual Training
 * (Character Training, Radiogram Training), Group Practice, and Formal
 * Test all call `calculateGrade()` here rather than each implementing
 * their own threshold table.
 *
 * This module never re-derives correct/incorrect characters itself — it
 * only ever consumes the `correct`/`total` counts an exercise's own
 * existing scoring (morse-engine's `scoreAnswer`, or Character Training's
 * per-round correctness) has already authoritatively computed.
 *
 * ---------------------------------------------------------------------
 * Reference scale — a full 120-character test (a standard radiogram: 3
 * rows x 10 groups x 4 characters):
 *
 *   0–18   correct -> grade 4  (starting grade / insufficient)
 *   19–38  correct -> grade 5  (first passing grade)
 *   39–58  correct -> grade 6
 *   59–78  correct -> grade 7
 *   79–98  correct -> grade 8
 *   99–119 correct -> grade 9
 *   120    correct -> grade 10 (perfect score only)
 *
 * Boundary ambiguity (59 -> 6 or 7?) and how it was resolved:
 * the brief's own first table read "39–59 -> 6" then jumped straight to
 * "60–79 -> 8", skipping grade 7 entirely, while separately stating
 * "59 -> 7" as its own explicit boundary. Both cannot hold for the value
 * 59. Since every other step is explicitly ~20 correct characters wide
 * and there are 7 grades (4 through 10) to fit into 0–120, the only
 * reading under which all 7 grades each get their own ~20-wide band (and
 * none are skipped) is: 59 is the START of the grade-7 band, matching
 * the explicit "59 -> 7" literally, which shifts the following bands
 * down by one grade from the first table's (mistaken) labels and
 * restores grade 7 instead of skipping it.
 * ---------------------------------------------------------------------
 */

/** The scale every threshold below is expressed against. Not a length limit — see calculateGrade for how other lengths are normalized to this. */
const REFERENCE_TEST_LENGTH = 120;

/**
 * THE single source of truth for grade boundaries. Ascending by
 * `minCorrectAt120` — the minimum "correct characters, scaled to a
 * REFERENCE_TEST_LENGTH-character test" needed to earn that grade.
 * Change grading policy ONLY here — nothing else in the codebase should
 * hardcode 19/39/59/79/99/120 or any other boundary.
 */
const GRADE_THRESHOLDS = [
    { grade: 4, minCorrectAt120: 0 },
    { grade: 5, minCorrectAt120: 19 },
    { grade: 6, minCorrectAt120: 39 },
    { grade: 7, minCorrectAt120: 59 },
    { grade: 8, minCorrectAt120: 79 },
    { grade: 9, minCorrectAt120: 99 },
    { grade: 10, minCorrectAt120: REFERENCE_TEST_LENGTH },
];

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Converts a correct/total character count (of ANY valid test length)
 * into a school grade from 4 to 10, by normalizing to the 120-character
 * reference scale and applying GRADE_THRESHOLDS.
 *
 * Deterministic at every boundary: the grade decision itself never
 * divides or compares floats — it cross-multiplies
 * `correct * REFERENCE_TEST_LENGTH` against `threshold * total`, both
 * exact integers, so there is no rounding-induced grade jump at a
 * threshold. (`normalizedCorrect`/`percentage` in the returned result
 * ARE rounded for display, but only for display — they play no part in
 * the grade decision above.)
 *
 * Grade 10 falls out of the same comparison with no special case needed:
 * `correct * 120 >= 120 * total` reduces to `correct >= total`, which
 * (since correct is clamped to at most total) only holds when
 * correct === total — i.e. a genuinely perfect score, at any length.
 *
 * @param {{correct: number, total: number}} counts - the authoritative
 *   correct/total scored-character counts from the exercise's own
 *   existing scoring result. `total` must already exclude anything the
 *   existing scoring system doesn't treat as a scored character (e.g.
 *   radiogram group-separator spaces — morse-engine's `scoreAnswer` and
 *   `sessionEngine.gradeSubmission` already strip those before scoring).
 * @returns {{grade:number, correctCharacters:number, totalCharacters:number,
 *   incorrectCharacters:number, accuracy:number, percentage:number,
 *   normalizedCorrect:number}}
 */
function calculateGrade({ correct, total }) {
    if (!Number.isFinite(total) || total <= 0) {
        throw new RangeError('calculateGrade requires total to be a positive number.');
    }
    if (!Number.isFinite(correct)) {
        throw new RangeError('calculateGrade requires correct to be a number.');
    }

    const totalCharacters = Math.round(total);
    // Clamped so a caller's off-by-one (or a submission longer than the
    // reference) can never push correctCharacters outside [0, total].
    const correctCharacters = Math.min(Math.max(Math.round(correct), 0), totalCharacters);

    let grade = GRADE_THRESHOLDS[0].grade;
    for (const entry of GRADE_THRESHOLDS) {
        if (correctCharacters * REFERENCE_TEST_LENGTH >= entry.minCorrectAt120 * totalCharacters) {
            grade = entry.grade;
        }
    }

    const incorrectCharacters = totalCharacters - correctCharacters;
    const percentage = round2((correctCharacters / totalCharacters) * 100);
    const normalizedCorrect = round2((correctCharacters / totalCharacters) * REFERENCE_TEST_LENGTH);

    return {
        grade,
        correctCharacters,
        totalCharacters,
        incorrectCharacters,
        // `accuracy` and `percentage` are intentionally the same value —
        // both names are used by different parts of the spec/UI for the
        // same "percent of scored characters correct" figure.
        accuracy: percentage,
        percentage,
        normalizedCorrect,
    };
}

module.exports = { REFERENCE_TEST_LENGTH, GRADE_THRESHOLDS, calculateGrade };
