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

const SCREENS = [
    'hub',
    'radiogram-settings',
    'radiogram-play',
    'radiogram-results',
    'character-training-settings',
    'character-training-session',
    'character-training-results',
];
const CATEGORIES = ['letters', 'numbers', 'punctuation'];

const PRESET_CATEGORIES = {
    letters: ['letters'],
    numbers: ['numbers'],
    punctuation: ['punctuation'],
    alphanumeric: ['letters', 'numbers'],
    all: ['letters', 'numbers', 'punctuation'],
};

let currentScreen = null;

// Cleanup run automatically whenever navigation LEAVES a given screen —
// stops any in-flight audio/timers so an accidental navigation can never
// corrupt the next screen's state (stray keypress, stale setTimeout, etc).
const SCREEN_LEAVE_HOOKS = {
    'radiogram-play': () => {
        if (radiogramPlayer) radiogramPlayer.stop();
        clearRadiogramRevealTimeouts();
    },
    'character-training-session': () => abortCharacterTrainingRound(),
};

function showScreen(name) {
    if (currentScreen && currentScreen !== name && SCREEN_LEAVE_HOOKS[currentScreen]) {
        SCREEN_LEAVE_HOOKS[currentScreen]();
    }
    currentScreen = name;
    SCREENS.forEach((s) => {
        el(`screen-${s}`).hidden = s !== name;
    });
}

let charsets = { letters: [], numbers: [], punctuation: [] };

// ---------------------------------------------------------------------
// Character pool picker — a small factory so Radiograms and Character
// Training share one implementation instead of two copies of the same
// checkbox/preset logic. `idPrefix` namespaces the DOM ids each instance
// reads/writes (e.g. "char-grid-letters" vs "ct-char-grid-letters").
// ---------------------------------------------------------------------
function createPoolPicker(idPrefix) {
    const selected = new Set();
    const domId = (id) => (idPrefix ? `${idPrefix}-${id}` : id);

    function categoryCheckboxes(category) {
        return Array.from(el(domId(`char-grid-${category}`)).querySelectorAll('input[type="checkbox"]'));
    }

    function toggleChar(ch, isSelected) {
        if (isSelected) selected.add(ch);
        else selected.delete(ch);
    }

    function syncCategorySelectAll(category) {
        const boxes = categoryCheckboxes(category);
        const checkedCount = boxes.filter((b) => b.checked).length;
        const selectAll = el(domId(`category-select-all-${category}`));
        selectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
        selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    }

    function setCategoryChecked(category, checked) {
        categoryCheckboxes(category).forEach((box) => {
            box.checked = checked;
            toggleChar(box.value, checked);
        });
        syncCategorySelectAll(category);
    }

    function updateSummary() {
        const summary = el(domId('pool-summary'));
        const count = selected.size;
        if (count === 0) {
            summary.textContent = 'No characters selected yet.';
            return;
        }
        const sorted = [...selected].sort();
        summary.textContent = `${count} character${count === 1 ? '' : 's'} selected: ${sorted.join(' ')}`;
    }

    function buildGrid(category, chars) {
        const grid = el(domId(`char-grid-${category}`));
        grid.innerHTML = '';
        chars.forEach((ch) => {
            const label = document.createElement('label');
            label.className = 'char-chip';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = ch;
            input.addEventListener('change', () => {
                toggleChar(ch, input.checked);
                syncCategorySelectAll(category);
                updateSummary();
            });

            const span = document.createElement('span');
            span.textContent = ch;

            label.appendChild(input);
            label.appendChild(span);
            grid.appendChild(label);
        });
    }

    function buildAllGrids(sets) {
        CATEGORIES.forEach((cat) => buildGrid(cat, sets[cat] || []));
    }

    function applyPreset(preset) {
        selected.clear();
        if (preset === 'clear') {
            CATEGORIES.forEach((cat) => setCategoryChecked(cat, false));
            updateSummary();
            return;
        }
        const categoriesToSelect = PRESET_CATEGORIES[preset] || [];
        CATEGORIES.forEach((cat) => setCategoryChecked(cat, categoriesToSelect.includes(cat)));
        updateSummary();
    }

    function wireEvents(quickActionsContainerId) {
        CATEGORIES.forEach((cat) => {
            el(domId(`category-select-all-${cat}`)).addEventListener('change', (e) => {
                setCategoryChecked(cat, e.target.checked);
                updateSummary();
            });
        });
        document.querySelectorAll(`#${quickActionsContainerId} .chip-button`).forEach((btn) => {
            btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
        });
    }

    function getSelected() {
        return [...selected];
    }

    /** Replaces the current selection with exactly the given characters (e.g. "Practice Weak Characters"). */
    function setSelected(chars) {
        const want = new Set(chars.map((c) => String(c).toUpperCase()));
        selected.clear();
        CATEGORIES.forEach((cat) => {
            categoryCheckboxes(cat).forEach((box) => {
                const checked = want.has(box.value);
                box.checked = checked;
                toggleChar(box.value, checked);
            });
            syncCategorySelectAll(cat);
        });
        updateSummary();
    }

    return { buildAllGrids, wireEvents, applyPreset, getSelected, setSelected, updateSummary };
}

