/**
 * MorseAudioPlayer — a reusable, offline Morse-code audio player built on
 * the Web Audio API. No audio files, no network requests: every tone is
 * synthesized locally with an oscillator.
 *
 * SCHEDULING MODEL (read this before touching playback logic)
 * -------------------------------------------------------------------------
 * The entire sequence is scheduled ahead of time using the AudioContext's
 * own high-precision clock (`audioContext.currentTime` plus per-segment
 * durations), NOT by chaining setTimeout calls that fire one symbol at a
 * time. Every oscillator's start/stop time for the whole plan is computed
 * and handed to the Web Audio graph in one pass as soon as play() is
 * called. This avoids the timing drift/jitter you'd get from the main
 * JS thread's event loop, and is the same "prepare ahead of playback"
 * principle the project's synchronization design calls for.
 *
 * REPLAY POLICY
 * -------------------------------------------------------------------------
 * This phase does not implement the full testing system, but the player
 * is already built to support the replay rules a later testing phase
 * will need, via two independent, composable options:
 *   - maxPlays:  null (unlimited replay) | a number (e.g. 1 = "play once" /
 *                "replay disabled" — those are the same constraint from
 *                the player's point of view, just named differently
 *                depending on context)
 *   - autoPlay:  whether play() should fire automatically once a plan is
 *                loaded, vs. only in response to an explicit call (e.g. a
 *                button click)
 * A future exercise/test screen decides its own values for these two
 * knobs; the player itself just enforces whatever it's told.
 *
 * USAGE
 * -------------------------------------------------------------------------
 *   const player = new MorseAudioPlayer({ toneFrequencyHz: 600, volume: 0.6 });
 *   player.loadPlan(plan);                 // plan = server's /api/morse/preview "plan" array
 *   await player.play();                   // must be called from a user-gesture handler
 *   player.stop();                         // stops immediately
 *   player.setVolume(0.3);
 */
class MorseAudioPlayer {
    /**
     * @param {object} [options]
     * @param {number} [options.toneFrequencyHz=600] - oscillator frequency in Hz.
     * @param {number} [options.volume=0.5] - 0.0 (silent) to 1.0 (full volume).
     * @param {number|null} [options.maxPlays=null] - null = unlimited; a number caps total plays (e.g. 1 = play-once).
     * @param {boolean} [options.autoPlay=false] - if true, play() is invoked automatically the first time a plan is loaded.
     * @param {number} [options.envelopeMs=5] - attack/release ramp time per tone, to avoid audible clicks.
     * @param {(info: {playCount: number}) => void} [options.onStart]
     * @param {(info: {playCount: number}) => void} [options.onEnd]
     * @param {() => void} [options.onStop]
     * @param {() => void} [options.onBlockedReplay] - called when play() is refused because the replay policy denies it.
     */
    constructor(options = {}) {
        this.toneFrequencyHz = options.toneFrequencyHz ?? 600;
        this.volume = clamp01(options.volume ?? 0.5);
        this.maxPlays = options.maxPlays ?? null;
        this.autoPlay = options.autoPlay ?? false;
        this.envelopeMs = options.envelopeMs ?? 5;

        this.onStart = options.onStart || null;
        this.onEnd = options.onEnd || null;
        this.onStop = options.onStop || null;
        this.onBlockedReplay = options.onBlockedReplay || null;

        this.audioContext = null;
        this.masterGain = null;

        this.plan = [];
        this.durationMs = 0;
        this.playCount = 0;
        this.isPlaying = false;

        this._activeOscillators = [];
        this._endTimeoutId = null;
    }

