const test = require('node:test');
const assert = require('node:assert/strict');
const { createRng, hashStringToSeed } = require('../rng');

test('createRng: same numeric seed produces the same sequence', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    assert.deepEqual(seqA, seqB);
});

test('createRng: same string seed produces the same sequence', () => {
    const a = createRng('hello-seed');
    const b = createRng('hello-seed');
    assert.equal(a.next(), b.next());
});

test('createRng: different seeds produce different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    assert.notEqual(a.next(), b.next());
});

test('createRng: next() always returns a value in [0, 1)', () => {
    const rng = createRng('range-check');
    for (let i = 0; i < 1000; i += 1) {
        const v = rng.next();
        assert.ok(v >= 0 && v < 1);
    }
});

test('createRng: omitting a seed still returns a usable, reproducible seed value', () => {
    const a = createRng();
    assert.equal(typeof a.seed, 'number');
    // Re-seeding with the captured seed reproduces the sequence:
    const c = createRng(a.seed);
    const d = createRng(a.seed);
    assert.equal(c.next(), d.next());
});

test('hashStringToSeed: deterministic for the same string', () => {
    assert.equal(hashStringToSeed('abc'), hashStringToSeed('abc'));
});

test('hashStringToSeed: different strings usually hash differently', () => {
    assert.notEqual(hashStringToSeed('abc'), hashStringToSeed('abd'));
});
