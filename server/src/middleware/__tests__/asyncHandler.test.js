const test = require('node:test');
const assert = require('node:assert/strict');
const asyncHandler = require('../asyncHandler');

test('asyncHandler: forwards a rejected promise to next(err) instead of leaving it unhandled', async () => {
    const boom = new Error('boom');
    const handler = asyncHandler(async () => {
        throw boom;
    });

    let forwarded = null;
    await handler({}, {}, (err) => {
        forwarded = err;
    });

    assert.equal(forwarded, boom);
});

test('asyncHandler: does not call next() at all when the wrapped function resolves normally', async () => {
    const handler = asyncHandler(async (req, res) => {
        res.sent = true;
    });

    let nextCalled = false;
    const res = {};
    await handler({}, res, () => {
        nextCalled = true;
    });

    assert.equal(res.sent, true);
    assert.equal(nextCalled, false);
});

test('asyncHandler: a synchronous throw inside the wrapped function is also forwarded', async () => {
    const boom = new Error('sync boom');
    const handler = asyncHandler(() => {
        throw boom;
    });

    let forwarded = null;
    await handler({}, {}, (err) => {
        forwarded = err;
    });

    assert.equal(forwarded, boom);
});
