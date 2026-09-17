async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}

function el(id) {
    return document.getElementById(id);
}

function showScreen(name) {
    ['settings', 'exercise', 'results'].forEach((s) => {
        el(`screen-${s}`).hidden = s !== name;
    });
}

const MODE_LABELS = {
    audio_to_text: 'Audio → Text',
    morse_to_text: 'Morse → Text',
    text_to_morse: 'Text → Morse',
    character_recognition: 'Character Recognition',
};

let player = null;
let currentExercise = null; // the raw response from /api/practice/exercises
let exerciseStartedAt = null;

function ensurePlayer() {
    if (player) return player;
    player = new MorseAudioPlayer({
        volume: Number(el('setting-volume').value) / 100,
        maxPlays: null, // practice mode: unlimited replay, unlike a future restricted test
    });
    return player;
}

// ---------------------------------------------------------------------
// Settings -> Start
// ---------------------------------------------------------------------
function currentSettings() {
    return {
        mode: el('setting-mode').value,
        difficulty: el('setting-difficulty').value,
        wpm: el('setting-wpm').value || undefined,
        length: el('setting-length').value || undefined,
    };
}

async function startExercise() {
    const settings = currentSettings();

    let exercise;
    try {
        exercise = await api('/api/practice/exercises', { method: 'POST', body: JSON.stringify(settings) });
    } catch (err) {
        alert(err.message);
        return;
    }

    currentExercise = { ...exercise, ...settings }; // keep original settings alongside resolved values
    exerciseStartedAt = Date.now();
    renderExerciseScreen(exercise);
    showScreen('exercise');
}

// ---------------------------------------------------------------------
// Exercise screen
// ---------------------------------------------------------------------
function renderExerciseScreen(exercise) {
    el('exercise-answer').value = '';
    const audioControls = el('exercise-audio-controls');
    const textPrompt = el('exercise-text-prompt');
    const answerLabel = el('exercise-answer-label');
    const answerInput = el('exercise-answer');

    const needsAudio = exercise.mode === 'audio_to_text' || exercise.mode === 'character_recognition';
    audioControls.hidden = !needsAudio;
    textPrompt.hidden = needsAudio;

    el('exercise-replay-button').hidden = true;

    if (needsAudio) {
        const p = ensurePlayer();
        p.loadPlan(exercise.plan, { durationMs: exercise.durationMs });
    } else if (exercise.mode === 'morse_to_text') {
        textPrompt.textContent = exercise.promptMorse;
    } else if (exercise.mode === 'text_to_morse') {
        textPrompt.textContent = exercise.promptText;
    }

    if (exercise.mode === 'text_to_morse') {
        answerLabel.textContent = 'Your answer (Morse: use . and - , space between letters)';
        answerInput.setAttribute('autocapitalize', 'off');
    } else if (exercise.mode === 'character_recognition') {
        answerLabel.textContent = 'Which character did you hear?';
        answerInput.setAttribute('autocapitalize', 'characters');
        answerInput.maxLength = 1;
    } else {
        answerLabel.textContent = 'Your answer';
        answerInput.removeAttribute('maxlength');
        answerInput.setAttribute('autocapitalize', 'characters');
    }

    answerInput.focus();
}

function playCurrentAudio() {
    const p = ensurePlayer();
    p.setVolume(Number(el('setting-volume').value) / 100);
    p.play();
    el('exercise-replay-button').hidden = false;
}

async function submitAnswer() {
    const submittedAnswer = el('exercise-answer').value;
    const durationMs = Date.now() - exerciseStartedAt;

    const body = {
        mode: currentExercise.mode,
        difficulty: currentExercise.difficulty,
        wpm: currentExercise.wpm,
        farnsworthWpm: currentExercise.farnsworthWpm,
        toneFrequencyHz: currentExercise.toneFrequencyHz,
        length: currentExercise.length,
        seed: currentExercise.seed,
        submittedAnswer,
        durationMs,
    };

    let result;
    try {
        result = await api('/api/practice/attempts', { method: 'POST', body: JSON.stringify(body) });
    } catch (err) {
        alert(err.message);
        return;
    }

    if (player) player.stop();
    renderResultsScreen(result);
    showScreen('results');
}

