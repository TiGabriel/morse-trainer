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
    'reception-settings',
    'reception-play',
    'reception-results',
    'transmission-settings',
    'transmission-play',
    'transmission-results',
    'transmission-free',
];
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
    'reception-play': () => {
        if (receptionPlayer) receptionPlayer.stop();
        stopReceptionTimer();
    },
    'transmission-play': () => {
        stopTxTimer();
        txKeyPhysicallyDown = false;
        const keyArea = el('tx-key-area');
        if (keyArea) keyArea.classList.remove('is-pressed');
    },
    'transmission-free': () => {
        stopFreeTxTimer();
        if (freeTxTonePlayer) freeTxTonePlayer.stopTone();
        freeTxKeyPhysicallyDown = false;
        const keyArea = el('txf-key-area');
        if (keyArea) keyArea.classList.remove('is-pressed');
    },
};

function showScreen(name) {
    if (currentScreen && currentScreen !== name && SCREEN_LEAVE_HOOKS[currentScreen]) {
        SCREEN_LEAVE_HOOKS[currentScreen]();
    }
    currentScreen = name;
    SCREENS.forEach((s) => {
        el(`screen-${s}`).hidden = s !== name;
    });
    syncAnswerReveal();
}

/**
 * Publishes the current screen's authoritative answer to the hidden
 * P-O-O-U reveal popup (see nav.js), or clears it when the active screen
 * has no "current item" of its own. Never sends anything anywhere — just
 * republishes data this script already holds in memory for the item on
 * screen right now. Called on every screen transition, and again mid-screen
 * whenever the current item changes without a transition (character
 * training's round-to-round advance).
 */
function syncAnswerReveal() {
    if (!window.AnswerReveal) return;

    if (currentScreen === 'character-training-session' && ctSession && ctSession.items[ctCurrentIndex]) {
        const item = ctSession.items[ctCurrentIndex];
        window.AnswerReveal.publish({ label: 'Character Training', answer: `${item.char}  (Morse: ${item.morse})` });
        return;
    }

    if ((currentScreen === 'radiogram-play' || currentScreen === 'radiogram-results') && currentRadiogram) {
        window.AnswerReveal.publish({ label: 'Radiogram Training', answer: currentRadiogram.rows.join('\n') });
        return;
    }

    // Deliberately NOT published during 'reception-play' — Reception is a
    // blind-copy assessment (see receptionEngine.js's doc comment) and the
    // server never even sends the answer to the client until after
    // submission, so there is nothing to reveal yet at that point.
    if (currentScreen === 'reception-results' && lastReceptionResult) {
        window.AnswerReveal.publish({ label: 'Reception Training', answer: lastReceptionResult.referenceGroups.join(' ') });
        return;
    }

    window.AnswerReveal.clear();
}

let charsets = { letters: [], numbers: [], punctuation: [] };

// Character pool picker (createPoolPicker/CATEGORIES/PRESET_CATEGORIES) now
// lives in the shared character-pool.js, loaded before this file — see
// that file's header. Group Session creation uses the same factory.
const radiogramPool = createPoolPicker('');
const characterTrainingPool = createPoolPicker('ct');

async function loadCharsets() {
    charsets = await api('/api/practice/charsets');
    radiogramPool.buildAllGrids(charsets);
    radiogramPool.applyPreset('letters'); // sensible default pool so Generate works immediately
    characterTrainingPool.buildAllGrids(charsets);
    characterTrainingPool.applyPreset('letters');
    receptionPool.buildAllGrids(charsets);
    receptionPool.applyPreset('letters');
    transmissionPool.buildAllGrids(charsets);
    transmissionPool.applyPreset('letters');
}

// =======================================================================
// Radiograms
// =======================================================================
let radiogramPlayer = null;
let currentRadiogram = null; // full server response incl. text/charReveal — kept in memory, but never rendered up front
let radiogramCharSlots = []; // flat array of the 120 per-character DOM spans, same order as currentRadiogram.charReveal
let radiogramRevealTimeouts = [];
let radiogramMasked = false; // "Hide Radiogram" toggle — display-only, never touches playback or the answer field
let radiogramStartedAt = null; // Date.now() at first playback of the current radiogram; reset whenever a new one is generated

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
            el('radiogram-status').textContent = t('radiogram.statusPlaybackComplete');
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
        showRadiogramError(t('validation.selectAtLeastOneChar'));
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showRadiogramError(t('validation.enterValidWpm'));
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
    radiogramStartedAt = null;
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
    el('radiogram-status').textContent = t('radiogram.statusTransmittingProgress', { current: index + 1, total: radiogramCharSlots.length });
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
    el('radiogram-hide-button').textContent = masked ? t('radiogram.showRadiogram') : t('radiogram.hideRadiogram');
}

function renderRadiogram(radiogram) {
    buildRadiogramSlots(radiogram);
    setRadiogramMasked(false);

    const farnsworthNote =
        radiogram.timing.farnsworthWpm !== radiogram.timing.wpm ? t('common.farnsworthNote', { wpm: radiogram.timing.farnsworthWpm }) : '';
    el('radiogram-meta').textContent =
        `${radiogram.totalCharacters} ${t('common.characters')} · ${radiogram.groups.length} ${t('common.groupsUnit')} · ` +
        `${radiogram.timing.wpm} ${t('common.wpmShort')}${farnsworthNote} · ${radiogram.timing.toneFrequencyHz} Hz`;

    el('radiogram-replay-button').hidden = true;
    el('radiogram-stop-button').hidden = true;
    el('radiogram-status').textContent = t('radiogram.statusNotStarted');
    el('radiogram-answer').value = '';
    el('radiogram-analyze-button').disabled = true;

    const volume = Number(el('radiogram-play-volume').value) / 100;
    const p = ensureRadiogramPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(radiogram.plan, { durationMs: radiogram.durationMs });
}

function playRadiogram() {
    if (!currentRadiogram) return;
    if (radiogramStartedAt === null) radiogramStartedAt = Date.now();
    const volume = Number(el('radiogram-play-volume').value) / 100;
    const p = ensureRadiogramPlayer(volume);
    p.setVolume(volume);
    p.play();
    el('radiogram-replay-button').hidden = false;
    el('radiogram-stop-button').hidden = false;
    el('radiogram-analyze-button').disabled = true;
    el('radiogram-status').textContent = t('radiogram.statusTransmitting');
    scheduleRadiogramReveal(currentRadiogram);
}

