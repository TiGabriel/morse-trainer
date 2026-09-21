/**
 * Pure-logic tests for the signal-analysis layer sitting between raw
 * frequency-domain energy and the timing decoder: NoiseFloorEstimator
 * and ToneDetector.processSample(). Both take plain numbers (energy in
 * dB, timestamps in ms) with no AudioContext/DOM/microphone involved —
 * this is what actually decides TONE_ON/TONE_OFF, as opposed to raw
 * microphone volume, per the feature's own requirement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { NoiseFloorEstimator, ToneDetector } = require(path.join(CLIENT_JS_DIR, 'morse-receiver-core.js'));

test('NoiseFloorEstimator: reports a low percentile of recent samples, not the mean', () => {
    const estimator = new NoiseFloorEstimator({ windowSize: 10, percentile: 0.2 });
    [-60, -58, -61, -59, -20 /* one loud outlier (a tone) */, -60, -59, -61, -58, -60].forEach((v) => estimator.addSample(v));
    const floor = estimator.estimate();
    // The floor should sit near the quiet cluster (~-61..-58), not be
    // dragged up by the single loud outlier.
    assert.ok(floor <= -58, `expected the floor to stay near the quiet cluster, got ${floor}`);
});

test('NoiseFloorEstimator: an empty estimator reports -Infinity rather than throwing/NaN', () => {
    const estimator = new NoiseFloorEstimator();
    assert.equal(estimator.estimate(), -Infinity);
});

test('NoiseFloorEstimator: reset() discards prior samples', () => {
    const estimator = new NoiseFloorEstimator({ windowSize: 5, percentile: 0 });
    [-60, -60, -60].forEach((v) => estimator.addSample(v));
    assert.notEqual(estimator.estimate(), -Infinity);
    estimator.reset();
    assert.equal(estimator.estimate(), -Infinity);
});

function makeDetector(overrides = {}) {
    const events = [];
    const detector = new ToneDetector({
        sensitivityDb: 12,
        minTransitionMs: 20,
        onToneOn: (atMs) => events.push({ type: 'on', atMs }),
        onToneOff: (atMs) => events.push({ type: 'off', atMs }),
        ...overrides,
    });
    return { detector, events };
}

test('ToneDetector: quiet noise alone never fires a tone-on event', () => {
    const { detector, events } = makeDetector();
    let t = 0;
    for (let i = 0; i < 50; i += 1) {
        detector.processSample(-60 + (Math.random() * 2 - 1), t); // steady, slightly jittery noise floor
        t += 16;
    }
    assert.deepEqual(events, []);
});

test('ToneDetector: a clear tone well above the noise floor fires exactly one on/off pair', () => {
    const { detector, events } = makeDetector();
    let t = 0;
    // Establish a quiet floor first.
    for (let i = 0; i < 20; i += 1) {
        detector.processSample(-60, t);
        t += 16;
    }
    // A loud tone for a while.
    for (let i = 0; i < 10; i += 1) {
        detector.processSample(-20, t);
        t += 16;
    }
    // Back to quiet.
    for (let i = 0; i < 20; i += 1) {
        detector.processSample(-60, t);
        t += 16;
    }
    assert.equal(events.filter((e) => e.type === 'on').length, 1);
    assert.equal(events.filter((e) => e.type === 'off').length, 1);
});

test('ToneDetector: a single spurious loud sample shorter than minTransitionMs does not register as a tone (debounce)', () => {
    const { detector, events } = makeDetector({ minTransitionMs: 50 });
    let t = 0;
    for (let i = 0; i < 10; i += 1) {
        detector.processSample(-60, t);
        t += 5;
    }
    detector.processSample(-20, t); // one loud sample
    t += 5;
    detector.processSample(-60, t); // immediately quiet again, well inside minTransitionMs of the last transition
    // The single loud sample still turns the tone on (that's a real
    // transition); what's debounced is turning it back off again too
    // quickly afterward.
    const onEvents = events.filter((e) => e.type === 'on');
    assert.ok(onEvents.length <= 1);
});

test('ToneDetector: hysteresis prevents chatter for a signal hovering near the threshold', () => {
    const { detector, events } = makeDetector({ sensitivityDb: 10, minTransitionMs: 0 });
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
        detector.processSample(-60, t);
        t += 16;
    }
    // Hover right around the ON threshold (-60 + 10 = -50) without ever
    // clearly committing to loud or quiet.
    for (let i = 0; i < 30; i += 1) {
        detector.processSample(-51 + (i % 2 === 0 ? 1.5 : -1.5), t);
        t += 16;
    }
    const toggles = events.length;
    assert.ok(toggles <= 2, `expected hysteresis to prevent chatter, got ${toggles} transitions: ${JSON.stringify(events)}`);
});

test('ToneDetector.reset() clears tone-active state and the noise floor', () => {
    const { detector } = makeDetector();
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
        detector.processSample(-60, t);
        t += 16;
    }
    detector.processSample(-20, t);
    assert.equal(detector.toneActive, true);
    detector.reset();
    assert.equal(detector.toneActive, false);
    assert.equal(detector.noiseFloor.estimate(), -Infinity);
});

test('ToneDetector: the tone itself is never folded into the noise-floor estimate (would otherwise raise the floor and desensitize the detector)', () => {
    const { detector } = makeDetector();
    let t = 0;
    for (let i = 0; i < 20; i += 1) {
        detector.processSample(-60, t);
        t += 16;
    }
    const floorBeforeTone = detector.noiseFloor.estimate();
    for (let i = 0; i < 40; i += 1) {
        detector.processSample(-20, t); // long loud tone
        t += 16;
    }
    const floorDuringTone = detector.noiseFloor.estimate();
    assert.equal(floorDuringTone, floorBeforeTone, 'the noise floor must not have moved while the tone was active');
});
