/**
 * Morse Receiver — core processing pipeline, deliberately split into
 * small single-purpose classes rather than one monolithic component:
 *
 *   AudioSource        microphone -> AudioContext/AnalyserNode lifecycle
 *   SignalAnalyzer     raw analyser data -> band energy around a target Hz
 *   NoiseFloorEstimator adaptive "what counts as quiet right now"
 *   ToneDetector       energy + hysteresis/debounce -> TONE_ON/TONE_OFF events
 *   MorseTimingDecoder tone/silence durations -> dot/dash + gap classification
 *   MorseCharacterDecoder  accumulated symbols -> decoded character
 *   ReceiverState      wires all of the above together + explicit states
 *
 * MorseTimingDecoder, MorseCharacterDecoder, NoiseFloorEstimator, and
 * ToneDetector.processSample are pure (no DOM/AudioContext/timers), so
 * they're exercised directly by the automated tests under
 * server/src/modules/morse-receiver/__tests__/ via require() — this is
 * the "deterministic audio testing" path: durations/energy readings go
 * straight in, no microphone involved. AudioSource is the only piece
 * that's real-microphone-only and isn't unit tested (nothing to fake
 * honestly without pretending to be a microphone, which the task
 * explicitly forbids).
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./morse-receiver-map').MORSE_TO_CHAR);
    } else {
        root.MorseReceiverCore = factory(root.MorseReceiverMap.MORSE_TO_CHAR);
    }
})(typeof window !== 'undefined' ? window : globalThis, function (MORSE_TO_CHAR) {
    // =====================================================================
    // Timing model — same standard ratios/formula as the server's
    // morse-engine/timingService.js (dotMs = 1200 / wpm; dash = 3 units;
    // intra-char gap = 1 unit; inter-char gap = 3 units; inter-word gap =
    // 7 units). Never hardcode milliseconds — always derive from WPM.
    // =====================================================================
    const DOT_UNITS = 1;
    const DASH_UNITS = 3;
    // Receiver-side classification boundaries: the midpoints between the
    // standard element lengths above (1<->3 => 2, 3<->7 => 5). Real hand
    // keying is never perfectly on-ratio, so `toleranceFactor` widens (or
    // narrows) how forgiving these boundaries are instead of moving the
    // underlying 1/3/7 unit standard itself.
    const TONE_BOUNDARY_UNITS = (DOT_UNITS + DASH_UNITS) / 2; // 2
    const GAP_ELEMENT_CHAR_BOUNDARY_UNITS = 2;
    const GAP_CHAR_WORD_BOUNDARY_UNITS = 5;

    /**
     * Pure timing classifier: fed tone/silence DURATIONS (ms) and emits
     * '.'/'-' symbols plus character/word boundary events. Knows nothing
     * about the Morse alphabet itself — see MorseCharacterDecoder for that.
     */
    class MorseTimingDecoder {
        constructor({ wpm = 15, toleranceFactor = 0.35, onSymbol, onCharacterBoundary, onWordBoundary } = {}) {
            this.onSymbol = onSymbol || (() => {});
            this.onCharacterBoundary = onCharacterBoundary || (() => {});
            this.onWordBoundary = onWordBoundary || (() => {});
            this.setToleranceFactor(toleranceFactor);
            this.setWpm(wpm);
        }

        /** Recomputes the base unit length (ms) for a new WPM — manual WPM is authoritative; nothing here estimates it on its own. */
        setWpm(wpm) {
            if (!Number.isFinite(wpm) || wpm <= 0) return;
            this.wpm = wpm;
            this.unitMs = 1200 / wpm;
        }

        setToleranceFactor(toleranceFactor) {
            this.toleranceFactor = Number.isFinite(toleranceFactor) ? Math.max(0, toleranceFactor) : 0.35;
        }

        /** A completed TONE (carrier present) of this duration was just measured. */
        feedTone(durationMs) {
            const units = durationMs / this.unitMs;
            const boundary = TONE_BOUNDARY_UNITS * (1 + this.toleranceFactor);
            this.onSymbol(units <= boundary ? '.' : '-');
        }

        /** A completed SILENCE (carrier absent) of this duration was just measured. Only fires boundary events for silences long enough to actually mean something (a short intra-character gap is otherwise ignored). */
        feedSilence(durationMs) {
            const units = durationMs / this.unitMs;
            const elementCharBoundary = GAP_ELEMENT_CHAR_BOUNDARY_UNITS * (1 + this.toleranceFactor);
            const charWordBoundary = GAP_CHAR_WORD_BOUNDARY_UNITS * (1 + this.toleranceFactor);
            if (units <= elementCharBoundary) return; // still inside the same character
            this.onCharacterBoundary();
            if (units > charWordBoundary) this.onWordBoundary();
        }

        /** Forces whatever's pending to finalize — call when reception stops, so the final character is never silently lost. */
        flush() {
            this.onCharacterBoundary();
        }
    }

    /**
     * Pure character accumulator/decoder: collects '.'/'-' symbols for the
     * character currently being received and resolves them against the
     * canonical Morse table on a character boundary. An unrecognized
     * sequence decodes to `null` (rendered as e.g. "?" by the UI) rather
     * than throwing — noisy/malformed reception must never crash the
     * receiver.
     */
    class MorseCharacterDecoder {
        constructor({ onSequenceChange, onCharacterDecoded } = {}) {
            this.onSequenceChange = onSequenceChange || (() => {});
            this.onCharacterDecoded = onCharacterDecoded || (() => {});
            this.buffer = '';
        }

        addSymbol(symbol) {
            this.buffer += symbol;
            this.onSequenceChange(this.buffer);
        }

        /** Resolves and clears the current buffer. No-ops (never emits an empty/garbage character) if nothing was accumulated. */
        finalizeCharacter() {
            if (!this.buffer) return null;
            const morse = this.buffer;
            const char = Object.prototype.hasOwnProperty.call(MORSE_TO_CHAR, morse) ? MORSE_TO_CHAR[morse] : null;
            this.buffer = '';
            this.onSequenceChange(this.buffer);
            this.onCharacterDecoded({ morse, char });
            return char;
        }

        reset() {
            this.buffer = '';
            this.onSequenceChange(this.buffer);
        }
    }

    // =====================================================================
    // Signal analysis — turns raw analyser frequency data into a single
    // "how much energy is around our target tone right now" number, plus
    // an adaptive estimate of the surrounding noise floor.
    // =====================================================================

    /** Sums linear power (converted from the analyser's dB-scale bins) across a small window of FFT bins centered on targetFrequencyHz, then reports it back in dB — proper energy summation, not just an average of dB values. */
    function getBandEnergyDb(analyser, freqDataDb, targetFrequencyHz, sampleRate, binSpread = 2) {
        const binHz = sampleRate / analyser.fftSize;
        const centerBin = Math.round(targetFrequencyHz / binHz);
        let powerSum = 0;
        let count = 0;
        for (let i = centerBin - binSpread; i <= centerBin + binSpread; i += 1) {
            if (i < 0 || i >= freqDataDb.length) continue;
            powerSum += 10 ** (freqDataDb[i] / 10);
            count += 1;
        }
        if (count === 0) return -Infinity;
        return 10 * Math.log10(powerSum / count);
    }

    /** Rolling "typical quiet level" — a low percentile of recent energy readings, so a few loud tone samples don't drag the floor up with them. Pure/testable: just feed it numbers. */
    class NoiseFloorEstimator {
        constructor({ windowSize = 90, percentile = 0.2 } = {}) {
            this.windowSize = windowSize;
            this.percentile = percentile;
            this.samples = [];
        }

        addSample(value) {
            this.samples.push(value);
            if (this.samples.length > this.windowSize) this.samples.shift();
        }

        estimate() {
            if (this.samples.length === 0) return -Infinity;
            const sorted = [...this.samples].sort((a, b) => a - b);
            const idx = Math.min(sorted.length - 1, Math.floor(this.percentile * sorted.length));
            return sorted[idx];
        }

        reset() {
            this.samples = [];
        }
    }

    /**
     * Hysteresis + debounce on top of a stream of energy-in-dB readings —
     * this, not raw microphone volume, is what actually decides
     * TONE_ON/TONE_OFF. Two thresholds (on/off) prevent a signal
     * hovering near one cutoff from chattering; a minimum dwell time
     * (`minTransitionMs`) additionally swallows clicks/pops shorter than
     * any real Morse element could be.
     *
     * `processSample` takes a bare energy number + timestamp and is pure
     * (no AudioContext/DOM), so the hysteresis/debounce logic itself is
     * unit-testable independent of a real microphone.
     */
    class ToneDetector {
        constructor({ sensitivityDb = 12, minTransitionMs = 20, onToneOn, onToneOff } = {}) {
            this.sensitivityDb = sensitivityDb;
            this.minTransitionMs = minTransitionMs;
            this.onToneOn = onToneOn || (() => {});
            this.onToneOff = onToneOff || (() => {});
            this.noiseFloor = new NoiseFloorEstimator();
            this.toneActive = false;
            this.lastTransitionAtMs = null;
            this.currentEnergyDb = -Infinity;
            this.currentThresholdDb = -Infinity;
        }

        setSensitivityDb(sensitivityDb) {
            if (Number.isFinite(sensitivityDb)) this.sensitivityDb = sensitivityDb;
        }

        /** Feed one energy reading. Only samples taken while the tone is currently OFF are folded into the noise-floor estimate, so the tone itself never inflates what counts as "quiet". */
        processSample(energyDb, nowMs) {
            if (!this.toneActive) this.noiseFloor.addSample(energyDb);
            const floor = this.noiseFloor.estimate();
            const onThreshold = floor + this.sensitivityDb;
            const offThreshold = floor + this.sensitivityDb * 0.5; // wider hysteresis gap below the ON threshold
            this.currentEnergyDb = energyDb;
            this.currentThresholdDb = onThreshold;

            const wantOn = energyDb >= onThreshold;
            const wantOff = energyDb < offThreshold;

            if (this.lastTransitionAtMs !== null && nowMs - this.lastTransitionAtMs < this.minTransitionMs) {
                return; // too soon after the last transition — likely a click, not a real element
            }

            if (!this.toneActive && wantOn) {
                this.toneActive = true;
                this.lastTransitionAtMs = nowMs;
                this.onToneOn(nowMs);
            } else if (this.toneActive && wantOff) {
                this.toneActive = false;
                this.lastTransitionAtMs = nowMs;
                this.onToneOff(nowMs);
            }
        }

        reset() {
            this.noiseFloor.reset();
            this.toneActive = false;
            this.lastTransitionAtMs = null;
            this.currentEnergyDb = -Infinity;
            this.currentThresholdDb = -Infinity;
        }
    }

    // =====================================================================
    // Microphone / AudioContext lifecycle. The only piece that touches
    // real browser APIs directly other than the rAF polling loop in
    // ReceiverState — kept separate so everything else never has to know
    // whether it's being driven by a real mic or a test.
    // =====================================================================
    class AudioSource {
        constructor() {
            this.audioContext = null;
            this.stream = null;
            this.analyser = null;
        }

        get sampleRate() {
            return this.audioContext ? this.audioContext.sampleRate : null;
        }

        /** Resolves once the mic is live and an AnalyserNode is wired up; rejects with a short, user-facing message (never a raw browser error) on any failure. */
        async start({ fftSize = 2048 } = {}) {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('This browser does not support microphone access.');
            }
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) {
                throw new Error('This browser does not support the Web Audio API.');
            }

            try {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                });
            } catch (err) {
                this.stream = null;
                if (err && err.name === 'NotAllowedError') throw new Error('Microphone permission was denied.');
                if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) throw new Error('No microphone was found on this device.');
                if (err && err.name === 'NotReadableError') throw new Error('The microphone is unavailable (in use by another application?).');
                throw new Error('Could not access the microphone.');
            }

            try {
                this.audioContext = new Ctx();
                if (this.audioContext.state === 'suspended') await this.audioContext.resume();
                const sourceNode = this.audioContext.createMediaStreamSource(this.stream);
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = fftSize;
                this.analyser.smoothingTimeConstant = 0; // we do our own smoothing (noise floor + hysteresis)
                sourceNode.connect(this.analyser);
            } catch {
                this.stop();
                throw new Error('Could not start audio processing for the microphone.');
            }
        }

        /** Stops every track and closes the AudioContext — nothing keeps running, nothing keeps listening, once this returns. */
        stop() {
            if (this.stream) {
                this.stream.getTracks().forEach((track) => track.stop());
                this.stream = null;
            }
            if (this.audioContext) {
                this.audioContext.close().catch(() => {});
                this.audioContext = null;
            }
            this.analyser = null;
        }
    }

    // =====================================================================
    // Receiver state machine + wiring. UI reads a throttled snapshot via
    // subscribe() rather than being poked on every audio sample/rAF tick.
    // =====================================================================
    const STATES = {
        IDLE: 'IDLE',
        REQUESTING_PERMISSION: 'REQUESTING_PERMISSION',
        LISTENING: 'LISTENING',
        TONE_ACTIVE: 'TONE_ACTIVE',
        STOPPING: 'STOPPING',
        ERROR: 'ERROR',
    };

    class ReceiverState {
        constructor({ wpm = 15, toneFrequencyHz = 600, sensitivityDb = 12, toleranceFactor = 0.35 } = {}) {
            this.wpm = wpm;
            this.toneFrequencyHz = toneFrequencyHz;
            this.state = STATES.IDLE;
            this.errorMessage = null;
            this.decodedText = '';
            this.currentMorse = '';

            this._listeners = new Set();
            this._audioSource = new AudioSource();
            this._toneDetector = new ToneDetector({
                sensitivityDb,
                onToneOn: (atMs) => this._handleToneOn(atMs),
                onToneOff: (atMs) => this._handleToneOff(atMs),
            });
            this._timingDecoder = new MorseTimingDecoder({
                wpm,
                toleranceFactor,
                onSymbol: (symbol) => this._characterDecoder.addSymbol(symbol),
                onCharacterBoundary: () => this._characterDecoder.finalizeCharacter(),
                onWordBoundary: () => this._appendToDecodedText(' '),
            });
            this._characterDecoder = new MorseCharacterDecoder({
                onSequenceChange: (buffer) => {
                    this.currentMorse = buffer;
                },
                // An unrecognized symbol sequence (noise, a mis-timed
                // element, etc.) must never crash the receiver or get
                // silently dropped — it shows up as a plain "?" so the
                // teacher can see reception was noisy right there in the
                // decoded text, same idea as the rest of the app never
                // hiding a real error behind fabricated success.
                onCharacterDecoded: ({ char }) => {
                    this._appendToDecodedText(char || '?');
                },
            });
            this._lastToneOnAt = null;
            this._lastToneOffAt = null;
            this._rafId = null;
            this._freqData = null;
        }

        subscribe(listener) {
            this._listeners.add(listener);
            return () => this._listeners.delete(listener);
        }

        _emit() {
            const snapshot = {
                state: this.state,
                errorMessage: this.errorMessage,
                decodedText: this.decodedText,
                currentMorse: this.currentMorse,
                wpm: this.wpm,
                toneFrequencyHz: this.toneFrequencyHz,
                sensitivityDb: this._toneDetector.sensitivityDb,
                toleranceFactor: this._timingDecoder.toleranceFactor,
                signal: {
                    toneActive: this._toneDetector.toneActive,
                    energyDb: this._toneDetector.currentEnergyDb,
                    thresholdDb: this._toneDetector.currentThresholdDb,
                },
            };
            this._listeners.forEach((fn) => fn(snapshot));
        }

        _setState(state, errorMessage = null) {
            this.state = state;
            this.errorMessage = errorMessage;
            this._emit();
        }

        _appendToDecodedText(text) {
            this.decodedText += text;
            this._emit();
        }

        _handleToneOn(atMs) {
            if (this._lastToneOffAt !== null) {
                this._timingDecoder.feedSilence(atMs - this._lastToneOffAt);
            }
            this._lastToneOnAt = atMs;
            if (this.state === STATES.LISTENING) this._setState(STATES.TONE_ACTIVE);
            else this._emit();
        }

        _handleToneOff(atMs) {
            if (this._lastToneOnAt !== null) {
                this._timingDecoder.feedTone(atMs - this._lastToneOnAt);
            }
            this._lastToneOffAt = atMs;
            if (this.state === STATES.TONE_ACTIVE) this._setState(STATES.LISTENING);
            else this._emit();
        }

        setWpm(wpm) {
            this.wpm = wpm;
            this._timingDecoder.setWpm(wpm);
            this._emit();
        }

        setToneFrequencyHz(hz) {
            if (Number.isFinite(hz) && hz > 0) this.toneFrequencyHz = hz;
            this._emit();
        }

        setSensitivityDb(db) {
            this._toneDetector.setSensitivityDb(db);
            this._emit();
        }

        setToleranceFactor(factor) {
            this._timingDecoder.setToleranceFactor(factor);
            this._emit();
        }

        async start() {
            if (this.state === STATES.LISTENING || this.state === STATES.TONE_ACTIVE || this.state === STATES.REQUESTING_PERMISSION) return;
            this._setState(STATES.REQUESTING_PERMISSION);
            try {
                await this._audioSource.start();
            } catch (err) {
                this._setState(STATES.ERROR, err.message);
                return;
            }
            this._freqData = new Float32Array(this._audioSource.analyser.frequencyBinCount);
            this._toneDetector.reset();
            this._lastToneOnAt = null;
            this._lastToneOffAt = null;
            this._setState(STATES.LISTENING);
            this._loop();
        }

        _loop() {
            if (this.state !== STATES.LISTENING && this.state !== STATES.TONE_ACTIVE) return;
            const analyser = this._audioSource.analyser;
            if (!analyser) return;
            analyser.getFloatFrequencyData(this._freqData);
            const energyDb = getBandEnergyDb(analyser, this._freqData, this.toneFrequencyHz, this._audioSource.sampleRate);
            this._toneDetector.processSample(energyDb, performance.now());
            this._emit();
            this._rafId = requestAnimationFrame(() => this._loop());
        }

        stop() {
            if (this.state === STATES.IDLE) return;
            this._setState(STATES.STOPPING);
            if (this._rafId !== null) {
                cancelAnimationFrame(this._rafId);
                this._rafId = null;
            }
            // A trailing tone that never got a chance to end shouldn't
            // silently disappear — finalize it against "now" first.
            if (this._toneDetector.toneActive && this._lastToneOnAt !== null) {
                this._timingDecoder.feedTone(performance.now() - this._lastToneOnAt);
            }
            this._timingDecoder.flush();
            this._audioSource.stop();
            this._setState(STATES.IDLE);
        }

        clear() {
            this.decodedText = '';
            this.currentMorse = '';
            this._characterDecoder.reset();
            this._toneDetector.reset();
            this._lastToneOnAt = null;
            this._lastToneOffAt = null;
            this._emit();
        }
    }

    return {
        STATES,
        MorseTimingDecoder,
        MorseCharacterDecoder,
        NoiseFloorEstimator,
        ToneDetector,
        AudioSource,
        ReceiverState,
        getBandEnergyDb,
    };
});
