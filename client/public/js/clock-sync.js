/**
 * Pure client/server clock-offset estimation — no DOM, no WebSocket, no
 * timers. Kept separate from group-session.js specifically so this
 * arithmetic can be unit-tested directly with `node --test`, the same
 * way the rest of this project's timing-sensitive logic is tested.
 *
 * The model: the server echoes back the client's own send timestamp
 * plus its own clock reading (a `pong` reply to a `ping`). Assuming the
 * outbound and return trip each take about half the round-trip time
 * (a reasonable approximation on a single-switch classroom LAN, not a
 * WAN), the server's clock at the moment the reply arrives is
 * approximately `serverTime + rtt/2`. The offset to add to this
 * client's own `Date.now()` to approximate the server's clock is then
 * `estimatedServerNow - clientReceivedAt`.
 *
 * A single sample is noisy (one slow tick, one GC pause), so the caller
 * takes a small burst of samples and reduces them with `medianOffset`
 * rather than trusting any single round trip.
 */
function estimateOffsetFromPong(clientSentAt, serverTime, clientReceivedAt) {
    const rttMs = clientReceivedAt - clientSentAt;
    const estimatedServerNowAtArrival = serverTime + rttMs / 2;
    return { offsetMs: estimatedServerNowAtArrival - clientReceivedAt, rttMs };
}

/** Median is more robust than a mean against one occasional slow/blocked sample. */
function medianOffset(samples) {
    if (!samples || samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const ClockSync = { estimateOffsetFromPong, medianOffset };

// Dual export: a plain global for the browser (no bundler/module system
// in this static client), a CommonJS export for this file's own Node
// unit tests. `module` is simply undefined in a browser, so this is a
// no-op there.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClockSync;
}
if (typeof window !== 'undefined') {
    window.ClockSync = ClockSync;
}
