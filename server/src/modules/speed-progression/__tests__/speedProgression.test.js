/**
 * Pure-logic test for the shared client-side speed-progression list
 * (client/public/js/speed-progression.js) — same "require the actual
 * production file the browser loads, no server-side source in this
 * module directory" pattern as morse-receiver/morse-transmitter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const CLIENT_JS_DIR = path.resolve(__dirname, '../../../../../client/public/js');
const { SPEED_PROGRESSION_WPM } = require(path.join(CLIENT_JS_DIR, 'speed-progression.js'));

test('SPEED_PROGRESSION_WPM: a non-empty, strictly increasing list of positive speeds', () => {
    assert.ok(SPEED_PROGRESSION_WPM.length > 0);
    for (let i = 1; i < SPEED_PROGRESSION_WPM.length; i += 1) {
        assert.ok(SPEED_PROGRESSION_WPM[i] > SPEED_PROGRESSION_WPM[i - 1], 'progression must strictly increase');
    }
    SPEED_PROGRESSION_WPM.forEach((wpm) => assert.ok(wpm > 0 && wpm <= 60));
});

test('SPEED_PROGRESSION_WPM: matches the documented default progression (10/12/14/16/18)', () => {
    assert.deepEqual(SPEED_PROGRESSION_WPM, [10, 12, 14, 16, 18]);
});
