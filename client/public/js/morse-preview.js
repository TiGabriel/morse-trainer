// Relies on `api()` from teacher.js (already loaded first) and the
// global `MorseAudioPlayer` from morse-audio-player.js.
(function () {
    let player = null;
    let currentPlan = [];
    let currentDurationMs = 0;

    function el(id) {
        return document.getElementById(id);
    }

    function formatMs(ms) {
        if (!ms || ms <= 0) return '0.0s';
        return `${(ms / 1000).toFixed(1)}s`;
    }

    function readReplayPolicy() {
        const raw = el('preview-replay-policy').value;
        return raw === '' ? null : Number(raw);
    }

    function ensurePlayer() {
        if (player) return player;
        player = new MorseAudioPlayer({
            toneFrequencyHz: Number(el('preview-tone').value) || 600,
            volume: Number(el('preview-volume').value) / 100,
            maxPlays: readReplayPolicy(),
            autoPlay: el('preview-autoplay').checked,
            onStart: ({ playCount }) => {
                el('preview-status').textContent = 'Playing…';
                el('preview-play-count').textContent = String(playCount);
            },
            onEnd: () => {
                el('preview-status').textContent = 'Finished';
            },
            onStop: () => {
                el('preview-status').textContent = 'Stopped';
            },
            onBlockedReplay: () => {
                el('preview-status').textContent = 'Replay blocked by current policy';
            },
        });
        return player;
    }

    function applyLiveSettings() {
        if (!player) return;
        player.toneFrequencyHz = Number(el('preview-tone').value) || 600;
        player.setVolume(Number(el('preview-volume').value) / 100);
        player.maxPlays = readReplayPolicy();
        player.autoPlay = el('preview-autoplay').checked;
    }

    function showWarning(message) {
        const box = el('preview-warning');
        if (!message) {
            box.hidden = true;
            box.textContent = '';
            return;
        }
        box.hidden = false;
        box.textContent = message;
    }

    async function loadPreview(text) {
        showWarning('');
        const wpm = Number(el('preview-wpm').value) || 15;
        const farnsworthRaw = el('preview-farnsworth').value;
        const toneFrequencyHz = Number(el('preview-tone').value) || 600;

        const body = { text, wpm, toneFrequencyHz };
        if (farnsworthRaw) body.farnsworthWpm = Number(farnsworthRaw);

        let result;
        try {
            result = await api('/api/morse/preview', { method: 'POST', body: JSON.stringify(body) });
        } catch (err) {
            showWarning(err.message);
            return;
        }

        currentPlan = result.plan;
        currentDurationMs = result.durationMs;

        el('preview-morse').textContent = result.morse || '(empty)';
        el('preview-duration').textContent = formatMs(result.durationMs);
        el('preview-play-count').textContent = '0';
        el('preview-status').textContent = 'Ready';

        if (result.invalidCharacters && result.invalidCharacters.length > 0) {
            const chars = [...new Set(result.invalidCharacters.map((c) => `"${c.char}"`))].join(', ');
            showWarning(`Unsupported character(s) skipped: ${chars}`);
        }

        const p = ensurePlayer();
        applyLiveSettings();
        p.loadPlan(currentPlan, { durationMs: currentDurationMs });
    }

    async function generateRandomText() {
        const difficulty = el('preview-difficulty').value;
        try {
            const result = await api(`/api/morse/random?difficulty=${encodeURIComponent(difficulty)}`);
            el('preview-text').value = result.text;
            el('preview-wpm').value = result.wpm;
            await loadPreview(result.text);
        } catch (err) {
            showWarning(err.message);
        }
    }

    function wire() {
        el('preview-generate-button').addEventListener('click', generateRandomText);

        el('preview-play-button').addEventListener('click', async () => {
            // Re-fetch the plan for whatever text is currently in the box,
            // in case wpm/tone/text changed since the last load.
            const text = el('preview-text').value.trim();
            if (!text) {
                showWarning('Enter some text first.');
                return;
            }
            await loadPreview(text);
            const p = ensurePlayer();
            applyLiveSettings();
            const started = await p.play();
            if (!started) {
                el('preview-status').textContent = 'Replay blocked by current policy';
            }
        });

        el('preview-stop-button').addEventListener('click', () => {
            if (player) player.stop();
        });

        el('preview-volume').addEventListener('input', applyLiveSettings);
        el('preview-tone').addEventListener('change', applyLiveSettings);
        el('preview-replay-policy').addEventListener('change', applyLiveSettings);
        el('preview-autoplay').addEventListener('change', applyLiveSettings);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
