/** Thrown by the Morse engine for invalid input in strict mode, bad
 * configuration (e.g. wpm <= 0), or an empty/unknown character pool. */
class MorseEngineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MorseEngineError';
    }
}

module.exports = { MorseEngineError };
