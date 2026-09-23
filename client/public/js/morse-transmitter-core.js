/**
 * Morse Transmitter — the reusable "keyboard -> Morse" engine (Phase:
 * Morse Transmission). Deliberately does NOT reimplement dot/dash
 * classification or character decoding: it wraps the exact same
 * `MorseTimingDecoder`/`MorseCharacterDecoder` classes the (hidden)
 * Morse Receiver already uses for audio reception (see
 * morse-receiver-core.js) and only ever reads back what THEY decided.
 * What this module adds on top, which the receiver has no need for, is:
 *
 *   - per-element/per-gap QUALITY feedback ("Dot too long", "Character
 *     gap too short", "Irregular rhythm", ...), not just the binary
 *     dot/dash or boundary/no-boundary decision
 *   - raw timing statistics for the whole exercise (average dot/dash/gap
 *     durations, actual transmission WPM, rhythm consistency)
 *
 * Same dual browser-global / CommonJS export pattern as every other
 * client script under server/src/modules/*\/__tests__/ (see that
 * directory for precedent) — this file is `require()`d directly by
 * automated tests (and, for scoring, by the server itself when it
 * re-derives the transmitted text from a submitted raw element log —
 * never trusting a client-computed decoding, same as every other
 * exercise type in this app) with no duplicated copy of the logic.
 *
 * USAGE (real-time, from a keydown/keyup handler):
 *   const tx = new TransmissionEngine({ wpm: 15, toleranceFactor: 0.35,
 *     onFeedback: (f) => ..., onCharacterDecoded: (c) => ... });
 *   tx.keyDown(performance.now());   // Space pressed
 *   tx.keyUp(performance.now());     // Space released
 *   tx.flush();                      // exercise ended — finalize the last character
 *   tx.getStats();
 *
 * USAGE (deterministic, from tests or server-side re-scoring):
 *   tx.feedTone(90);   // a 90ms press
 *   tx.feedGap(300);   // a 300ms gap before the next press
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./morse-receiver-core'));
    } else {
        root.MorseTransmitterCore = factory(root.MorseReceiverCore);
    }
})(typeof window !== 'undefined' ? window : globalThis, function (MorseReceiverCore) {
    const { MorseTimingDecoder, MorseCharacterDecoder } = MorseReceiverCore;

    // Same standard 1/3/7-unit ratios as morse-receiver-core.js and the
    // server's morse-engine/timingService.js — the universal Morse
    // timing standard, not something specific to this module.
    const DOT_UNITS = 1;
    const DASH_UNITS = 3;
    const ELEMENT_GAP_UNITS = 1;
    const CHARACTER_GAP_UNITS = 3;
    const WORD_GAP_UNITS = 7;

    const DEFAULT_TOLERANCE_FACTOR = 0.35;
    const DEFAULT_RHYTHM_WINDOW = 6;
    const DEFAULT_RHYTHM_THRESHOLD = 0.3; // coefficient-of-variation cutoff for "Irregular rhythm"

    /** Classifies a measured `units` value against an `idealUnits` target with a symmetric ±toleranceFactor band. The one and only "is this good timing" judgment call in the module — every feedback message traces back to this. */
    function classifyAgainstIdeal(units, idealUnits, toleranceFactor) {
        const band = idealUnits * toleranceFactor;
        if (units < idealUnits - band) return 'too-short';
        if (units > idealUnits + band) return 'too-long';
        return 'correct';
    }

    function average(arr) {
        return arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;
    }

    function coefficientOfVariation(ratios) {
        if (ratios.length === 0) return 0;
        const mean = average(ratios);
        if (!mean) return 0;
        const variance = average(ratios.map((r) => (r - mean) ** 2));
        return Math.sqrt(variance) / mean;
    }

    function round1(v) {
        return v === null || v === undefined ? null : Math.round(v * 10) / 10;
    }

    const FEEDBACK_MESSAGES = {
        dot: { 'correct': 'Correct', 'too-short': 'Dot too short', 'too-long': 'Dot too long' },
        dash: { 'correct': 'Correct', 'too-short': 'Dash too short', 'too-long': 'Dash too long' },
        character: { 'correct': 'Correct', 'too-short': 'Character gap too short', 'too-long': 'Character gap too long' },
        word: { 'correct': 'Correct', 'too-short': 'Group/word gap too short', 'too-long': 'Group/word gap too long' },
    };

    /**
     * The transmission engine itself. Pure (no DOM/timers) except for the
     * optional keyDown/keyUp wall-clock convenience wrappers, which are
     * themselves trivial adapters onto feedTone/feedGap — every unit test
     * exercises feedTone/feedGap directly with exact millisecond values,
     * exactly like morseReceiverDecoding.test.js does for the receiver.
     */
    class TransmissionEngine {
        constructor({
            wpm = 15,
            toleranceFactor = DEFAULT_TOLERANCE_FACTOR,
            rhythmWindowSize = DEFAULT_RHYTHM_WINDOW,
            rhythmThreshold = DEFAULT_RHYTHM_THRESHOLD,
            onFeedback,
            onCharacterDecoded,
            onSequenceChange,
        } = {}) {
            this.wpm = wpm;
            this.toleranceFactor = toleranceFactor;
            this.rhythmWindowSize = rhythmWindowSize;
            this.rhythmThreshold = rhythmThreshold;

            this.onFeedback = onFeedback || (() => {});
            this.onCharacterDecoded = onCharacterDecoded || (() => {});
            this.onSequenceChange = onSequenceChange || (() => {});

            this.decodedText = '';
            this.currentMorse = '';
            this.elementLog = []; // raw log: {type:'tone'|'gap', durationMs} in transmission order — the "keep raw timing data" requirement
            this.dotDurations = [];
            this.dashDurations = [];
            this.elementGapDurations = [];
            this.characterGapDurations = [];
            this.wordGapDurations = [];
            this.feedbackCounts = {}; // tally by message, e.g. {"Correct": 12, "Dot too long": 2}
            this.verdictCounts = { correct: 0, 'too-short': 0, 'too-long': 0, irregular: 0 };

            this._rhythmRatios = [];
            this._pendingToneDurationMs = null;
            this._charBoundaryFired = false;
            this._wordBoundaryFired = false;
            this._pressStartAt = null;
            this._lastReleaseAt = null;

            this._characterDecoder = new MorseCharacterDecoder({
                onSequenceChange: (buf) => {
                    this.currentMorse = buf;
                    this.onSequenceChange(buf);
                },
                onCharacterDecoded: ({ char, morse }) => {
                    this.decodedText += char || '?';
                    this.onCharacterDecoded({ char, morse });
                },
            });
            this._timingDecoder = new MorseTimingDecoder({
                wpm,
                toleranceFactor,
                onSymbol: (symbol) => this._handleSymbol(symbol),
                onCharacterBoundary: () => {
                    this._charBoundaryFired = true;
                    this._characterDecoder.finalizeCharacter();
                },
                onWordBoundary: () => {
                    this._wordBoundaryFired = true;
                    this.decodedText += ' ';
                },
            });
        }

        get unitMs() {
            return 1200 / this.wpm;
        }

        setWpm(wpm) {
            if (!Number.isFinite(wpm) || wpm <= 0) return;
            this.wpm = wpm;
            this._timingDecoder.setWpm(wpm);
        }

        setToleranceFactor(toleranceFactor) {
            this.toleranceFactor = toleranceFactor;
            this._timingDecoder.setToleranceFactor(toleranceFactor);
        }

        // -----------------------------------------------------------------
        // Deterministic, duration-driven API — what tests (and the
        // server's authoritative re-scoring) call directly.
        // -----------------------------------------------------------------

        /** A completed key PRESS of this duration. Classified as a dot or dash by the wrapped MorseTimingDecoder — this module never makes that call itself, only grades the quality of whichever call was made. */
        feedTone(durationMs) {
            this.elementLog.push({ type: 'tone', durationMs });
            this._pendingToneDurationMs = durationMs;
            this._timingDecoder.feedTone(durationMs);
            this._pendingToneDurationMs = null;
        }

        /** A completed key RELEASE (gap) of this duration. */
        feedGap(durationMs) {
            this.elementLog.push({ type: 'gap', durationMs });
            this._charBoundaryFired = false;
            this._wordBoundaryFired = false;
            this._timingDecoder.feedSilence(durationMs);

            const units = durationMs / this.unitMs;
            let kind = 'element';
            let idealUnits = ELEMENT_GAP_UNITS;
            if (this._wordBoundaryFired) {
                kind = 'word';
                idealUnits = WORD_GAP_UNITS;
            } else if (this._charBoundaryFired) {
                kind = 'character';
                idealUnits = CHARACTER_GAP_UNITS;
            }

            const verdict = classifyAgainstIdeal(units, idealUnits, this.toleranceFactor);
            if (kind === 'word') this.wordGapDurations.push(durationMs);
            else if (kind === 'character') this.characterGapDurations.push(durationMs);
            else this.elementGapDurations.push(durationMs);

            // Only character/word gaps get their own feedback message —
            // intra-character element gaps are tracked for stats/rhythm
            // but aren't in the spec's feedback message list.
            if (kind !== 'element') {
                this._emitFeedback({ kind, verdict, durationMs, unitsRatio: units / idealUnits });
            }
        }

        /** Finalizes whatever's pending — call once when the exercise ends, so the last character is never silently lost. */
        flush() {
            this._charBoundaryFired = false;
            this._wordBoundaryFired = false;
            this._timingDecoder.flush();
        }

        // -----------------------------------------------------------------
        // Wall-clock convenience API — what the real Space-key UI calls.
        // -----------------------------------------------------------------

        /** Space pressed at this timestamp (any monotonic clock — performance.now() in the browser). Ignores key-repeat (a second keyDown before keyUp). */
        keyDown(nowMs) {
            if (this._pressStartAt !== null) return;
            if (this._lastReleaseAt !== null) {
                this.feedGap(nowMs - this._lastReleaseAt);
            }
            this._pressStartAt = nowMs;
        }

        /** Space released at this timestamp. No-ops if there was no matching keyDown. */
        keyUp(nowMs) {
            if (this._pressStartAt === null) return;
            const durationMs = nowMs - this._pressStartAt;
            this._pressStartAt = null;
            this._lastReleaseAt = nowMs;
            this.feedTone(durationMs);
        }

        // -----------------------------------------------------------------

        _handleSymbol(symbol) {
            const durationMs = this._pendingToneDurationMs;
            const kind = symbol === '.' ? 'dot' : 'dash';
            const idealUnits = symbol === '.' ? DOT_UNITS : DASH_UNITS;
            const units = durationMs / this.unitMs;
            const verdict = classifyAgainstIdeal(units, idealUnits, this.toleranceFactor);

            (kind === 'dot' ? this.dotDurations : this.dashDurations).push(durationMs);
            this._recordRhythmSample(units / idealUnits);
            this._emitFeedback({ kind, verdict, durationMs, unitsRatio: units / idealUnits });

            this._characterDecoder.addSymbol(symbol);
        }

        _recordRhythmSample(ratio) {
            this._rhythmRatios.push(ratio);
            if (this._rhythmRatios.length > this.rhythmWindowSize) this._rhythmRatios.shift();
            if (this._rhythmRatios.length < Math.min(4, this.rhythmWindowSize)) return;

            const cv = coefficientOfVariation(this._rhythmRatios);
            if (cv > this.rhythmThreshold) {
                this.verdictCounts.irregular += 1;
                const message = 'Irregular rhythm';
                this.feedbackCounts[message] = (this.feedbackCounts[message] || 0) + 1;
                // messageKey is a stable, English-independent identifier for
                // UI localization (see t('transmission.fb...') at display
                // call sites) — message itself stays the fixed English
                // string above since it's also used as the feedbackCounts
                // dictionary key and is covered by existing engine tests.
                this.onFeedback({ type: 'rhythm', kind: null, verdict: 'irregular', message, messageKey: 'rhythm.irregular' });
            }
        }

        _emitFeedback({ kind, verdict, durationMs, unitsRatio }) {
            const message = FEEDBACK_MESSAGES[kind][verdict];
            this.verdictCounts[verdict] = (this.verdictCounts[verdict] || 0) + 1;
            this.feedbackCounts[message] = (this.feedbackCounts[message] || 0) + 1;
            const type = kind === 'dot' || kind === 'dash' ? 'element' : 'gap';
            this.onFeedback({ type, kind, verdict, message, messageKey: `${kind}.${verdict}`, durationMs, unitsRatio });
        }

        /** Computed timing-analysis summary for the whole exercise so far — the "TIMING ANALYSIS" / "TRANSMISSION RESULTS" requirements. */
        getStats() {
            const avgDotMs = average(this.dotDurations);
            const avgDashMs = average(this.dashDurations);
            const avgElementGapMs = average(this.elementGapDurations);
            const avgCharacterGapMs = average(this.characterGapDurations);
            const avgWordGapMs = average(this.wordGapDurations);

            // Actual transmission speed, derived the same way the app
            // derives WPM from a dot length everywhere else (dotMs =
            // 1200/wpm, see morse-engine/timingService.js) — just solved
            // for wpm instead of dotMs. Falls back to dash/3 when the
            // student sent no dots at all (e.g. an all-dash sequence).
            let actualWpm = null;
            if (avgDotMs) actualWpm = 1200 / avgDotMs;
            else if (avgDashMs) actualWpm = 1200 / (avgDashMs / DASH_UNITS);

            const totalDurationMs = this.elementLog.reduce((sum, e) => sum + e.durationMs, 0);
            const ratios = [
                ...this.dotDurations.map((d) => d / this.unitMs / DOT_UNITS),
                ...this.dashDurations.map((d) => d / this.unitMs / DASH_UNITS),
            ];
            const rhythmConsistencyPercent = ratios.length
                ? Math.max(0, Math.min(100, Math.round((1 - coefficientOfVariation(ratios)) * 100)))
                : null;

            const totalFeedbackEvents = Object.values(this.verdictCounts).reduce((sum, v) => sum + v, 0);

            return {
                targetWpm: this.wpm,
                actualWpm: round1(actualWpm),
                avgDotMs: round1(avgDotMs),
                avgDashMs: round1(avgDashMs),
                avgElementGapMs: round1(avgElementGapMs),
                avgCharacterGapMs: round1(avgCharacterGapMs),
                avgWordGapMs: round1(avgWordGapMs),
                totalDurationMs: Math.round(totalDurationMs),
                dotCount: this.dotDurations.length,
                dashCount: this.dashDurations.length,
                elementCount: this.dotDurations.length + this.dashDurations.length,
                rhythmConsistencyPercent,
                timingErrorCount: totalFeedbackEvents - this.verdictCounts.correct,
                feedbackCounts: { ...this.feedbackCounts },
            };
        }

        reset() {
            this.decodedText = '';
            this.currentMorse = '';
            this.elementLog = [];
            this.dotDurations = [];
            this.dashDurations = [];
            this.elementGapDurations = [];
            this.characterGapDurations = [];
            this.wordGapDurations = [];
            this.feedbackCounts = {};
            this.verdictCounts = { correct: 0, 'too-short': 0, 'too-long': 0, irregular: 0 };
            this._rhythmRatios = [];
            this._pendingToneDurationMs = null;
            this._charBoundaryFired = false;
            this._wordBoundaryFired = false;
            this._pressStartAt = null;
            this._lastReleaseAt = null;
            this._characterDecoder.reset();
        }
    }

    /**
     * Stateless helper: replays a raw `elementLog` (exactly what
     * TransmissionEngine.elementLog accumulates, and what the client
     * submits at the end of an exercise) through a fresh engine and
     * returns the resulting decoded text + stats. This is what the
     * server calls to authoritatively re-derive the transmitted text
     * from raw timings — it never trusts a client-reported decodedText
     * string, same "recompute from the raw input" pattern every other
     * exercise type in this app already uses.
     */
    function analyzeElementLog(elementLog, { wpm, toleranceFactor } = {}) {
        const engine = new TransmissionEngine({ wpm, toleranceFactor });
        elementLog.forEach((entry) => {
            if (entry.type === 'tone') engine.feedTone(entry.durationMs);
            else if (entry.type === 'gap') engine.feedGap(entry.durationMs);
        });
        engine.flush();
        return { decodedText: engine.decodedText, stats: engine.getStats() };
    }

    return {
        TransmissionEngine,
        analyzeElementLog,
        classifyAgainstIdeal,
        DOT_UNITS,
        DASH_UNITS,
        ELEMENT_GAP_UNITS,
        CHARACTER_GAP_UNITS,
        WORD_GAP_UNITS,
    };
});