function stopRadiogram() {
    if (radiogramPlayer) radiogramPlayer.stop();
    clearRadiogramRevealTimeouts();
    el('radiogram-status').textContent = t('radiogram.statusStopped');
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
        durationMs: radiogramStartedAt !== null ? Date.now() - radiogramStartedAt : undefined,
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

    const farnsworthNote = timing.farnsworthWpm !== timing.wpm ? t('common.farnsworthNote', { wpm: timing.farnsworthWpm }) : '';
    el('rgr-subtitle').textContent = `${score.totalExpected} ${t('common.characters')} · ${timing.wpm} ${t('common.wpmShort')}${farnsworthNote} · ${timing.toneFrequencyHz} Hz`;

    const accuracyEl = el('rgr-accuracy');
    accuracyEl.textContent = `${score.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (score.accuracyPercent >= 90 ? '' : score.accuracyPercent >= 60 ? ' mid' : ' low');

    // The server already computed this via the same centralized grading
    // service (see practiceController.analyzeRadiogram) — rendered as-is,
    // never recomputed client-side.
    const characterGrade = result.characterGrade;
    const gradeEl = el('rgr-grade');
    gradeEl.textContent = characterGrade ? String(characterGrade.grade) : '—';
    gradeEl.className = 'result-grade-value' + (characterGrade && window.GradingService ? ' ' + window.GradingService.gradeSeverityClass(characterGrade.grade) : '');

    el('rgr-total').textContent = String(score.totalExpected);
    el('rgr-correct').textContent = String(score.correctCount);
    el('rgr-incorrect').textContent = String(score.incorrectCount);
    el('rgr-missing').textContent = String(score.missingCount);
    el('rgr-extra').textContent = String(score.extraCount);
    el('rgr-errors').textContent = String(score.errorCount);

    renderComparison('rgr-compare', score.ops, result.groupSize || 4);
}

/**
 * Renders the aligned reference/answer comparison as two rows built
 * directly from scoreAnswer's ops (one column per op, so a missing or
 * extra character shifts neither row out of alignment with the other —
 * see scoring.js for why alignment beats index-by-index comparison).
 * Shared by the Radiogram and Reception results screens — one comparison
 * renderer, not a duplicate per exercise type.
 */
function renderComparison(containerId, ops, groupSize) {
    const container = el(containerId);
    container.innerHTML = '';

    const refRow = document.createElement('div');
    refRow.className = 'rg-compare-row';
    const refLabel = document.createElement('span');
    refLabel.className = 'rg-compare-row-label';
    refLabel.textContent = t('radiogram.referenceLabel');
    const refCells = document.createElement('span');
    refRow.appendChild(refLabel);
    refRow.appendChild(refCells);

    const subRow = document.createElement('div');
    subRow.className = 'rg-compare-row';
    const subLabel = document.createElement('span');
    subLabel.className = 'rg-compare-row-label';
    subLabel.textContent = t('radiogram.yourAnswerLabel');
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
let ctSessionStartedAt = null; // Date.now() when the session was launched, for the saved attempt's durationMs

// Visual Morse Aid: display-only, never sent to the server or mixed into
// scoring/timing. Read from the settings checkbox once per session (see
// startCharacterTrainingSession) rather than persisted anywhere, per the
// feature's own "current session only" scope.
let ctVisualAidEnabled = false;
let ctAidHighlightTimeouts = [];

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

// Matches MorseAudioPlayer.play()'s own small lead-in before the first
// tone starts (see morse-audio-player.js), so the aid's highlight
// timers — scheduled independently via setTimeout, not the player's
// AudioContext clock — line up with what's actually audible instead of
// firing early. Same technique as RADIOGRAM_REVEAL_LEAD_IN_MS above.
const CT_AID_LEAD_IN_MS = 50;

/**
 * Walks a round's playback plan (the exact array handed to
 * MorseAudioPlayer.loadPlan — see characterTrainingEngine.js) and pulls
 * out just the "tone" segments in order, each tagged with its cumulative
 * start offset from the top of the plan. This mirrors the same
 * cursor-accumulation MorseAudioPlayer.play() already does internally,
 * so the aid never recomputes or re-derives Morse timing — it just reads
 * the same segment list the audio engine was given.
 */
function buildMorseAidElements(plan) {
    const elements = [];
    let cursorMs = 0;
    plan.forEach((segment) => {
        if (segment.type === 'tone') {
            elements.push({ symbol: segment.symbol, atMs: cursorMs });
        }
        cursorMs += segment.durationMs;
    });
    return elements;
}

function clearCtAidHighlightTimeouts() {
    ctAidHighlightTimeouts.forEach((id) => clearTimeout(id));
    ctAidHighlightTimeouts = [];
}

/**
 * Renders the ti/tah + dot/dash rows for one round — the Morse rhythm
 * only, never item.char — or hides the aid entirely when the setting is
 * off. Called at the start of every round so it always matches whatever
 * is about to play.
 */
function renderMorseAid(elements) {
    const container = el('ct-morse-aid');
    if (!ctVisualAidEnabled) {
        container.hidden = true;
        return;
    }

    const wordsRow = el('ct-morse-aid-words');
    const symbolsRow = el('ct-morse-aid-symbols');
    wordsRow.innerHTML = '';
    symbolsRow.innerHTML = '';

    elements.forEach(({ symbol }) => {
        const wordEl = document.createElement('span');
        wordEl.className = 'ct-morse-aid-element';
        wordEl.textContent = symbol === '.' ? 'ti' : 'tah';
        wordsRow.appendChild(wordEl);

        const symbolEl = document.createElement('span');
        symbolEl.className = 'ct-morse-aid-element ct-morse-aid-symbol';
        symbolEl.textContent = symbol;
        symbolsRow.appendChild(symbolEl);
    });

    container.hidden = false;
}

/** Highlights each aid element in turn, timed against the same plan currently playing — see CT_AID_LEAD_IN_MS. */
function scheduleCtAidHighlights(elements) {
    clearCtAidHighlightTimeouts();
    if (!ctVisualAidEnabled) return;

    const wordSpans = el('ct-morse-aid-words').children;
    const symbolSpans = el('ct-morse-aid-symbols').children;

    elements.forEach((element, index) => {
        const id = setTimeout(() => {
            Array.from(wordSpans).forEach((s) => s.classList.remove('is-active'));
            Array.from(symbolSpans).forEach((s) => s.classList.remove('is-active'));
            if (wordSpans[index]) wordSpans[index].classList.add('is-active');
            if (symbolSpans[index]) symbolSpans[index].classList.add('is-active');
        }, CT_AID_LEAD_IN_MS + element.atMs);
        ctAidHighlightTimeouts.push(id);
    });
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
        showCtSettingsError(t('validation.selectAtLeastOneChar'));
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showCtSettingsError(t('validation.enterValidWpm'));
        return;
    }
    if (!settings.length || settings.length < 1) {
        showCtSettingsError(t('validation.enterValidCharCount'));
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
    ctVisualAidEnabled = el('ct-setting-visual-aid').checked;
    ctSessionStartedAt = Date.now();

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
    const aidElements = buildMorseAidElements(item.plan);
    renderMorseAid(aidElements);
    syncAnswerReveal();

    const volume = Number(el('ct-setting-volume').value) / 100;
    const p = ensureCtPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(item.plan, { durationMs: item.durationMs });

    const started = await p.play();
    if (token !== ctRoundToken) return; // navigated away while audio was starting
    if (!started) return;
    ctAwaitingAnswer = true;
    scheduleCtAidHighlights(aidElements);
}

function updateCtProgress(index) {
    const total = ctSession.items.length;
    el('ct-progress-text').textContent = t('characterTraining.progressText', { current: index + 1, total });
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

/**
 * Persists a completed Character Training session to the student's
 * practice history. Server-side, this regenerates the session from
 * `seed` and recomputes correctness itself (never trusting the client's
 * per-round `correct` flags) — same pattern as analyzeRadiogram. Runs in
 * the background: the results screen has already rendered from the
 * locally-computed analysis by the time this resolves, so a slow or
 * failed save never blocks the student from seeing their score, it only
 * surfaces a small non-blocking notice if the save itself failed.
 */
async function saveCharacterTrainingAttempt(session, results) {
    const box = el('ctr-save-error');
    box.hidden = true;
    box.textContent = '';

    const payload = {
        characters: session.characters,
        length: session.length,
        wpm: session.timing.wpm,
        farnsworthWpm: session.timing.farnsworthWpm,
        toneFrequencyHz: session.timing.toneFrequencyHz,
        seed: session.seed,
        submittedAnswer: results.map((r) => r.submittedKey).join(''),
        durationMs: ctSessionStartedAt !== null ? Date.now() - ctSessionStartedAt : undefined,
    };

    try {
        await api('/api/practice/character-training/attempts', { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
        box.hidden = false;
        box.textContent = t('common.resultNotSaved', { message: err.message });
    }
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

    saveCharacterTrainingAttempt(ctSession, ctResults);

    renderCtResultsScreen(lastCharacterTrainingSession);
    showScreen('character-training-results');
}

function renderCtResultsScreen(session) {
    const { analysis, timing } = session;

    const farnsworthNote = timing.farnsworthWpm !== timing.wpm ? t('common.farnsworthNote', { wpm: timing.farnsworthWpm }) : '';
    el('ctr-subtitle').textContent =
        `${analysis.totalCount} ${t('common.characters')} · ${timing.wpm} ${t('common.wpmShort')}${farnsworthNote} · ${timing.toneFrequencyHz} Hz`;

    const accuracyEl = el('ctr-accuracy');
    accuracyEl.textContent = `${analysis.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (analysis.accuracyPercent >= 90 ? '' : analysis.accuracyPercent >= 60 ? ' mid' : ' low');

    // Character Training never round-trips to the server for its
    // per-session aggregate (each round is scored client-side), so this
    // is the one place that calls the centralized grading service
    // directly rather than just rendering a grade the server already
    // computed — see grading.js's header comment.
    const characterGrade = window.GradingService
        ? window.GradingService.calculateGrade({ correct: analysis.correctCount, total: analysis.totalCount })
        : null;
    const gradeEl = el('ctr-grade');
    gradeEl.textContent = characterGrade ? String(characterGrade.grade) : '—';
    gradeEl.className = 'result-grade-value' + (characterGrade ? ' ' + window.GradingService.gradeSeverityClass(characterGrade.grade) : '');

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

// =======================================================================
// Reception Training (Audio -> Text, blind copy)
// =======================================================================
const receptionPool = createPoolPicker('rcp');
let receptionPlayer = null;
let currentReception = null; // server generate response — NEVER includes the answer text, only what's needed to play it
let lastReceptionResult = null; // most recently graded submit response, for the results screen + AnswerReveal
let receptionTimerId = null;
let receptionAccumulatedMs = 0; // ms of audio already played, across pause/resume
let receptionSegmentStartedAt = null; // Date.now() when the current play/resume segment began
let receptionExerciseStartedAt = null; // Date.now() at the very first Start (or after a Restart), for the saved attempt's durationMs

function ensureReceptionPlayer(volume) {
    if (receptionPlayer) return receptionPlayer;
    receptionPlayer = new MorseAudioPlayer({
        volume,
        maxPlays: null, // unlimited replay — replay must not regenerate the answer, only re-play the same audio
        onEnd: () => {
            stopReceptionTimer();
            setReceptionProgress(currentReception ? currentReception.durationMs : 0);
            el('rcp-pause-button').hidden = true;
            el('rcp-resume-button').hidden = true;
            el('rcp-stop-button').hidden = true;
            el('rcp-replay-button').hidden = false;
            el('rcp-status').textContent = t('reception.statusPlaybackComplete');
        },
    });
    return receptionPlayer;
}

function currentReceptionSettings() {
    const farnsworthRaw = el('rcp-setting-farnsworth').value;
    return {
        characters: receptionPool.getSelected(),
        groupSize: Number(el('rcp-setting-group-size').value),
        groupCount: Number(el('rcp-setting-group-count').value) || undefined,
        wpm: Number(el('rcp-setting-wpm').value) || undefined,
        farnsworthWpm: farnsworthRaw ? Number(farnsworthRaw) : undefined,
        toneFrequencyHz: Number(el('rcp-setting-tone').value) || undefined,
    };
}

function showReceptionError(message) {
    const box = el('rcp-settings-error');
    if (!message) {
        box.hidden = true;
        box.textContent = '';
        return;
    }
    box.hidden = false;
    box.textContent = message;
}

function updateReceptionLengthSummary() {
    const groupSize = Number(el('rcp-setting-group-size').value) || 0;
    const groupCount = Number(el('rcp-setting-group-count').value) || 0;
    const total = groupSize > 0 ? groupSize * groupCount : groupCount;
    el('rcp-length-summary').textContent = groupSize > 0
        ? `${total} characters total (${groupCount} group${groupCount === 1 ? '' : 's'} of ${groupSize}).`
        : `${total} characters total, ungrouped.`;
}

async function generateReception() {
    showReceptionError('');
    const settings = currentReceptionSettings();

    if (settings.characters.length === 0) {
        showReceptionError(t('validation.selectAtLeastOneChar'));
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showReceptionError(t('validation.enterValidWpm'));
        return;
    }
    if (!settings.groupCount || settings.groupCount < 1) {
        showReceptionError(t('validation.enterValidGroupCount'));
        return;
    }

    let exercise;
    try {
        exercise = await api('/api/practice/reception/exercises', { method: 'POST', body: JSON.stringify(settings) });
    } catch (err) {
        showReceptionError(err.message);
        return;
    }

    currentReception = exercise;
    lastReceptionResult = null;
    renderReceptionPlay(exercise);
    showScreen('reception-play');
}

function renderReceptionPlay(exercise) {
    const farnsworthNote = exercise.timing.farnsworthWpm !== exercise.timing.wpm ? t('common.farnsworthNote', { wpm: exercise.timing.farnsworthWpm }) : '';
    el('rcp-meta').textContent =
        `${exercise.totalCharacters} ${t('common.characters')} · ${exercise.timing.wpm} ${t('common.wpmShort')}${farnsworthNote} · ${exercise.timing.toneFrequencyHz} Hz`;

    el('rcp-answer').value = '';
    resetReceptionPlaybackButtons();
    receptionAccumulatedMs = 0;
    receptionSegmentStartedAt = null;
    receptionExerciseStartedAt = null;
    setReceptionProgress(0);
    el('rcp-status').textContent = t('reception.statusNotStarted');

    const volume = Number(el('rcp-play-volume').value) / 100;
    const p = ensureReceptionPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(exercise.plan, { durationMs: exercise.durationMs });
}

function resetReceptionPlaybackButtons() {
    el('rcp-play-button').hidden = false;
    el('rcp-pause-button').hidden = true;
    el('rcp-resume-button').hidden = true;
    el('rcp-stop-button').hidden = true;
    el('rcp-replay-button').hidden = true;
}

function formatMmSs(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function setReceptionProgress(elapsedMs) {
    const total = currentReception ? currentReception.durationMs : 0;
    const clamped = Math.min(Math.max(elapsedMs, 0), total);
    el('rcp-progress-text').textContent = `${formatMmSs(clamped)} / ${formatMmSs(total)}`;
    el('rcp-progress-fill').style.width = total > 0 ? `${Math.round((clamped / total) * 100)}%` : '0%';
}

function stopReceptionTimer() {
    if (receptionTimerId) {
        clearInterval(receptionTimerId);
        receptionTimerId = null;
    }
}

function startReceptionTimer() {
    stopReceptionTimer();
    receptionSegmentStartedAt = Date.now();
    receptionTimerId = setInterval(() => {
        const elapsed = receptionAccumulatedMs + (Date.now() - receptionSegmentStartedAt);
        setReceptionProgress(elapsed);
    }, 200);
}

/** Freezes the accumulated-elapsed counter at whatever the timer last showed — called on pause/stop so resume continues from the right place. */
function freezeReceptionElapsed() {
    if (receptionSegmentStartedAt !== null) {
        receptionAccumulatedMs += Date.now() - receptionSegmentStartedAt;
        receptionSegmentStartedAt = null;
    }
    stopReceptionTimer();
}

async function startReceptionPlayback() {
    if (!currentReception) return;
    if (receptionExerciseStartedAt === null) receptionExerciseStartedAt = Date.now();
    const volume = Number(el('rcp-play-volume').value) / 100;
    const p = ensureReceptionPlayer(volume);
    p.setVolume(volume);
    const started = await p.play();
    if (!started) return;

    el('rcp-play-button').hidden = true;
    el('rcp-replay-button').hidden = true;
    el('rcp-pause-button').hidden = false;
    el('rcp-stop-button').hidden = false;
    el('rcp-status').textContent = t('reception.statusTransmitting');
    startReceptionTimer();
}

function pauseReceptionPlayback() {
    if (!receptionPlayer) return;
    receptionPlayer.pause();
    freezeReceptionElapsed();
    el('rcp-pause-button').hidden = true;
    el('rcp-resume-button').hidden = false;
    el('rcp-status').textContent = t('reception.statusPaused');
}

async function resumeReceptionPlayback() {
    if (!receptionPlayer) return;
    const resumed = await receptionPlayer.resume();
    if (!resumed) return;
    el('rcp-resume-button').hidden = true;
    el('rcp-pause-button').hidden = false;
    el('rcp-status').textContent = t('reception.statusTransmitting');
    startReceptionTimer();
}

function stopReceptionPlayback() {
    if (receptionPlayer) receptionPlayer.stop();
    freezeReceptionElapsed();
    receptionAccumulatedMs = 0;
    resetReceptionPlaybackButtons();
    setReceptionProgress(0);
    el('rcp-status').textContent = t('reception.statusStopped');
}

function replayReceptionPlayback() {
    startReceptionPlayback();
}

/** Restarts THIS SAME exercise (same seed — replay must not regenerate the answer, and neither does Restart): resets playback, timer, and the student's transcription, but keeps the exercise itself. A brand-new exercise only happens via the explicit "New Exercise" action. */
function restartReceptionExercise() {
    if (!currentReception) return;
    if (receptionPlayer) receptionPlayer.stop();
    freezeReceptionElapsed();
    receptionAccumulatedMs = 0;
    receptionExerciseStartedAt = null;
    el('rcp-answer').value = '';
    resetReceptionPlaybackButtons();
    setReceptionProgress(0);
    el('rcp-status').textContent = t('reception.statusNotStarted');

    const volume = Number(el('rcp-play-volume').value) / 100;
    const p = ensureReceptionPlayer(volume);
    p.setVolume(volume);
    p.loadPlan(currentReception.plan, { durationMs: currentReception.durationMs });
}

async function submitReceptionAnswer() {
    if (!currentReception) return;
    if (receptionPlayer) receptionPlayer.stop();
    freezeReceptionElapsed();

    const submittedAnswer = el('rcp-answer').value;
    const payload = {
        characters: currentReception.characters,
        groupSize: currentReception.groupSize || 0,
        groupCount: currentReception.groupCount,
        wpm: currentReception.timing.wpm,
        farnsworthWpm: currentReception.timing.farnsworthWpm,
        toneFrequencyHz: currentReception.timing.toneFrequencyHz,
        seed: currentReception.seed,
        submittedAnswer,
        durationMs: receptionExerciseStartedAt !== null ? Date.now() - receptionExerciseStartedAt : undefined,
    };

    let result;
    try {
        result = await api('/api/practice/reception/attempts', { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
        showReceptionError(err.message);
        return;
    }

    lastReceptionResult = result;
    renderReceptionResults(result);
    showScreen('reception-results');
}

function renderReceptionResults(result) {
    const { score } = result;
    const timing = currentReception.timing;

    const farnsworthNote = timing.farnsworthWpm !== timing.wpm ? t('common.farnsworthNote', { wpm: timing.farnsworthWpm }) : '';
    el('rcpr-subtitle').textContent = `${score.totalExpected} ${t('common.characters')} · ${timing.wpm} ${t('common.wpmShort')}${farnsworthNote} · ${timing.toneFrequencyHz} Hz`;

    const accuracyEl = el('rcpr-accuracy');
    accuracyEl.textContent = `${score.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (score.accuracyPercent >= 90 ? '' : score.accuracyPercent >= 60 ? ' mid' : ' low');

    const characterGrade = result.characterGrade;
    const gradeEl = el('rcpr-grade');
    gradeEl.textContent = characterGrade ? String(characterGrade.grade) : '—';
    gradeEl.className = 'result-grade-value' + (characterGrade && window.GradingService ? ' ' + window.GradingService.gradeSeverityClass(characterGrade.grade) : '');

    el('rcpr-total').textContent = String(score.totalExpected);
    el('rcpr-correct').textContent = String(score.correctCount);
    el('rcpr-incorrect').textContent = String(score.incorrectCount);
    el('rcpr-missing').textContent = String(score.missingCount);
    el('rcpr-extra').textContent = String(score.extraCount);
    el('rcpr-errors').textContent = String(score.errorCount);

    renderComparison('rcpr-compare', score.ops, result.groupSize || 5);
}

// =======================================================================
// Morse Transmission (keyboard -> Morse)
// =======================================================================
const transmissionPool = createPoolPicker('tx');
let txEngine = null; // MorseTransmitterCore.TransmissionEngine instance, one per exercise
let currentTransmission = null; // server target — text/groups ARE visible (unlike Reception), nothing withheld
let txWpm = 15; // locked in at exercise start, so mid-exercise settings edits (unreachable via UI anyway) can never desync engine vs. submit payload
let txToleranceFactor = 0.35;
let txStartedAt = null; // Date.now() at the first keydown, for the timer + submitted durationMs
let txTimerId = null;
let txKeyPhysicallyDown = false; // guards against the same physical Space key firing keyDown twice before a keyUp (OS auto-repeat)
let lastTransmissionResult = null;

function currentTransmissionSettings() {
    return {
        characters: transmissionPool.getSelected(),
        groupSize: Number(el('tx-setting-group-size').value),
        groupCount: Number(el('tx-setting-group-count').value) || undefined,
        wpm: Number(el('tx-setting-wpm').value) || undefined,
        toleranceFactor: Number(el('tx-setting-tolerance').value) || undefined,
    };
}

function showTransmissionError(message) {
    const box = el('tx-settings-error');
    if (!message) {
        box.hidden = true;
        box.textContent = '';
        return;
    }
    box.hidden = false;
    box.textContent = message;
}

function showTxPlayError(message) {
    const box = el('tx-play-error');
    if (!message) {
        box.hidden = true;
        box.textContent = '';
        return;
    }
    box.hidden = false;
    box.textContent = message;
}

function updateTransmissionLengthSummary() {
    const groupSize = Number(el('tx-setting-group-size').value) || 0;
    const groupCount = Number(el('tx-setting-group-count').value) || 0;
    const total = groupSize > 0 ? groupSize * groupCount : groupCount;
    el('tx-length-summary').textContent = groupSize > 0
        ? `${total} characters total (${groupCount} group${groupCount === 1 ? '' : 's'} of ${groupSize}).`
        : `${total} characters total, ungrouped.`;
}

async function generateTransmission() {
    showTransmissionError('');
    const settings = currentTransmissionSettings();

    if (settings.characters.length === 0) {
        showTransmissionError(t('validation.selectAtLeastOneChar'));
        return;
    }
    if (!settings.wpm || settings.wpm <= 0) {
        showTransmissionError(t('validation.enterValidTargetWpm'));
        return;
    }
    if (!settings.groupCount || settings.groupCount < 1) {
        showTransmissionError(t('validation.enterValidCharGroupCount'));
        return;
    }

    let target;
    try {
        target = await api('/api/practice/transmission/exercises', {
            method: 'POST',
            body: JSON.stringify({ characters: settings.characters, groupSize: settings.groupSize, groupCount: settings.groupCount }),
        });
    } catch (err) {
        showTransmissionError(err.message);
        return;
    }

    currentTransmission = target;
    txWpm = settings.wpm;
    txToleranceFactor = settings.toleranceFactor || 0.35;
    renderTransmissionPlay();
    showScreen('transmission-play');
}

/** (Re)creates the engine for the current target — used both at exercise start and by Restart (same target, fresh engine state). */
function resetTxEngine() {
    txEngine = new MorseTransmitterCore.TransmissionEngine({
        wpm: txWpm,
        toleranceFactor: txToleranceFactor,
        onFeedback: (f) => showTxFeedback(f),
        onCharacterDecoded: () => updateTxLiveDisplay(),
        onSequenceChange: () => updateTxLiveDisplay(),
    });
    txStartedAt = null;
    txKeyPhysicallyDown = false;
    stopTxTimer();
}

function renderTransmissionPlay() {
    showTxPlayError('');
    el('tx-target').textContent = currentTransmission.groups.join('  ');
    el('tx-target-wpm').textContent = String(txWpm);
    el('tx-actual-wpm').textContent = '—';
    el('tx-status').textContent = t('transmission.statusReady');
    el('tx-decoded').textContent = '';
    el('tx-current-morse').innerHTML = '&nbsp;';
    el('tx-feedback').textContent = '';
    el('tx-feedback').className = 'tx-feedback';
    resetTxEngine();
    updateTxProgress();
    const keyArea = el('tx-key-area');
    if (keyArea && typeof keyArea.focus === 'function') keyArea.focus();
}

function updateTxProgress() {
    const decodedCount = txEngine ? txEngine.decodedText.replace(/\s+/g, '').length : 0;
    const total = currentTransmission ? currentTransmission.totalCharacters : 0;
    const elapsedMs = txStartedAt !== null ? Date.now() - txStartedAt : 0;
    el('tx-progress-text').textContent = `${formatMmSs(elapsedMs)} · ${Math.min(decodedCount, total)} / ${total} characters`;
    el('tx-progress-fill').style.width = total > 0 ? `${Math.min(100, Math.round((decodedCount / total) * 100))}%` : '0%';
}

function updateTxLiveDisplay() {
    el('tx-current-morse').textContent = txEngine.currentMorse || ' ';
    el('tx-decoded').textContent = txEngine.decodedText || ' ';
    const stats = txEngine.getStats();
    el('tx-actual-wpm').textContent = stats.actualWpm !== null ? String(stats.actualWpm) : '—';
    updateTxProgress();
}

function showTxFeedback(feedback) {
    const box = el('tx-feedback');
    box.textContent = t(`transmission.fb.${feedback.messageKey}`);
    box.className = 'tx-feedback' + (feedback.verdict === 'correct' ? ' state-correct' : feedback.verdict === 'irregular' ? ' state-warning' : '');
}

function startTxTimer() {
    stopTxTimer();
    txTimerId = setInterval(updateTxProgress, 250);
}

function stopTxTimer() {
    if (txTimerId) {
        clearInterval(txTimerId);
        txTimerId = null;
    }
}

/** Gated to the transmission-play screen only (see onTransmissionKeydown/Keyup) — Space presses on every other screen are completely untouched, so normal typing/scrolling elsewhere is never affected. */
function onTransmissionKeydown(e) {
    if (currentScreen !== 'transmission-play') return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault(); // always, even on OS auto-repeat, so the page never scrolls while keying
    if (txKeyPhysicallyDown) return; // auto-repeat — TransmissionEngine.keyDown() also dedupes this, but skip the state churn entirely
    txKeyPhysicallyDown = true;

    if (txStartedAt === null) {
        txStartedAt = Date.now();
        startTxTimer();
    }
    el('tx-key-area').classList.add('is-pressed');
    el('tx-status').textContent = t('transmission.statusKeyDown');
    txEngine.keyDown(performance.now());
}

function onTransmissionKeyup(e) {
    if (currentScreen !== 'transmission-play') return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!txKeyPhysicallyDown) return;
    e.preventDefault();
    txKeyPhysicallyDown = false;

    el('tx-key-area').classList.remove('is-pressed');
    el('tx-status').textContent = t('transmission.statusWaiting');
    txEngine.keyUp(performance.now());
    updateTxLiveDisplay();
}

/** Restarts THIS SAME target (same seed): resets the engine/timer/displays but keeps the exercise itself — a brand-new target only happens via the explicit "New Exercise" action. */
function restartTransmission() {
    if (!currentTransmission) return;
    renderTransmissionPlay();
}

async function submitTransmissionAnswer() {
    if (!currentTransmission || !txEngine) return;
    showTxPlayError('');
    if (txEngine.elementLog.length === 0 && !txKeyPhysicallyDown) {
        showTxPlayError(t('groupSession.keyAtLeastOne'));
        return;
    }
    if (txKeyPhysicallyDown) {
        // A held key at submit time still has a final press to account for.
        txEngine.keyUp(performance.now());
        txKeyPhysicallyDown = false;
    }
    txEngine.flush();
    stopTxTimer();

    const payload = {
        characters: currentTransmission.characters,
        groupSize: currentTransmission.groupSize || 0,
        groupCount: currentTransmission.groupCount,
        seed: currentTransmission.seed,
        wpm: txWpm,
        toleranceFactor: txToleranceFactor,
        elementLog: txEngine.elementLog,
    };

    let result;
    try {
        result = await api('/api/practice/transmission/attempts', { method: 'POST', body: JSON.stringify(payload) });
    } catch (err) {
        showTxPlayError(err.message);
        return;
    }

    lastTransmissionResult = result;
    renderTransmissionResults(result);
    showScreen('transmission-results');
}

const TIMING_STAT_ROWS = [
    ['transmission.targetWpm', (s) => s.targetWpm],
    ['stats.actualWpm', (s) => (s.actualWpm !== null ? s.actualWpm : '—')],
    ['transmission.avgDotDuration', (s) => (s.avgDotMs !== null ? `${s.avgDotMs} ms` : '—')],
    ['transmission.avgDashDuration', (s) => (s.avgDashMs !== null ? `${s.avgDashMs} ms` : '—')],
    ['transmission.avgCharacterGap', (s) => (s.avgCharacterGapMs !== null ? `${s.avgCharacterGapMs} ms` : '—')],
    ['transmission.avgWordGap', (s) => (s.avgWordGapMs !== null ? `${s.avgWordGapMs} ms` : '—')],
    ['transmission.rhythmConsistency', (s) => (s.rhythmConsistencyPercent !== null ? `${s.rhythmConsistencyPercent}%` : '—')],
    ['transmission.timingErrors', (s) => s.timingErrorCount],
    ['transmission.totalTransmissionTime', (s) => formatMmSs(s.totalDurationMs)],
];

function renderTransmissionResults(result) {
    const { score, stats } = result;

    el('txr-subtitle').textContent = `${score.totalExpected} ${t('common.characters')} · ${t('common.targetUnit')} ${stats.targetWpm} ${t('common.wpmShort')}`;

    const accuracyEl = el('txr-accuracy');
    accuracyEl.textContent = `${score.accuracyPercent}%`;
    accuracyEl.className = 'result-accuracy' + (score.accuracyPercent >= 90 ? '' : score.accuracyPercent >= 60 ? ' mid' : ' low');

    const characterGrade = result.characterGrade;
    const gradeEl = el('txr-grade');
    gradeEl.textContent = characterGrade ? String(characterGrade.grade) : '—';
    gradeEl.className = 'result-grade-value' + (characterGrade && window.GradingService ? ' ' + window.GradingService.gradeSeverityClass(characterGrade.grade) : '');

    el('txr-total').textContent = String(score.totalExpected);
    el('txr-correct').textContent = String(score.correctCount);
    el('txr-incorrect').textContent = String(score.incorrectCount);
    el('txr-missing').textContent = String(score.missingCount);
    el('txr-extra').textContent = String(score.extraCount);
    el('txr-errors').textContent = String(score.errorCount);

    renderComparison('txr-compare', score.ops, result.groupSize || 5);

    const tbody = el('txr-timing-tbody');
    tbody.innerHTML = '';
    TIMING_STAT_ROWS.forEach(([label, get]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${t(label)}</td><td>${get(stats)}</td>`;
        tbody.appendChild(tr);
    });
}

// =======================================================================
// Free Transmission — no target, no grading, nothing saved. A sandbox
// around the exact same TransmissionEngine the graded Exercise mode
// uses, minus everything that makes it an assessment: no target text
// (never generated, never fetched), no server round-trip at all, no
// score/grade. Only WPM/tolerance are read from the settings screen —
// character pool/length don't apply since there's no target to build.
// =======================================================================
let freeTxEngine = null;
let freeTxTimerId = null;
let freeTxAccumulatedMs = 0;
let freeTxSegmentStartedAt = null;
let freeTxKeyPhysicallyDown = false;

function startFreeTransmission() {
    const wpm = Number(el('tx-setting-wpm').value) || 15;
    const toleranceFactor = Number(el('tx-setting-tolerance').value) || 0.35;

    freeTxEngine = new MorseTransmitterCore.TransmissionEngine({
        wpm,
        toleranceFactor,
        onFeedback: (f) => showFreeTxFeedback(f),
        onCharacterDecoded: () => updateFreeTxLiveDisplay(),
        onSequenceChange: () => updateFreeTxLiveDisplay(),
    });
    freeTxAccumulatedMs = 0;
    freeTxSegmentStartedAt = null;
    freeTxKeyPhysicallyDown = false;

    el('txf-status').textContent = t('transmission.statusReadyFree');
    el('txf-elapsed').textContent = '0:00';
    el('txf-actual-wpm').textContent = '—';
    el('txf-rhythm').textContent = '—';
    el('txf-current-morse').innerHTML = '&nbsp;';
    el('txf-decoded').textContent = '';
    el('txf-feedback').textContent = '';
    el('txf-feedback').className = 'tx-feedback';
    el('txf-timing-tbody').innerHTML = '';
    stopFreeTxTimer();

    showScreen('transmission-free');
    const keyArea = el('txf-key-area');
    if (keyArea && typeof keyArea.focus === 'function') keyArea.focus();
}

function clearFreeTransmission() {
    startFreeTransmission();
}

function updateFreeTxLiveDisplay() {
    el('txf-current-morse').textContent = freeTxEngine.currentMorse || ' ';
    el('txf-decoded').textContent = freeTxEngine.decodedText || ' ';
    renderFreeTxStats();
}

function showFreeTxFeedback(feedback) {
    const box = el('txf-feedback');
    box.textContent = t(`transmission.fb.${feedback.messageKey}`);
    box.className = 'tx-feedback' + (feedback.verdict === 'correct' ? ' state-correct' : feedback.verdict === 'irregular' ? ' state-warning' : '');
}

function renderFreeTxStats() {
    const stats = freeTxEngine.getStats();
    el('txf-actual-wpm').textContent = stats.actualWpm !== null ? String(stats.actualWpm) : '—';
    el('txf-rhythm').textContent = stats.rhythmConsistencyPercent !== null ? `${stats.rhythmConsistencyPercent}%` : '—';

    const tbody = el('txf-timing-tbody');
    tbody.innerHTML = '';
    TIMING_STAT_ROWS.forEach(([label, get]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${t(label)}</td><td>${get(stats)}</td>`;
        tbody.appendChild(tr);
    });
}

function startFreeTxTimer() {
    stopFreeTxTimer();
    freeTxSegmentStartedAt = Date.now();
    freeTxTimerId = setInterval(() => {
        const elapsed = freeTxAccumulatedMs + (Date.now() - freeTxSegmentStartedAt);
        el('txf-elapsed').textContent = formatMmSs(elapsed);
    }, 250);
}

function stopFreeTxTimer() {
    if (freeTxTimerId) {
        clearInterval(freeTxTimerId);
        freeTxTimerId = null;
    }
}

// Real-time keying tone for Free Transmission: the shared MorseAudioPlayer's
// live startTone()/stopTone() (no second audio system) — sounds from the
// instant Space goes down until the instant it comes back up.
let freeTxTonePlayer = null;

function ensureFreeTxTonePlayer() {
    if (!freeTxTonePlayer) freeTxTonePlayer = new MorseAudioPlayer({ toneFrequencyHz: 600, volume: 0.5 });
    return freeTxTonePlayer;
}

/** Gated to the Free Transmission screen only — every other screen's Space presses (including the graded Exercise mode) are completely unaffected. */
function onFreeTxKeydown(e) {
    if (currentScreen !== 'transmission-free') return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault(); // always, even on OS auto-repeat, so the page never scrolls
    if (freeTxKeyPhysicallyDown) return; // auto-repeat: never a second, overlapping tone
    freeTxKeyPhysicallyDown = true;

    // A previously clicked button (Clear, Back) must not also be
    // "pressed" by Space — keying owns the Space bar on this screen.
    const focused = document.activeElement;
    if (focused && focused !== document.body && typeof focused.blur === 'function') focused.blur();

    ensureFreeTxTonePlayer().startTone();
    if (freeTxSegmentStartedAt === null) startFreeTxTimer();
    el('txf-key-area').classList.add('is-pressed');
    el('txf-status').textContent = t('transmission.statusKeyDown');
    freeTxEngine.keyDown(performance.now());
}

function onFreeTxKeyup(e) {
    if (currentScreen !== 'transmission-free') return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (!freeTxKeyPhysicallyDown) return;
    e.preventDefault();
    releaseFreeTxKey();
}

/** Key-up bookkeeping, shared by the real keyup and by the safety release (window blur / tab hidden / leaving the screen) when a keyup would otherwise never arrive. */
function releaseFreeTxKey() {
    if (!freeTxKeyPhysicallyDown) return;
    freeTxKeyPhysicallyDown = false;
    if (freeTxTonePlayer) freeTxTonePlayer.stopTone();

    el('txf-key-area').classList.remove('is-pressed');
    el('txf-status').textContent = t('transmission.statusTransmittingFree');
    freeTxEngine.keyUp(performance.now());
    updateFreeTxLiveDisplay();
}

/** Leave hook for the session screen: stops audio and invalidates any in-flight round so navigating away never lets a stray callback act on the next screen. */
function abortCharacterTrainingRound() {
    ctRoundToken += 1;
    ctAwaitingAnswer = false;
    clearCtAidHighlightTimeouts();
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
        showRadiogramError(t('validation.couldNotLoadCharsets', { message: err.message }));
        showCtSettingsError(t('validation.couldNotLoadCharsets', { message: err.message }));
        showReceptionError(t('validation.couldNotLoadCharsets', { message: err.message }));
        showTransmissionError(t('validation.couldNotLoadCharsets', { message: err.message }));
    }

    // Hub navigation
    el('hub-card-radiogram').addEventListener('click', () => showScreen('radiogram-settings'));
    el('hub-card-character-training').addEventListener('click', () => showScreen('character-training-settings'));
    el('hub-card-reception').addEventListener('click', () => showScreen('reception-settings'));
    el('hub-card-transmission').addEventListener('click', () => showScreen('transmission-settings'));

    document.querySelectorAll('.back-link[data-back-to]').forEach((btn) => {
        btn.addEventListener('click', () => showScreen(btn.dataset.backTo));
    });

    // Character pool controls (shared picker, one instance per screen)
    radiogramPool.wireEvents('pool-quick-actions');
    characterTrainingPool.wireEvents('ct-pool-quick-actions');
    el('learned-apply-button').addEventListener('click', () => {
        radiogramPool.applyLearnedPreset(Number(el('learned-count').value));
    });
    if (window.SpeedProgression) {
        window.SpeedProgression.renderSpeedProgressionChips('speed-progression', (wpm) => {
            el('setting-wpm').value = wpm;
        });
    }

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
    el('ct-learned-apply-button').addEventListener('click', () => {
        characterTrainingPool.applyLearnedPreset(Number(el('ct-learned-count').value));
    });
    if (window.SpeedProgression) {
        window.SpeedProgression.renderSpeedProgressionChips('ct-speed-progression', (wpm) => {
            el('ct-setting-wpm').value = wpm;
        });
    }
    el('ct-start-button').addEventListener('click', startCharacterTrainingSession);
    el('ctr-practice-again-button').addEventListener('click', startCharacterTrainingSession);
    el('ctr-practice-weak-button').addEventListener('click', practiceWeakCharacters);

    // Character Training gameplay: one global keydown listener, gated by
    // screen + awaiting-answer state rather than added/removed per round.
    document.addEventListener('keydown', onGlobalKeydown);

    // Reception Training settings
    receptionPool.wireEvents('rcp-pool-quick-actions');
    el('rcp-learned-apply-button').addEventListener('click', () => {
        receptionPool.applyLearnedPreset(Number(el('rcp-learned-count').value));
    });
    if (window.SpeedProgression) {
        window.SpeedProgression.renderSpeedProgressionChips('rcp-speed-progression', (wpm) => {
            el('rcp-setting-wpm').value = wpm;
        });
    }
    document.querySelectorAll('#rcp-length-quick-actions .chip-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            el('rcp-setting-group-count').value = btn.dataset.groups;
            updateReceptionLengthSummary();
        });
    });
    el('rcp-setting-group-size').addEventListener('input', updateReceptionLengthSummary);
    el('rcp-setting-group-count').addEventListener('input', updateReceptionLengthSummary);
    updateReceptionLengthSummary();
    el('rcp-start-button').addEventListener('click', generateReception);

    // Reception Training playback
    el('rcp-play-button').addEventListener('click', startReceptionPlayback);
    el('rcp-pause-button').addEventListener('click', pauseReceptionPlayback);
    el('rcp-resume-button').addEventListener('click', resumeReceptionPlayback);
    el('rcp-stop-button').addEventListener('click', stopReceptionPlayback);
    el('rcp-replay-button').addEventListener('click', replayReceptionPlayback);
    el('rcp-restart-button').addEventListener('click', restartReceptionExercise);
    el('rcp-play-volume').addEventListener('input', () => {
        if (receptionPlayer) receptionPlayer.setVolume(Number(el('rcp-play-volume').value) / 100);
    });
    el('rcp-generate-another-button').addEventListener('click', generateReception);
    el('rcp-submit-button').addEventListener('click', submitReceptionAnswer);

    // Reception Training results
    el('rcpr-generate-another-button').addEventListener('click', generateReception);

    // Morse Transmission settings
    transmissionPool.wireEvents('tx-pool-quick-actions');
    el('tx-learned-apply-button').addEventListener('click', () => {
        transmissionPool.applyLearnedPreset(Number(el('tx-learned-count').value));
    });
    if (window.SpeedProgression) {
        window.SpeedProgression.renderSpeedProgressionChips('tx-speed-progression', (wpm) => {
            el('tx-setting-wpm').value = wpm;
        });
    }
    document.querySelectorAll('#tx-length-quick-actions .chip-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            el('tx-setting-group-count').value = btn.dataset.groups;
            updateTransmissionLengthSummary();
        });
    });
    el('tx-setting-group-size').addEventListener('input', updateTransmissionLengthSummary);
    el('tx-setting-group-count').addEventListener('input', updateTransmissionLengthSummary);
    updateTransmissionLengthSummary();
    el('tx-start-button').addEventListener('click', generateTransmission);

    // Morse Transmission keying: Space keydown/keyup, gated to the
    // transmission-play screen only (see onTransmissionKeydown) so every
    // other screen's normal keyboard/typing behavior is untouched.
    document.addEventListener('keydown', onTransmissionKeydown);
    document.addEventListener('keyup', onTransmissionKeyup);
    el('tx-restart-button').addEventListener('click', restartTransmission);
    el('tx-generate-another-button').addEventListener('click', generateTransmission);
    el('tx-submit-button').addEventListener('click', submitTransmissionAnswer);

    // Morse Transmission results
    el('txr-generate-another-button').addEventListener('click', generateTransmission);

    // Free Transmission (no target, no grading)
    el('tx-free-start-button').addEventListener('click', startFreeTransmission);
    el('txf-clear-button').addEventListener('click', clearFreeTransmission);
    document.addEventListener('keydown', onFreeTxKeydown);
    document.addEventListener('keyup', onFreeTxKeyup);
    // A keyup that happens while the window isn't focused never reaches
    // us — release the key (and silence the tone) instead of leaving it
    // sounding forever.
    window.addEventListener('blur', releaseFreeTxKey);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseFreeTxKey();
    });

    showScreen('hub');
}

init();
