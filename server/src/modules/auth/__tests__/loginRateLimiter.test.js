const test = require('node:test');
const assert = require('node:assert/strict');
const rateLimiter = require('../loginRateLimiter');

// Each test uses its own unique username so failure counts from one test
// never bleed into another via the module's shared in-memory Map.
let counter = 0;
function uniqueUsername() {
    counter += 1;
    return `rl-test-user-${counter}`;
}

test('isRateLimited: false for a username with no recorded failures', () => {
    assert.equal(rateLimiter.isRateLimited(uniqueUsername()), false);
});

test('recordFailure: does not rate-limit before reaching MAX_FAILED_ATTEMPTS', () => {
    const username = uniqueUsername();
    for (let i = 0; i < rateLimiter.MAX_FAILED_ATTEMPTS - 1; i += 1) {
        rateLimiter.recordFailure(username);
    }
    assert.equal(rateLimiter.isRateLimited(username), false);
});

test('recordFailure: rate-limits once MAX_FAILED_ATTEMPTS is reached', () => {
    const username = uniqueUsername();
    for (let i = 0; i < rateLimiter.MAX_FAILED_ATTEMPTS; i += 1) {
        rateLimiter.recordFailure(username);
    }
    assert.equal(rateLimiter.isRateLimited(username), true);
});

test('clearFailures: a successful login resets the counter', () => {
    const username = uniqueUsername();
    for (let i = 0; i < rateLimiter.MAX_FAILED_ATTEMPTS; i += 1) {
        rateLimiter.recordFailure(username);
    }
    assert.equal(rateLimiter.isRateLimited(username), true);

    rateLimiter.clearFailures(username);
    assert.equal(rateLimiter.isRateLimited(username), false);
});

test('username matching is case-insensitive (a login attempt cannot dodge the limit by changing case)', () => {
    const username = uniqueUsername();
    for (let i = 0; i < rateLimiter.MAX_FAILED_ATTEMPTS; i += 1) {
        rateLimiter.recordFailure(username.toUpperCase());
    }
    assert.equal(rateLimiter.isRateLimited(username.toLowerCase()), true);
});

test('each username is tracked independently — one account being limited does not affect another', () => {
    const a = uniqueUsername();
    const b = uniqueUsername();
    for (let i = 0; i < rateLimiter.MAX_FAILED_ATTEMPTS; i += 1) {
        rateLimiter.recordFailure(a);
    }
    assert.equal(rateLimiter.isRateLimited(a), true);
    assert.equal(rateLimiter.isRateLimited(b), false);
});