const radiogramPool = createPoolPicker('');
const characterTrainingPool = createPoolPicker('ct');

async function loadCharsets() {
    charsets = await api('/api/practice/charsets');
    radiogramPool.buildAllGrids(charsets);
    radiogramPool.applyPreset('letters'); // sensible default pool so Generate works immediately
    characterTrainingPool.buildAllGrids(charsets);
    characterTrainingPool.applyPreset('letters');
}

// =======================================================================
// Radiograms
// =======================================================================
let radiogramPlayer = null;
let currentRadiogram = null; // full server response incl. text/charReveal — kept in memory, but never rendered up front
let radiogramCharSlots = []; // flat array of the 120 per-character DOM spans, same order as currentRadiogram.charReveal
let radiogramRevealTimeouts = [];
let radiogramMasked = false; // "Hide Radiogram" toggle — display-only, never touches playback or the answer field

// Matches MorseAudioPlayer.play()'s own small lead-in before the first
// tone starts (see morse-audio-player.js), so reveal timers — which are
// scheduled independently via setTimeout rather than the player's
// AudioContext clock — line up with what's actually audible instead of
// firing ~50ms early.
const RADIOGRAM_REVEAL_LEAD_IN_MS = 50;

function ensureRadiogramPlayer(volume) {
    if (radiogramPlayer) return radiogramPlayer;
    radiogramPlayer = new MorseAudioPlayer({
        volume,
        maxPlays: null, // radiogram copy practice: unlimited replay
        onEnd: () => {
            clearRadiogramRevealTimeouts();
            el('radiogram-status').textContent = 'Playback complete. Finish your transcription, then analyze.';
            el('radiogram-analyze-button').disabled = false;
        },
    });
    return radiogramPlayer;
}

function currentRadiogramSettings() {
    const farnsworthRaw = el('setting-farnsworth').value;
    return {
        characters: radiogramPool.getSelected(),
        wpm: Number(el('setting-wpm').value) || undefined,
        farnsworthWpm: farnsworthRaw ? Number(farnsworthRaw) : undefined,
        toneFrequencyHz: Number(el('setting-tone').value) || undefined,
    };
}

function showRadiogramError(message) {
    const box = el('radiogram-error');
    if (!message) {
        box.hidden = true;
        box.textContent = '';
        return;
    }
    box.hidden = false;
    box.textContent = message;
}

async function generateRadiogram() {
    showRadiogramError('');
    const settings = currentRadiogramSettings();

    if (settings.characters.length === 0) {
        showRadiogramError('Select at least one character for the pool.');
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showRadiogramError('Enter a valid WPM.');
        return;
    }

    let radiogram;
    try {
        radiogram = await api('/api/practice/radiograms', { method: 'POST', body: JSON.stringify(settings) });
    } catch (err) {
        showRadiogramError(err.message);
        return;
    }

    currentRadiogram = radiogram;
    renderRadiogram(radiogram);
    showScreen('radiogram-play');
}

/**
 * Builds the reference display as one hidden "slot" span per character
 * (never the real text up front) and records them in radiogramCharSlots,
 * in exactly the order radiogram.charReveal expects — so revealCharAt(i)
 * can address them directly by index.
 */
function buildRadiogramSlots(radiogram) {
    const display = el('radiogram-display');
    display.innerHTML = '';
    radiogramCharSlots = [];

    for (let r = 0; r < radiogram.rowCount; r += 1) {
        const rowEl = document.createElement('div');
        rowEl.className = 'radiogram-row';

        const rowLabel = document.createElement('span');
        rowLabel.className = 'radiogram-row-label';
        rowLabel.textContent = String(r + 1).padStart(2, '0');
        rowEl.appendChild(rowLabel);

        const rowGroups = radiogram.groups.slice(r * radiogram.groupsPerRow, (r + 1) * radiogram.groupsPerRow);
        rowGroups.forEach((group) => {
            const groupEl = document.createElement('span');
            groupEl.className = 'rg-group';
            [...group].forEach((ch) => {
                const charEl = document.createElement('span');
                charEl.className = 'rg-char pending';
                charEl.textContent = '·'; // placeholder dot — never the real character until revealed
                groupEl.appendChild(charEl);
                radiogramCharSlots.push(charEl);
            });
            rowEl.appendChild(groupEl);
        });

        display.appendChild(rowEl);
    }
}

