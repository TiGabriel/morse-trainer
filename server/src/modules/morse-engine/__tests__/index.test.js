const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../index');

test('public API: exposes exactly the expected surface', () => {
    const expectedKeys = [
        'CHAR_TO_MORSE',
        'MORSE_TO_CHAR',
        'CHARSETS',
        'DIFFICULTY_PRESETS',
        'textToMorse',
        'morseToText',
        'isSupportedChar',
        'validateText',
        'validateMorse',
        'computeTiming',
        'computeSequenceDurationMs',
        'generateRandomText',
        'generateFromDifficulty',
        'findDifficultyPreset',
        'MorseEngineError',
    ];
    for (const key of expectedKeys) {
        assert.ok(key in engine, `expected engine to export "${key}"`);
    }
});

test('public API: a full round trip works through the top-level module only', () => {
    const { morse } = engine.textToMorse('CQ CQ DE TEST');
    const { text } = engine.morseToText(morse);
    assert.equal(text, 'CQ CQ DE TEST');

    const timing = engine.computeTiming({ wpm: 15, farnsworthWpm: 10 });
    const durationMs = engine.computeSequenceDurationMs(morse, timing);
    assert.ok(durationMs > 0);

    const generated = engine.generateFromDifficulty('easy', { seed: 'integration-test' });
    assert.ok(generated.text.length > 0);
    assert.equal(engine.validateText(generated.text).valid, true);
});
