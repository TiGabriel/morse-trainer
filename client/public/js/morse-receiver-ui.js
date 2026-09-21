/**
 * Morse Receiver UI — the only DOM-touching piece of the hidden receiver.
 * Injected into <body> on demand (see morse-receiver-secret in nav.js);
 * nothing about it exists in any page's HTML source or nav/menus. Reuses
 * this app's existing panel/badge/button classes (styles.css) so it
 * looks like part of the same naval-themed application rather than a
 * bolted-on widget, per the task's own requirement.
 *
 * UI updates are throttled to a fixed interval rather than redrawing on
 * every ReceiverState._emit() (which itself can fire once per
 * requestAnimationFrame tick, ~60Hz, while a tone is being analyzed) —
 * see the `setInterval` in open() below.
 */
(function (root) {
    const UI_UPDATE_INTERVAL_MS = 100;

    const STATE_LABELS = {
        IDLE: 'Idle',
        REQUESTING_PERMISSION: 'Requesting microphone permission…',
        LISTENING: 'Listening',
        TONE_ACTIVE: 'Tone detected',
        STOPPING: 'Stopping…',
        ERROR: 'Error',
    };

    let receiver = null;
    let unsubscribe = null;
    let latestSnapshot = null;
    let updateTimer = null;
    let panelEl = null;

    function el(id) {
        return document.getElementById(id);
    }

    function buildPanel() {
        const overlay = document.createElement('div');
        overlay.id = 'morse-receiver-overlay';
        overlay.className = 'morse-receiver-overlay';
        overlay.innerHTML = `
            <div class="panel morse-receiver-panel" role="dialog" aria-label="Morse Receiver" aria-modal="true">
                <div class="panel-header">
                    <h2>Morse Receiver</h2>
                    <button type="button" class="app-nav-logout" id="mr-close">Close</button>
                </div>

                <div class="modal-field">
                    <label>Microphone</label>
                    <div id="mr-mic-status" class="badge status-created">Not connected</div>
                </div>

                <div class="modal-field">
                    <label>Signal</label>
                    <div id="mr-signal-status" class="badge status-created">Idle</div>
                </div>

                <div id="mr-error" class="modal-error" hidden></div>

                <div class="modal-field">
                    <label>Current Morse</label>
                    <div id="mr-current-morse" class="result-answer" style="font-size:1.1rem;">&mdash;</div>
                </div>

                <div class="modal-field">
                    <label>Decoded Text</label>
                    <div id="mr-decoded-text" class="result-answer" style="font-size:1.05rem; min-height:1.4rem; word-break:break-word;"></div>
                </div>

                <div class="modal-actions" style="justify-content:flex-start; margin-bottom:1.25rem;">
                    <button type="button" class="btn btn-primary" id="mr-start">Start Receiver</button>
                    <button type="button" class="btn btn-secondary" id="mr-stop">Stop</button>
                    <button type="button" class="btn btn-secondary" id="mr-clear">Clear</button>
                </div>

                <fieldset class="preview-params" style="border: 1px solid var(--border); border-radius: var(--r-md); padding: 0.9rem 1rem;">
                    <legend>Settings</legend>
                    <div class="modal-field">
                        <label for="mr-wpm">WPM</label>
                        <input type="number" id="mr-wpm" min="3" max="40" value="15" />
                    </div>
                    <div class="modal-field">
                        <label for="mr-tone">Tone frequency (Hz)</label>
                        <input type="number" id="mr-tone" min="200" max="1200" value="600" />
                    </div>
                    <div class="modal-field">
                        <label for="mr-sensitivity">Sensitivity (dB above noise floor)</label>
                        <input type="number" id="mr-sensitivity" min="3" max="40" value="12" />
                    </div>
                    <div class="modal-field">
                        <label for="mr-tolerance">Timing tolerance</label>
                        <input type="number" id="mr-tolerance" min="0" max="1" step="0.05" value="0.35" />
                    </div>
                </fieldset>
                <p class="modal-note">Timing mode: <strong>Manual WPM</strong> — the value above is authoritative; there is no automatic speed estimation overriding it.</p>

                <p class="modal-note">Audio is processed locally in this browser and is not uploaded.</p>
            </div>
        `;
        return overlay;
    }

    function signalBadgeClass(snapshot) {
        if (snapshot.state === 'ERROR') return 'status-cancelled';
        if (snapshot.state === 'TONE_ACTIVE') return 'status-running';
        if (snapshot.state === 'LISTENING') return 'status-waiting';
        return 'status-created';
    }

    function render() {
        if (!latestSnapshot || !panelEl) return;
        const s = latestSnapshot;

        const micStatus = el('mr-mic-status');
        const isConnected = s.state !== 'IDLE' && s.state !== 'ERROR';
        micStatus.textContent = isConnected ? 'Connected' : 'Not connected';
        micStatus.className = `badge ${isConnected ? 'status-running' : 'status-created'}`;

        const signalStatus = el('mr-signal-status');
        signalStatus.textContent = STATE_LABELS[s.state] || s.state;
        signalStatus.className = `badge ${signalBadgeClass(s)}`;

        const errorBox = el('mr-error');
        if (s.state === 'ERROR' && s.errorMessage) {
            errorBox.hidden = false;
            errorBox.textContent = s.errorMessage;
        } else {
            errorBox.hidden = true;
        }

        el('mr-current-morse').textContent = s.currentMorse || '—';
        el('mr-decoded-text').textContent = s.decodedText;

        el('mr-start').disabled = s.state === 'LISTENING' || s.state === 'TONE_ACTIVE' || s.state === 'REQUESTING_PERMISSION';
        el('mr-stop').disabled = s.state === 'IDLE' || s.state === 'ERROR';
    }

    function wireControls() {
        el('mr-close').addEventListener('click', close);
        el('mr-start').addEventListener('click', () => receiver.start());
        el('mr-stop').addEventListener('click', () => receiver.stop());
        el('mr-clear').addEventListener('click', () => receiver.clear());

        el('mr-wpm').addEventListener('change', (e) => {
            const v = Number(e.target.value);
            if (v > 0) receiver.setWpm(v);
        });
        el('mr-tone').addEventListener('change', (e) => receiver.setToneFrequencyHz(Number(e.target.value)));
        el('mr-sensitivity').addEventListener('change', (e) => receiver.setSensitivityDb(Number(e.target.value)));
        el('mr-tolerance').addEventListener('change', (e) => receiver.setToleranceFactor(Number(e.target.value)));

        document.addEventListener('keydown', onEscape);
    }

    function onEscape(e) {
        if (e.key === 'Escape') close();
    }

    function open() {
        if (panelEl) return; // already open
        const { ReceiverState } = root.MorseReceiverCore;
        receiver = new ReceiverState({ wpm: 15, toneFrequencyHz: 600, sensitivityDb: 12, toleranceFactor: 0.35 });

        panelEl = buildPanel();
        document.body.appendChild(panelEl);
        wireControls();

        unsubscribe = receiver.subscribe((snapshot) => {
            latestSnapshot = snapshot;
        });
        latestSnapshot = {
            state: 'IDLE',
            errorMessage: null,
            decodedText: '',
            currentMorse: '',
        };
        render();
        updateTimer = setInterval(render, UI_UPDATE_INTERVAL_MS);
    }

    function close() {
        if (!panelEl) return;
        if (receiver) receiver.stop();
        if (unsubscribe) unsubscribe();
        if (updateTimer) clearInterval(updateTimer);
        document.removeEventListener('keydown', onEscape);
        panelEl.remove();
        panelEl = null;
        receiver = null;
        latestSnapshot = null;
    }

    root.MorseReceiverUI = { open, close };
})(window);