function resetRadiogramReveal() {
    radiogramCharSlots.forEach((slot) => {
        slot.textContent = '·';
        slot.classList.remove('revealed');
        slot.classList.add('pending');
    });
}

function clearRadiogramRevealTimeouts() {
    radiogramRevealTimeouts.forEach((id) => clearTimeout(id));
    radiogramRevealTimeouts = [];
}

function revealRadiogramCharAt(index, char) {
    const slot = radiogramCharSlots[index];
    if (!slot) return;
    slot.textContent = char;
    slot.classList.remove('pending');
    slot.classList.add('revealed');
    el('radiogram-status').textContent = `Transmitting… ${index + 1} / ${radiogramCharSlots.length}`;
}

/** (Re)schedules the live reveal against the exact same charReveal sequence used to build the audio plan, from scratch — used by both the first Play and every Replay. */
function scheduleRadiogramReveal(radiogram) {
    clearRadiogramRevealTimeouts();
    resetRadiogramReveal();
    radiogram.charReveal.forEach((entry, index) => {
        const id = setTimeout(() => revealRadiogramCharAt(index, entry.char), RADIOGRAM_REVEAL_LEAD_IN_MS + entry.atMs);
        radiogramRevealTimeouts.push(id);
    });
}

function setRadiogramMasked(masked) {
    radiogramMasked = masked;
    el('radiogram-display').classList.toggle('reference-masked', masked);
    el('radiogram-hide-button').textContent = masked ? 'Show Radiogram' : 'Hide Radiogram';
}

function renderRadiogram(radiogram) {
    buildRadiogramSlots(radiogram);
    setRadiogramMasked(false);

    const farnsworthNote =
        radiogram.timing.farnsworthWpm !== radiogram.timing.wpm ? ` (Farnsworth ${radiogram.timing.farnsworthWpm} WPM)` : '';
    el('radiogram-meta').textContent =
        `${radiogram.totalCharacters} characters · ${radiogram.groups.length} groups · ` +
        `${radiogram.timing.wpm} WPM${farnsworthNote} · ${radiogram.timing.toneFrequencyHz} Hz`;

    el('radiogram-replay-button').hidden = true;
    el('radiogram-stop-button').hidden = true;
    el('radiogram-status').textContent = 'Not started yet.';
    el('radiogram-answer').value = '';
    el('radiogram-analyze-button').disabled = true;

    const volume = Number(el('radiogram-play-volume').value) / 100;
    const p = ensureRadiogramPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(radiogram.plan, { durationMs: radiogram.durationMs });
}

function playRadiogram() {
    if (!currentRadiogram) return;
    const volume = Number(el('radiogram-play-volume').value) / 100;
    const p = ensureRadiogramPlayer(volume);
    p.setVolume(volume);
    p.play();
    el('radiogram-replay-button').hidden = false;
    el('radiogram-stop-button').hidden = false;
    el('radiogram-analyze-button').disabled = true;
    el('radiogram-status').textContent = 'Transmitting…';
    scheduleRadiogramReveal(currentRadiogram);
}

function stopRadiogram() {
    if (radiogramPlayer) radiogramPlayer.stop();
    clearRadiogramRevealTimeouts();
    el('radiogram-status').textContent = 'Stopped. You can replay, or analyze what you have so far.';
    el('radiogram-analyze-button').disabled = false;
}

/** Strips whitespace/group separators only — the exact characters the student typed are otherwise left untouched (never auto-corrected). Uppercasing/space-stripping here is comparison normalization only, per the same convention scoreAnswer already uses. */
function normalizeRadiogramAnswer(raw) {
    return raw.replace(/\s+/g, '').toUpperCase();
}

