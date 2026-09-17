/**
 * Compares a submitted answer against the expected answer and classifies
 * every character into exactly one of four categories, using a proper
 * sequence alignment (Levenshtein edit-distance with backtrace) rather
 * than naive positional (index-by-index) comparison.
 *
 * Why alignment instead of index-by-index: if a student drops one
 * character partway through a 20-character copy, positional comparison
 * would falsely mark every character after that point as "wrong" even
 * though they copied the rest correctly. Alignment finds the actual
 * best correspondence between the two strings first, so a single missed
 * character is counted once (as "missing"), not as a cascade of
 * "incorrect" characters.
 *
 *   correct   — a character in the submitted answer matches the
 *               corresponding character in the expected answer.
 *   incorrect — a character was submitted in the right position (per
 *               the alignment) but doesn't match (a substitution).
 *   missing   — a character exists in the expected answer but the
 *               student never entered anything for it (a deletion).
 *   extra     — a character exists in the submitted answer that has no
 *               counterpart in the expected answer (an insertion).
 */
const { MorseEngineError } = require('./errors');

/**
 * @param {string} expected - the correct answer.
 * @param {string} submitted - what the student typed.
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {{
 *   ops: Array<{type: 'match'|'substitution'|'missing'|'extra', expectedChar?: string, submittedChar?: string, expectedIndex?: number, submittedIndex?: number}>,
 *   correctCount: number, incorrectCount: number, missingCount: number, extraCount: number,
 *   errorCount: number, accuracyPercent: number, totalExpected: number, totalSubmitted: number,
 * }}
 */
function scoreAnswer(expected, submitted, options = {}) {
    if (typeof expected !== 'string' || typeof submitted !== 'string') {
        throw new TypeError('scoreAnswer expects expected and submitted to both be strings.');
    }
    if (expected.length > 2000 || submitted.length > 2000) {
        // Guards the O(n*m) DP table below from unbounded growth on abuse.
        throw new MorseEngineError('scoreAnswer inputs must be 2000 characters or fewer.');
    }

    const caseSensitive = options.caseSensitive ?? false;
    const a = caseSensitive ? expected : expected.toUpperCase();
    const b = caseSensitive ? submitted : submitted.toUpperCase();
    const n = a.length;
    const m = b.length;

    // dp[i][j] = edit distance between a[0..i) and b[0..j)
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 0; i <= n; i += 1) dp[i][0] = i;
    for (let j = 0; j <= m; j += 1) dp[0][j] = j;
    for (let i = 1; i <= n; i += 1) {
        for (let j = 1; j <= m; j += 1) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    // Backtrack from (n, m) to (0, 0) to recover the actual alignment.
    const ops = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
            ops.push({ type: 'match', expectedChar: a[i - 1], submittedChar: b[j - 1], expectedIndex: i - 1, submittedIndex: j - 1 });
            i -= 1;
            j -= 1;
        } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
            ops.push({ type: 'substitution', expectedChar: a[i - 1], submittedChar: b[j - 1], expectedIndex: i - 1, submittedIndex: j - 1 });
            i -= 1;
            j -= 1;
        } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
            ops.push({ type: 'missing', expectedChar: a[i - 1], expectedIndex: i - 1 });
            i -= 1;
        } else {
            ops.push({ type: 'extra', submittedChar: b[j - 1], submittedIndex: j - 1 });
            j -= 1;
        }
    }
    ops.reverse();

    const correctCount = ops.filter((o) => o.type === 'match').length;
    const incorrectCount = ops.filter((o) => o.type === 'substitution').length;
    const missingCount = ops.filter((o) => o.type === 'missing').length;
    const extraCount = ops.filter((o) => o.type === 'extra').length;

    const totalExpected = a.length;
    // Accuracy is relative to the length of the correct answer — a
    // conventional, easy-to-explain definition: "what fraction of the
    // characters you needed to get right did you get right."
    const accuracyPercent = totalExpected === 0 ? (b.length === 0 ? 100 : 0) : (correctCount / totalExpected) * 100;

    return {
        ops,
        correctCount,
        incorrectCount,
        missingCount,
        extraCount,
        errorCount: incorrectCount + missingCount + extraCount,
        accuracyPercent: Math.round(accuracyPercent * 100) / 100,
        totalExpected,
        totalSubmitted: b.length,
    };
}

module.exports = { scoreAnswer };