    /** Lazily creates (or resumes) the AudioContext. Must be called from a user-gesture handler the first time, per browser autoplay policy. */
    _ensureAudioContext() {
        if (!this.audioContext) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) {
                throw new Error('This browser does not support the Web Audio API.');
            }
            this.audioContext = new Ctx();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = this.volume;
            this.masterGain.connect(this.audioContext.destination);
        }
        if (this.audioContext.state === 'suspended') {
            return this.audioContext.resume();
        }
        return Promise.resolve();
    }

    /**
     * Loads a playback plan (the "plan" array from /api/morse/preview, or
     * anything shaped like [{type:'tone'|'gap', durationMs, ...}]) and
     * resets play-count tracking for it. Does not start playback unless
     * autoPlay is enabled.
     * @param {Array<{type: string, durationMs: number}>} plan
     * @param {{ durationMs?: number }} [meta]
     */
    loadPlan(plan, meta = {}) {
        if (!Array.isArray(plan)) {
            throw new TypeError('loadPlan expects an array of segments.');
        }
        this.stop();
        this.plan = plan;
        this.durationMs = meta.durationMs ?? plan.reduce((sum, seg) => sum + seg.durationMs, 0);
        this.playCount = 0;

        if (this.autoPlay) {
            // Fire and forget; callers who need to await it should call
            // play() themselves instead of relying on autoPlay.
            this.play();
        }
    }

    /** Whether another play() call is currently allowed under the configured replay policy. */
    canPlay() {
        if (this.plan.length === 0) return false;
        if (this.maxPlays === null || this.maxPlays === undefined) return true;
        return this.playCount < this.maxPlays;
    }

    /**
     * Schedules and starts playback of the currently loaded plan. Safe to
     * call from a click handler (creates/resumes the AudioContext on
     * first use, satisfying browser autoplay-gesture requirements).
     * @returns {Promise<boolean>} resolves true if playback started, false if blocked by replay policy.
     */
    async play() {
        if (!this.canPlay()) {
            if (this.onBlockedReplay) this.onBlockedReplay();
            return false;
        }

        await this._ensureAudioContext();
        this.stop(); // clear any previous scheduled/active playback first

        const ctx = this.audioContext;
        const startAt = ctx.currentTime + 0.05; // small lead-in so the very first tone isn't clipped
        let cursor = startAt;
        const envelopeSec = this.envelopeMs / 1000;

        for (const segment of this.plan) {
            const durationSec = segment.durationMs / 1000;
            if (segment.type === 'tone') {
                this._scheduleTone(cursor, durationSec, envelopeSec);
            }
            cursor += durationSec;
        }

        this.isPlaying = true;
        this.playCount += 1;
        if (this.onStart) this.onStart({ playCount: this.playCount });

        const totalMs = (cursor - startAt) * 1000 + 50;
        this._endTimeoutId = setTimeout(() => {
            this.isPlaying = false;
            this._activeOscillators = [];
            if (this.onEnd) this.onEnd({ playCount: this.playCount });
        }, totalMs);

        return true;
    }

    /** Schedules a single tone with a short linear attack/release envelope, to avoid audible clicks at on/off transitions. */
    _scheduleTone(startTime, durationSec, envelopeSec) {
        const ctx = this.audioContext;
        const rampSec = Math.min(envelopeSec, durationSec / 2);

        const oscillator = ctx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.value = this.toneFrequencyHz;

        const toneGain = ctx.createGain();
        toneGain.gain.setValueAtTime(0, startTime);
        toneGain.gain.linearRampToValueAtTime(1, startTime + rampSec);
        toneGain.gain.setValueAtTime(1, startTime + durationSec - rampSec);
        toneGain.gain.linearRampToValueAtTime(0, startTime + durationSec);

        oscillator.connect(toneGain);
        toneGain.connect(this.masterGain);

        oscillator.start(startTime);
        oscillator.stop(startTime + durationSec);

        this._activeOscillators.push(oscillator);
    }

    /** Immediately stops any scheduled or in-progress playback. */
    stop() {
        if (this._endTimeoutId) {
            clearTimeout(this._endTimeoutId);
            this._endTimeoutId = null;
        }
        if (this._activeOscillators.length > 0 && this.audioContext) {
            const now = this.audioContext.currentTime;
            this._activeOscillators.forEach((osc) => {
                try {
                    osc.stop(now);
                } catch {
                    // Already stopped/ended — safe to ignore.
                }
            });
        }
        this._activeOscillators = [];
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;
        if (wasPlaying && this.onStop) this.onStop();
    }

    /** Sets playback volume live (0.0–1.0), including any tone currently sounding. */
    setVolume(volume) {
        this.volume = clamp01(volume);
        if (this.masterGain) {
            this.masterGain.gain.value = this.volume;
        }
    }

    mute() {
        this._preMuteVolume = this.volume;
        this.setVolume(0);
    }

    unmute() {
        this.setVolume(this._preMuteVolume ?? 0.5);
    }

    /**
     * Explicitly creates/resumes the AudioContext from a user gesture
     * without playing anything. Needed for a synchronized group session:
     * the actual play() call happens later from a `setTimeout` at a
     * server-scheduled instant, not from a click, so the AudioContext
     * must already be unlocked by an earlier gesture (e.g. the student's
     * "Ready" button) to satisfy browser autoplay restrictions.
     */
    unlock() {
        return this._ensureAudioContext();
    }

    /** Releases the AudioContext. Call when the player is no longer needed (e.g. leaving a page). */
    destroy() {
        this.stop();
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
            this.masterGain = null;
        }
    }

    getState() {
        return {
            isPlaying: this.isPlaying,
            playCount: this.playCount,
            canPlay: this.canPlay(),
            durationMs: this.durationMs,
            maxPlays: this.maxPlays,
            volume: this.volume,
        };
    }
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

// Exposed as a plain global — this static client has no module bundler,
// so every page includes this file with a <script> tag and uses
// `window.MorseAudioPlayer` (or just `MorseAudioPlayer`) directly.
window.MorseAudioPlayer = MorseAudioPlayer;