// ---------------------------------------------------------------------
// Results screen
// ---------------------------------------------------------------------
function renderDiff(ops) {
    const container = document.createElement('div');
    ops.forEach((op) => {
        const span = document.createElement('span');
        span.className = `diff-char diff-${op.type}`;
        if (op.type === 'match') {
            span.textContent = op.submittedChar;
            span.title = 'Correct';
        } else if (op.type === 'substitution') {
            span.textContent = op.submittedChar;
            span.title = `You typed "${op.submittedChar}", expected "${op.expectedChar}"`;
        } else if (op.type === 'missing') {
            span.textContent = op.expectedChar;
            span.title = `Missing — expected "${op.expectedChar}"`;
        } else if (op.type === 'extra') {
            span.textContent = op.submittedChar;
            span.title = 'Extra character (not in the correct answer)';
        }
        container.appendChild(span);
    });
    return container;
}

function renderResultsScreen(result) {
    const { score } = result;

    const accuracyEl = el('result-accuracy');
    accuracyEl.textContent = `${score.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (score.accuracyPercent >= 90 ? '' : score.accuracyPercent >= 60 ? ' mid' : ' low');

    el('result-correct').textContent = score.correctCount;
    el('result-incorrect').textContent = score.incorrectCount;
    el('result-missing').textContent = score.missingCount;
    el('result-extra').textContent = score.extraCount;

    const diffContainer = el('result-diff');
    diffContainer.innerHTML = '';
    diffContainer.appendChild(renderDiff(score.ops));

    const expectedLabel = result.mode === 'text_to_morse' ? result.promptMorse : result.expectedAnswer;
    el('result-expected').textContent = expectedLabel;
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
async function loadHistory() {
    const tbody = el('history-tbody');
    try {
        const { attempts } = await api('/api/practice/history?limit=15');
        if (attempts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="muted">No practice attempts yet.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        attempts.forEach((a) => {
            const tr = document.createElement('tr');
            const date = new Date(a.createdAt.replace(' ', 'T') + 'Z');
            tr.innerHTML = `
                <td>${date.toLocaleString()}</td>
                <td>${MODE_LABELS[a.exerciseType] || a.exerciseType}</td>
                <td>${a.difficulty || '—'}</td>
                <td>${a.wpm}</td>
                <td>${a.accuracyPercent}%</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">Could not load history: ${err.message}</td></tr>`;
    }
}

// ---------------------------------------------------------------------
// Bootstrapping / auth gate
// ---------------------------------------------------------------------
async function init() {
    try {
        const { user } = await api('/api/auth/me');
        el('user-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();
    } catch {
        window.location.href = '/';
        return;
    }

    el('auth-gate').hidden = true;
    el('app').hidden = false;

    el('start-button').addEventListener('click', startExercise);
    el('exercise-play-button').addEventListener('click', playCurrentAudio);
    el('exercise-replay-button').addEventListener('click', playCurrentAudio);
    el('exercise-submit-button').addEventListener('click', submitAnswer);
    el('exercise-answer').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAnswer();
    });
    el('exercise-cancel-button').addEventListener('click', () => {
        if (player) player.stop();
        showScreen('settings');
    });
    el('result-retry-button').addEventListener('click', startExercise);
    el('result-settings-button').addEventListener('click', () => showScreen('settings'));

    let historyShown = false;
    el('history-toggle').addEventListener('click', async () => {
        historyShown = !historyShown;
        el('history-panel').hidden = !historyShown;
        el('history-toggle').textContent = historyShown ? 'Hide my practice history' : 'Show my practice history';
        if (historyShown) await loadHistory();
    });

    showScreen('settings');
}

init();
