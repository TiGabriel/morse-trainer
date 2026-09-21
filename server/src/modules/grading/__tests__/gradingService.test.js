const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateGrade, REFERENCE_TEST_LENGTH, GRADE_THRESHOLDS } = require('../gradingService');

test('REFERENCE_TEST_LENGTH is 120, and thresholds are ascending with 7 distinct grades 4..10', () => {
    assert.equal(REFERENCE_TEST_LENGTH, 120);
    const grades = GRADE_THRESHOLDS.map((t) => t.grade);
    assert.deepEqual(grades, [4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < GRADE_THRESHOLDS.length; i += 1) {
        assert.ok(GRADE_THRESHOLDS[i].minCorrectAt120 > GRADE_THRESHOLDS[i - 1].minCorrectAt120);
    }
});

test('120-character reference test: every documented boundary produces the expected grade', () => {
    const cases = [
        [0, 4], [18, 4],
        [19, 5], [38, 5],
        [39, 6], [58, 6],
        [59, 7], [78, 7],
        [79, 8], [98, 8],
        [99, 9], [119, 9],
        [120, 10],
    ];
    for (const [correct, expectedGrade] of cases) {
        const result = calculateGrade({ correct, total: 120 });
        assert.equal(result.grade, expectedGrade, `${correct}/120 should be grade ${expectedGrade}, got ${result.grade}`);
    }
});

test('section 17 boundary sweep: 0,19,20,39,40,59,60,79,80,99,100,119,120 out of 120', () => {
    const expected = {
        0: 4, 19: 5, 20: 5, 39: 6, 40: 6, 59: 7, 60: 7,
        79: 8, 80: 8, 99: 9, 100: 9, 119: 9, 120: 10,
    };
    for (const [correct, grade] of Object.entries(expected)) {
        assert.equal(calculateGrade({ correct: Number(correct), total: 120 }).grade, grade, `${correct}/120`);
    }
});

test('a perfect 120-character test is grade 10; 119/120 and 118/120 are not', () => {
    assert.equal(calculateGrade({ correct: 120, total: 120 }).grade, 10);
    assert.ok(calculateGrade({ correct: 119, total: 120 }).grade < 10);
    assert.ok(calculateGrade({ correct: 118, total: 120 }).grade < 10);
});

test('any perfect shorter test (correct === total) is grade 10, regardless of length', () => {
    for (const total of [1, 5, 10, 20, 25, 30, 40, 50, 60, 80, 100]) {
        const result = calculateGrade({ correct: total, total });
        assert.equal(result.grade, 10, `${total}/${total} should be grade 10`);
    }
});

test('imperfect shorter tests grade by normalized percentage, not raw correct count', () => {
    // Every one of these is exactly 50% -> normalizedCorrect 60 -> grade 7,
    // regardless of how long the actual test was.
    const fiftyPercentCases = [
        [5, 10], [10, 20], [15, 30], [20, 40], [25, 50], [30, 60], [40, 80],
    ];
    for (const [correct, total] of fiftyPercentCases) {
        const result = calculateGrade({ correct, total });
        assert.equal(result.grade, 7, `${correct}/${total} (50%) should be grade 7, got ${result.grade}`);
        assert.equal(result.normalizedCorrect, 60);
    }
});

test('grading is scale-invariant: identical percentages produce identical grades across very different lengths', () => {
    // 25% correct at several lengths -> normalizedCorrect 30 -> grade 5.
    const quarterCases = [[1, 4], [5, 20], [10, 40], [25, 100]];
    const grades = quarterCases.map(([correct, total]) => calculateGrade({ correct, total }).grade);
    assert.ok(grades.every((g) => g === grades[0]), `expected identical grades, got ${grades}`);
    assert.equal(grades[0], 5);
});

test('edge cases: 0 correct, 1 correct, total-1 correct, total correct', () => {
    for (const total of [1, 7, 13, 17, 23, 37, 47, 73, 97, 119, 120]) {
        const zero = calculateGrade({ correct: 0, total });
        assert.equal(zero.grade, 4, `0/${total} should be grade 4`);

        const perfect = calculateGrade({ correct: total, total });
        assert.equal(perfect.grade, 10, `${total}/${total} should be grade 10`);

        if (total > 1) {
            const one = calculateGrade({ correct: 1, total });
            assert.ok(one.grade >= 4 && one.grade <= 10, `1/${total} produced an out-of-range grade ${one.grade}`);

            const totalMinusOne = calculateGrade({ correct: total - 1, total });
            assert.ok(totalMinusOne.grade < 10, `${total - 1}/${total} must not be a perfect grade 10`);
        }
    }
});

test('unusual test lengths (not multiples of 20) still grade deterministically and without a hardcoded table', () => {
    for (const total of [7, 13, 17, 23, 37, 47, 73, 97, 119]) {
        for (let correct = 0; correct <= total; correct += 1) {
            const result = calculateGrade({ correct, total });
            assert.ok(result.grade >= 4 && result.grade <= 10);
            assert.equal(result.correctCharacters, correct);
            assert.equal(result.totalCharacters, total);
            assert.equal(result.incorrectCharacters, total - correct);
        }
    }
});

test('returned result carries every field the spec asks for, self-consistent', () => {
    const result = calculateGrade({ correct: 87, total: 120 });
    assert.equal(result.correctCharacters, 87);
    assert.equal(result.totalCharacters, 120);
    assert.equal(result.incorrectCharacters, 33);
    assert.equal(result.accuracy, result.percentage);
    assert.equal(result.percentage, 72.5);
    assert.equal(result.normalizedCorrect, 87); // already at the 120 reference length
    assert.ok(Number.isInteger(result.grade) && result.grade >= 4 && result.grade <= 10);
});

test('grade decision is deterministic and stable across repeated calls (no incidental float drift)', () => {
    const runsA = new Set();
    const runsB = new Set();
    for (let i = 0; i < 50; i += 1) {
        runsA.add(calculateGrade({ correct: 59, total: 120 }).grade);
        runsB.add(calculateGrade({ correct: 15, total: 30 }).grade);
    }
    assert.equal(runsA.size, 1, 'same input must always produce the same grade');
    assert.equal(runsB.size, 1, 'same input must always produce the same grade');
    assert.equal([...runsA][0], 7);
    assert.equal([...runsB][0], 7);
});

test('rejects invalid input rather than silently returning a wrong grade', () => {
    assert.throws(() => calculateGrade({ correct: 5, total: 0 }));
    assert.throws(() => calculateGrade({ correct: 5, total: -10 }));
    assert.throws(() => calculateGrade({ correct: NaN, total: 10 }));
});

test('correct is clamped into [0, total] defensively (never produces a grade above 10 or a negative incorrect count)', () => {
    const over = calculateGrade({ correct: 999, total: 120 });
    assert.equal(over.correctCharacters, 120);
    assert.equal(over.grade, 10);

    const negative = calculateGrade({ correct: -5, total: 120 });
    assert.equal(negative.correctCharacters, 0);
    assert.equal(negative.grade, 4);
});