async function analyzeRadiogram() {
    if (!currentRadiogram) return;
    if (radiogramPlayer) radiogramPlayer.stop();
    clearRadiogramRevealTimeouts();

    const submittedAnswer = el('radiogram-answer').value;
    const payload = {
        characters: currentRadiogram.characters,
        wpm: currentRadiogram.timing.wpm,
        farnsworthWpm: currentRadiogram.timing.farnsworthWpm,
        toneFrequencyHz: currentRadiogram.timing.toneFrequencyHz,
        seed: currentRadiogram.seed,
        submittedAnswer: normalizeRadiogramAnswer(submittedAnswer),
    };

    let result;
    try {
        result = await api('/api/practice/radiograms/analyze', { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
        showRadiogramError(err.message);
        return;
    }

    renderRadiogramResults(result);
    showScreen('radiogram-results');
}

function renderRadiogramResults(result) {
    const { score } = result;
    const timing = currentRadiogram.timing;

    const farnsworthNote = timing.farnsworthWpm !== timing.wpm ? ` (Farnsworth ${timing.farnsworthWpm} WPM)` : '';
    el('rgr-subtitle').textContent = `${score.totalExpected} characters · ${timing.wpm} WPM${farnsworthNote} · ${timing.toneFrequencyHz} Hz`;

    const accuracyEl = el('rgr-accuracy');
    accuracyEl.textContent = `${score.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (score.accuracyPercent >= 90 ? '' : score.accuracyPercent >= 60 ? ' mid' : ' low');

    el('rgr-total').textContent = String(score.totalExpected);
    el('rgr-correct').textContent = String(score.correctCount);
    el('rgr-incorrect').textContent = String(score.incorrectCount);
    el('rgr-missing').textContent = String(score.missingCount);
    el('rgr-extra').textContent = String(score.extraCount);
    el('rgr-errors').textContent = String(score.errorCount);

    renderRadiogramComparison(score.ops, result.groupSize || 4);
}

/**
 * Renders the aligned reference/answer comparison as two rows built
 * directly from scoreAnswer's ops (one column per op, so a missing or
 * extra character shifts neither row out of alignment with the other —
 * see scoring.js for why alignment beats index-by-index comparison).
 */
function renderRadiogramComparison(ops, groupSize) {
    const container = el('rgr-compare');
    container.innerHTML = '';

    const refRow = document.createElement('div');
    refRow.className = 'rg-compare-row';
    const refLabel = document.createElement('span');
    refLabel.className = 'rg-compare-row-label';
    refLabel.textContent = 'REFERENCE';
    const refCells = document.createElement('span');
    refRow.appendChild(refLabel);
    refRow.appendChild(refCells);

    const subRow = document.createElement('div');
    subRow.className = 'rg-compare-row';
    const subLabel = document.createElement('span');
    subLabel.className = 'rg-compare-row-label';
    subLabel.textContent = 'YOUR ANSWER';
    const subCells = document.createElement('span');
    subRow.appendChild(subLabel);
    subRow.appendChild(subCells);

    let expectedSeen = 0;
    ops.forEach((op) => {
        const refCell = document.createElement('span');
        refCell.className = 'rg-compare-cell';
        const subCell = document.createElement('span');
        subCell.className = 'rg-compare-cell';

        if (op.type === 'match') {
            refCell.textContent = op.expectedChar;
            subCell.textContent = op.submittedChar;
            refCell.classList.add('rg-op-match');
            subCell.classList.add('rg-op-match');
        } else if (op.type === 'substitution') {
            refCell.textContent = op.expectedChar;
            subCell.textContent = op.submittedChar;
            refCell.classList.add('rg-op-substitution');
            subCell.classList.add('rg-op-substitution');
        } else if (op.type === 'missing') {
            refCell.textContent = op.expectedChar;
            subCell.textContent = '_';
            refCell.classList.add('rg-op-missing');
            subCell.classList.add('rg-op-missing');
        } else if (op.type === 'extra') {
            refCell.textContent = '_';
            subCell.textContent = op.submittedChar;
            refCell.classList.add('rg-op-extra');
            subCell.classList.add('rg-op-extra');
        }

        refCells.appendChild(refCell);
        subCells.appendChild(subCell);

        // Extra characters have no counterpart in the reference sequence,
        // so only expected-side-consuming ops advance the group counter —
        // this keeps the visual grouping lined up with the original 4-char
        // groups instead of drifting after the first insertion.
        if (op.type !== 'extra') {
            expectedSeen += 1;
            if (expectedSeen % groupSize === 0) {
                const refGap = document.createElement('span');
                refGap.className = 'rg-compare-gap';
                const subGap = document.createElement('span');
                subGap.className = 'rg-compare-gap';
                refCells.appendChild(refGap);
                subCells.appendChild(subGap);
            }
        }
    });

    container.appendChild(refRow);
    container.appendChild(subRow);
}

// =======================================================================
// Character Training
// =======================================================================
let ctPlayer = null;
let ctSession = null; // server response: { seed, characters, length, timing, items }
let ctResults = []; // per-round results this session
let ctCurrentIndex = 0;
let ctRoundToken = 0; // bumped on abort/finish to invalidate stale async callbacks
let ctAwaitingAnswer = false;
let ctRoundStartedAt = null; // performance.now() timestamp, set by the player's onStart hook

// Structured result of the most recently completed session — this is the
// data Part 3's results screen will consume. Not persisted beyond the
// page session; that's out of scope here.
let lastCharacterTrainingSession = null;

function ensureCtPlayer(volume) {
    if (ctPlayer) return ctPlayer;
    ctPlayer = new MorseAudioPlayer({
        volume,
        maxPlays: null,
        onStart: () => {
            // The moment this round's audio becomes available to the
            // user — the canonical start point for response-time
            // measurement, set from the player's own scheduling hook
            // rather than from a DOM render, so it isn't skewed by
            // render/layout timing.
            ctRoundStartedAt = performance.now();
        },
    });
    return ctPlayer;
}

function currentCharacterTrainingSettings() {
    const farnsworthRaw = el('ct-setting-farnsworth').value;
    return {
        characters: characterTrainingPool.getSelected(),
        length: Number(el('ct-setting-length').value) || undefined,
        wpm: Number(el('ct-setting-wpm').value) || undefined,
        farnsworthWpm: farnsworthRaw ? Number(farnsworthRaw) : undefined,
        toneFrequencyHz: Number(el('ct-setting-tone').value) || undefined,
    };
}

function showCtSettingsError(message) {
    const box = el('ct-settings-error');
    if (!message) {
        box.hidden = true;
        box.textContent = '';
        return;
    }
    box.hidden = false;
    box.textContent = message;
}

async function startCharacterTrainingSession() {
    showCtSettingsError('');
    const settings = currentCharacterTrainingSettings();

    if (settings.characters.length === 0) {
        showCtSettingsError('Select at least one character for the pool.');
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showCtSettingsError('Enter a valid WPM.');
        return;
    }
    if (!settings.length || settings.length < 1) {
        showCtSettingsError('Enter a valid number of characters (1 or more).');
        return;
    }

    let session;
    try {
        session = await api('/api/practice/character-training/sessions', { method: 'POST', body: JSON.stringify(settings) });
    } catch (err) {
        showCtSettingsError(err.message);
        return;
    }

    ctSession = session;
    ctResults = [];
    ctCurrentIndex = 0;
    ctRoundToken += 1;

    showScreen('character-training-session');
    resetCtFeedback();
    updateCtLiveStats();
    playCtRound(ctCurrentIndex);
}

async function playCtRound(index) {
    const token = ctRoundToken;
    ctAwaitingAnswer = false;
    resetCtFeedback();
    updateCtProgress(index);

    const item = ctSession.items[index];
    const volume = Number(el('ct-setting-volume').value) / 100;
    const p = ensureCtPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(item.plan, { durationMs: item.durationMs });

    const started = await p.play();
    if (token !== ctRoundToken) return; // navigated away while audio was starting
    if (!started) return;
    ctAwaitingAnswer = true;
}

function updateCtProgress(index) {
    const total = ctSession.items.length;
    el('ct-progress-text').textContent = `Character ${index + 1} / ${total}`;
    el('ct-progress-fill').style.width = `${Math.round((index / total) * 100)}%`;
}

function resetCtFeedback() {
    const feedback = el('ct-feedback');
    feedback.classList.remove('state-correct', 'state-incorrect');
    el('ct-feedback-icon').textContent = '';
    el('ct-feedback-char').textContent = '';
    el('ct-feedback-time').textContent = '';
}

function renderCtRoundFeedback({ correct, expectedChar, responseTimeMs }) {
    const feedback = el('ct-feedback');
    feedback.classList.remove('state-correct', 'state-incorrect');
    feedback.classList.add(correct ? 'state-correct' : 'state-incorrect');
    el('ct-feedback-icon').textContent = correct ? '✓' : '✗';
    el('ct-feedback-char').textContent = expectedChar;
    el('ct-feedback-time').textContent = responseTimeMs !== null ? formatSeconds(responseTimeMs) : '';
}

function updateCtLiveStats() {
    const correctCount = ctResults.filter((r) => r.correct).length;
    const incorrectCount = ctResults.length - correctCount;
    el('ct-live-correct').textContent = String(correctCount);
    el('ct-live-incorrect').textContent = String(incorrectCount);
}

function triggerCtConfetti() {
    const layer = el('ct-confetti-layer');
    const colors = ['#2f8f5b', '#5b57c9', '#b3822e', '#8868b3', '#7a9e8e'];
    const pieceCount = 18;
    for (let i = 0; i < pieceCount; i += 1) {
        const piece = document.createElement('span');
        piece.className = 'ct-confetti-piece';
        const angle = Math.random() * Math.PI * 2;
        const distance = 60 + Math.random() * 90;
        piece.style.setProperty('--ct-confetti-x', `${Math.cos(angle) * distance}px`);
        piece.style.setProperty('--ct-confetti-y', `${Math.sin(angle) * distance}px`);
        piece.style.setProperty('--ct-confetti-r', `${Math.random() * 720 - 360}deg`);
        piece.style.background = colors[i % colors.length];
        piece.addEventListener('animationend', () => piece.remove());
        layer.appendChild(piece);
    }
}

/** Handles one keyboard answer. Ignored unless a round is actively awaiting input. */
function submitCtAnswer(pressedChar) {
    if (!ctAwaitingAnswer) return;
    ctAwaitingAnswer = false;

    const responseTimeMs = ctRoundStartedAt !== null ? Math.round(performance.now() - ctRoundStartedAt) : null;
    const item = ctSession.items[ctCurrentIndex];
    const correct = pressedChar === item.char;

    ctResults.push({
        index: ctCurrentIndex,
        char: item.char,
        morse: item.morse,
        submittedKey: pressedChar,
        correct,
        responseTimeMs,
    });

    renderCtRoundFeedback({ correct, expectedChar: item.char, responseTimeMs });
    updateCtLiveStats();
    if (correct) triggerCtConfetti();

    const token = ctRoundToken;
    const delay = correct ? 700 : 1300; // give a wrong answer longer to register before moving on
    setTimeout(() => {
        if (token !== ctRoundToken) return; // session was aborted/restarted in the meantime
        advanceCtRound();
    }, delay);
}

function advanceCtRound() {
    ctCurrentIndex += 1;
    if (ctCurrentIndex >= ctSession.items.length) {
        finishCharacterTrainingSession();
        return;
    }
    playCtRound(ctCurrentIndex);
}

/** Formats a millisecond duration for display as seconds — internal timing/analysis always stays in ms for precision, only the label changes. */
function formatSeconds(ms) {
    if (ms === null || ms === undefined) return '—';
    return `${(ms / 1000).toFixed(2)}s`;
}

// Deterministic weak-character thresholds. A character is flagged weak
// when its own accuracy falls below ACCURACY_THRESHOLD (checked against
// any number of attempts, since even one wrong answer out of one attempt
// is informative), or — only once it has enough attempts to call it
// "consistent" — its average response time exceeds SPEED_MULTIPLIER times
// the whole session's average.
const WEAK_ACCURACY_THRESHOLD = 80;
const WEAK_SPEED_MULTIPLIER = 1.5;
const WEAK_SPEED_MIN_ATTEMPTS = 2;

/**
 * Aggregates a completed Character Training session's raw per-round
 * results into the session summary, a per-character breakdown, and the
 * weak-character list — entirely from the real recorded rounds, nothing
 * simulated. This is the single source of truth both the results screen
 * and "Practice Weak Characters" read from.
 */
function analyzeCharacterTrainingSession(results) {
    const totalCount = results.length;
    const correctCount = results.filter((r) => r.correct).length;
    const incorrectCount = totalCount - correctCount;
    const accuracyPercent = totalCount ? Math.round((correctCount / totalCount) * 1000) / 10 : 0;

    const timed = results.filter((r) => r.responseTimeMs !== null);
    const avgResponseMs = timed.length ? Math.round(timed.reduce((sum, r) => sum + r.responseTimeMs, 0) / timed.length) : null;
    const fastestResponseMs = timed.length ? Math.min(...timed.map((r) => r.responseTimeMs)) : null;
    const slowestResponseMs = timed.length ? Math.max(...timed.map((r) => r.responseTimeMs)) : null;

    const byChar = new Map();
    results.forEach((r) => {
        if (!byChar.has(r.char)) {
            byChar.set(r.char, { char: r.char, attempts: 0, correct: 0, incorrect: 0, responseTimes: [] });
        }
        const entry = byChar.get(r.char);
        entry.attempts += 1;
        if (r.correct) entry.correct += 1;
        else entry.incorrect += 1;
        if (r.responseTimeMs !== null) entry.responseTimes.push(r.responseTimeMs);
    });

    const bySeverity = (a, b) => a.accuracyPercent - b.accuracyPercent || (b.avgResponseMs ?? 0) - (a.avgResponseMs ?? 0);

    const characterStats = [...byChar.values()]
        .map((entry) => ({
            char: entry.char,
            attempts: entry.attempts,
            correct: entry.correct,
            incorrect: entry.incorrect,
            accuracyPercent: Math.round((entry.correct / entry.attempts) * 1000) / 10,
            avgResponseMs: entry.responseTimes.length
                ? Math.round(entry.responseTimes.reduce((sum, v) => sum + v, 0) / entry.responseTimes.length)
                : null,
        }))
        .sort(bySeverity);

    const weakCharacters = characterStats
        .map((stat) => {
            const reasons = [];
            if (stat.accuracyPercent < WEAK_ACCURACY_THRESHOLD) {
                reasons.push(`${stat.accuracyPercent}% accuracy (${stat.correct}/${stat.attempts})`);
            }
            if (
                stat.attempts >= WEAK_SPEED_MIN_ATTEMPTS &&
                avgResponseMs !== null &&
                stat.avgResponseMs !== null &&
                stat.avgResponseMs > avgResponseMs * WEAK_SPEED_MULTIPLIER
            ) {
                reasons.push(`slow (${formatSeconds(stat.avgResponseMs)} vs ${formatSeconds(avgResponseMs)} avg)`);
            }
            return { ...stat, reasons };
        })
        .filter((stat) => stat.reasons.length > 0)
        .sort(bySeverity);

    return {
        totalCount,
        correctCount,
        incorrectCount,
        accuracyPercent,
        avgResponseMs,
        fastestResponseMs,
        slowestResponseMs,
        characterStats,
        weakCharacters,
    };
}

function finishCharacterTrainingSession() {
    if (ctPlayer) ctPlayer.stop();

    // Structured cleanly: raw per-round results plus the derived analysis,
    // ready for the results screen and for "Practice Weak Characters" to
    // read the weak-character list back out of.
    lastCharacterTrainingSession = {
        seed: ctSession.seed,
        characters: ctSession.characters,
        length: ctSession.length,
        timing: ctSession.timing,
        results: ctResults,
        analysis: analyzeCharacterTrainingSession(ctResults),
        completedAt: new Date().toISOString(),
    };

    renderCtResultsScreen(lastCharacterTrainingSession);
    showScreen('character-training-results');
}

function renderCtResultsScreen(session) {
    const { analysis, timing } = session;

    const farnsworthNote = timing.farnsworthWpm !== timing.wpm ? ` (Farnsworth ${timing.farnsworthWpm} WPM)` : '';
    el('ctr-subtitle').textContent =
        `${analysis.totalCount} characters · ${timing.wpm} WPM${farnsworthNote} · ${timing.toneFrequencyHz} Hz`;

    const accuracyEl = el('ctr-accuracy');
    accuracyEl.textContent = `${analysis.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (analysis.accuracyPercent >= 90 ? '' : analysis.accuracyPercent >= 60 ? ' mid' : ' low');

    el('ctr-total').textContent = String(analysis.totalCount);
    el('ctr-correct').textContent = String(analysis.correctCount);
    el('ctr-incorrect').textContent = String(analysis.incorrectCount);
    el('ctr-avg-time').textContent = formatSeconds(analysis.avgResponseMs);
    el('ctr-fastest').textContent = formatSeconds(analysis.fastestResponseMs);
    el('ctr-slowest').textContent = formatSeconds(analysis.slowestResponseMs);

    const weakList = el('ctr-weak-list');
    weakList.innerHTML = '';
    const hasWeak = analysis.weakCharacters.length > 0;
    el('ctr-weak-empty').hidden = hasWeak;
    el('ctr-practice-weak-button').hidden = !hasWeak;
    analysis.weakCharacters.forEach((stat) => {
        const item = document.createElement('div');
        item.className = 'weak-char-item';

        const glyph = document.createElement('span');
        glyph.className = 'weak-char-glyph';
        glyph.textContent = stat.char;

        const reasons = document.createElement('span');
        reasons.className = 'weak-char-reasons';
        reasons.textContent = stat.reasons.join(' · ');

        item.appendChild(glyph);
        item.appendChild(reasons);
        weakList.appendChild(item);
    });

    const weakChars = new Set(analysis.weakCharacters.map((w) => w.char));
    const tbody = el('ctr-breakdown-tbody');
    tbody.innerHTML = '';
    analysis.characterStats.forEach((stat) => {
        const tr = document.createElement('tr');
        if (weakChars.has(stat.char)) tr.className = 'row-weak';
        tr.innerHTML = `
            <td class="ctr-char-cell">${stat.char}</td>
            <td>${stat.attempts}</td>
            <td class="count-correct">${stat.correct}</td>
            <td class="count-incorrect">${stat.incorrect}</td>
            <td>${stat.accuracyPercent}%</td>
            <td>${formatSeconds(stat.avgResponseMs)}</td>
        `;
        tbody.appendChild(tr);
    });
}

/** Starts a new session focused only on the characters this session flagged as weak, reusing the same Character Training engine/settings — not a separate training mode. */
function practiceWeakCharacters() {
    if (!lastCharacterTrainingSession || lastCharacterTrainingSession.analysis.weakCharacters.length === 0) return;
    const weakChars = lastCharacterTrainingSession.analysis.weakCharacters.map((w) => w.char);
    characterTrainingPool.setSelected(weakChars);
    startCharacterTrainingSession();
}

/** Leave hook for the session screen: stops audio and invalidates any in-flight round so navigating away never lets a stray callback act on the next screen. */
function abortCharacterTrainingRound() {
    ctRoundToken += 1;
    ctAwaitingAnswer = false;
    if (ctPlayer) ctPlayer.stop();
}

function onGlobalKeydown(e) {
    if (currentScreen !== 'character-training-session') return;
    if (!ctAwaitingAnswer) return;
    if (e.key.length !== 1) return; // ignore Shift/Enter/Escape/arrows/etc.
    if (e.repeat) return;
    e.preventDefault();
    submitCtAnswer(e.key.toUpperCase());
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

    try {
        await loadCharsets();
    } catch (err) {
        showRadiogramError(`Could not load character sets: ${err.message}`);
        showCtSettingsError(`Could not load character sets: ${err.message}`);
    }

    // Hub navigation
    el('hub-card-radiogram').addEventListener('click', () => showScreen('radiogram-settings'));
    el('hub-card-character-training').addEventListener('click', () => showScreen('character-training-settings'));

    document.querySelectorAll('.back-link[data-back-to]').forEach((btn) => {
        btn.addEventListener('click', () => showScreen(btn.dataset.backTo));
    });

    // Character pool controls (shared picker, one instance per screen)
    radiogramPool.wireEvents('pool-quick-actions');
    characterTrainingPool.wireEvents('ct-pool-quick-actions');

    // Radiogram settings -> generate
    el('generate-button').addEventListener('click', generateRadiogram);

    // Radiogram playback
    el('radiogram-play-button').addEventListener('click', playRadiogram);
    el('radiogram-replay-button').addEventListener('click', playRadiogram);
    el('radiogram-stop-button').addEventListener('click', stopRadiogram);
    el('radiogram-play-volume').addEventListener('input', () => {
        if (radiogramPlayer) radiogramPlayer.setVolume(Number(el('radiogram-play-volume').value) / 100);
    });
    el('radiogram-generate-another-button').addEventListener('click', generateRadiogram);

    // Radiogram live reveal / transcription / analysis
    el('radiogram-hide-button').addEventListener('click', () => setRadiogramMasked(!radiogramMasked));
    el('radiogram-analyze-button').addEventListener('click', analyzeRadiogram);

    // Radiogram results
    el('rgr-replay-button').addEventListener('click', () => {
        showScreen('radiogram-play');
        playRadiogram();
    });
    el('rgr-generate-another-button').addEventListener('click', generateRadiogram);

    // Character Training settings
    document.querySelectorAll('#ct-length-quick-actions .chip-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            el('ct-setting-length').value = btn.dataset.length;
        });
    });
    el('ct-start-button').addEventListener('click', startCharacterTrainingSession);
    el('ctr-practice-again-button').addEventListener('click', startCharacterTrainingSession);
    el('ctr-practice-weak-button').addEventListener('click', practiceWeakCharacters);

    // Character Training gameplay: one global keydown listener, gated by
    // screen + awaiting-answer state rather than added/removed per round.
    document.addEventListener('keydown', onGlobalKeydown);

    showScreen('hub');
}

init();
