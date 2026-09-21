/**
 * Centralized character-based grading (school grade 4-10) — client-side
 * mirror of server/src/modules/grading/gradingService.js, used wherever a
 * result is computed entirely in the browser with no server round-trip
 * (Character Training's per-session aggregate — see practice.js). Every
 * other exercise type (Radiogram Training, Group Practice, Formal Test)
 * gets its grade straight from the server, computed by that same
 * server-side module, so this file is only ever a second COPY of the
 * scale/formula, never a second grading DECISION for the same result.
 *
 * This project has no client/server bundler to share one file between
 * the two runtimes (plain static HTML/JS, no build step) — both copies
 * must be kept in sync if the scale ever changes. See the server
 * module's header comment for the full reasoning behind the threshold
 * table and how the 59/7 grade-boundary ambiguity was resolved.
 */
(function () {
    const REFERENCE_TEST_LENGTH = 120;

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

    /** See gradingService.js's calculateGrade — identical contract and behavior. */
    function calculateGrade({ correct, total }) {
        if (!Number.isFinite(total) || total <= 0) {
            throw new RangeError('calculateGrade requires total to be a positive number.');
        }
        if (!Number.isFinite(correct)) {
            throw new RangeError('calculateGrade requires correct to be a number.');
        }

        const totalCharacters = Math.round(total);
        const correctCharacters = Math.min(Math.max(Math.round(correct), 0), totalCharacters);

        let grade = GRADE_THRESHOLDS[0].grade;
        GRADE_THRESHOLDS.forEach((entry) => {
            if (correctCharacters * REFERENCE_TEST_LENGTH >= entry.minCorrectAt120 * totalCharacters) {
                grade = entry.grade;
            }
        });

        const incorrectCharacters = totalCharacters - correctCharacters;
        const percentage = round2((correctCharacters / totalCharacters) * 100);
        const normalizedCorrect = round2((correctCharacters / totalCharacters) * REFERENCE_TEST_LENGTH);

        return {
            grade,
            correctCharacters,
            totalCharacters,
            incorrectCharacters,
            accuracy: percentage,
            percentage,
            normalizedCorrect,
        };
    }

    /** '' | 'mid' | 'low' — matches .result-grade-value's modifier classes in practice.css. */
    function gradeSeverityClass(grade) {
        if (grade <= 4) return 'low';
        if (grade <= 7) return 'mid';
        return '';
    }

    /** Full badge modifier class — matches .badge-grade-low/mid/high in styles.css. */
    function gradeBadgeClass(grade) {
        if (grade <= 4) return 'badge-grade-low';
        if (grade <= 7) return 'badge-grade-mid';
        return 'badge-grade-high';
    }

    window.GradingService = { REFERENCE_TEST_LENGTH, GRADE_THRESHOLDS, calculateGrade, gradeSeverityClass, gradeBadgeClass };
})();
