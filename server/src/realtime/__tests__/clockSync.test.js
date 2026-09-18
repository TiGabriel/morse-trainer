/**
 * Tests the REAL client-side clock-offset math, not a copy of it — the
 * file under test (`client/public/js/clock-sync.js`) is dual-exported
 * (plain `window` global for the browser, CommonJS for this test) so
 * there is exactly one implementation, not two that could drift apart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateOffsetFromPong, medianOffset } = require('../../../../client/public/js/clock-sync');

test('estimateOffsetFromPong: zero-latency round trip with a synced clock yields ~0 offset', () => {
    const clientSentAt = 1000;
    const serverTime = 1000; // server's clock reads the same instant
    const clientReceivedAt = 1000; // instantaneous round trip
    const { offsetMs, rttMs } = estimateOffsetFromPong(clientSentAt, serverTime, clientReceivedAt);
    assert.equal(rttMs, 0);
    assert.equal(offsetMs, 0);
});

test('estimateOffsetFromPong: detects a client clock that is ahead of the server', () => {
    // Client's clock reads 1000 when it sends; by the time the reply
    // arrives 20ms later (client clock), the server's clock only read
    // 990 when it handled the request instantaneously (server is "behind").
    const { offsetMs } = estimateOffsetFromPong(1000, 990, 1020);
    // rtt = 20, estimatedServerNowAtArrival = 990 + 10 = 1000, offset = 1000 - 1020 = -20
    assert.equal(offsetMs, -20);
});

test('estimateOffsetFromPong: detects a client clock that is behind the server', () => {
    const { offsetMs } = estimateOffsetFromPong(1000, 1050, 1020);
    // rtt = 20, estimatedServerNowAtArrival = 1050 + 10 = 1060, offset = 1060 - 1020 = 40
    assert.equal(offsetMs, 40);
});

test('estimateOffsetFromPong: pure round-trip latency alone (synced clocks) contributes zero offset', () => {
    // Clocks are perfectly synced; the only delay is a slow 100ms round trip.
    // clientSentAt=0, serverTime=50 (server clock read halfway through the trip), clientReceivedAt=100.
    const { offsetMs, rttMs } = estimateOffsetFromPong(0, 50, 100);
    assert.equal(rttMs, 100);
    assert.equal(offsetMs, 0);
});

test('medianOffset: empty input is treated as zero offset', () => {
    assert.equal(medianOffset([]), 0);
    assert.equal(medianOffset(undefined), 0);
});

test('medianOffset: odd sample count picks the middle value', () => {
    assert.equal(medianOffset([5, 1, 3]), 3);
});

test('medianOffset: even sample count averages the two middle values', () => {
    assert.equal(medianOffset([10, 20, 30, 40]), 25);
});

test('medianOffset: is robust to a single outlier sample (unlike a mean would be)', () => {
    // One wildly slow/blocked sample (e.g. main thread jank) must not drag
    // the estimate far from the cluster of consistent samples.
    const samples = [10, 11, 9, 10, 500];
    const median = medianOffset(samples);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    assert.equal(median, 10);
    assert.ok(mean > 100, 'sanity check: the mean really is dragged far by the outlier');
    assert.ok(Math.abs(median - 10) < Math.abs(mean - 10), 'median should stay much closer to the true cluster than the mean');
});

test('medianOffset: order of samples does not matter', () => {
    assert.equal(medianOffset([3, 1, 2]), medianOffset([1, 2, 3]));
    assert.equal(medianOffset([3, 1, 2]), medianOffset([2, 3, 1]));
});
