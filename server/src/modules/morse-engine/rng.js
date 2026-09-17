/**
 * A tiny, deterministic PRNG (mulberry32) plus a string->seed hash, so
 * "same seed in => same output out" — needed for reproducible training
 * strings (e.g. re-generating the exact same test radiogram, or writing
 * a unit test that asserts an exact expected string).
 *
 * This is NOT cryptographically secure and must never be used for
 * anything security-related (passwords, tokens, etc.) — only for
 * generating practice text.
 */

/** Converts an arbitrary string into a 32-bit unsigned integer seed (djb2 hash). */
function hashStringToSeed(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 33) ^ str.charCodeAt(i);
    }
    return hash >>> 0;
}

/** mulberry32: fast, small, good-enough statistical quality for this use case. */
function mulberry32(seedInt) {
    let t = seedInt >>> 0;
    return function next() {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Creates a reproducible RNG function `() => number in [0, 1)`.
 * Accepts a numeric seed, a string seed (hashed to a number), or no
 * seed at all (a random one is generated from the current time so the
 * caller can still capture and reuse it later).
 *
 * @param {number|string} [seed]
 * @returns {{ next: () => number, seed: number }}
 */
function createRng(seed) {
    let seedInt;
    if (seed === undefined || seed === null) {
        seedInt = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    } else if (typeof seed === 'number') {
        seedInt = seed >>> 0;
    } else if (typeof seed === 'string') {
        seedInt = hashStringToSeed(seed);
    } else {
        throw new TypeError('seed must be a number, a string, or omitted.');
    }

    return { next: mulberry32(seedInt), seed: seedInt };
}

module.exports = { createRng, hashStringToSeed };
