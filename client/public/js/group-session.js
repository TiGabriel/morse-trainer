async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            // Classroom PCs are often shared between students — clear the
            // "which session am I in" marker so the next person to log in
            // here doesn't get auto-rejoined into somebody else's session.
            sessionStorage.removeItem('gs_joined_session_id');
            window.location.href = '/';
        }
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
    ['list', 'waiting', 'exercise', 'finished'].forEach((s) => {
        el(`screen-${s}`).hidden = s !== name;
    });
    syncAnswerReveal();
}

/**
 * Publishes the current item's authoritative answer to the hidden P-O-O-U
 * reveal popup (see nav.js) — or clears it — whenever this changes. Reuses
 * only data already legitimately in this script's own memory:
 *
 *   - Formal Test AND Group Practice: the server includes expectedAnswer
 *     directly on `currentItem` once that item goes live (see
 *     publicItemPayload's includeAnswer, item_active-only — never on the
 *     earlier scheduled_start) — the same authoritative, pre-generated
 *     item every connected student's client already holds in memory for
 *     the item on screen, so it's read straight off currentItem here.
 *     Before the item goes live, nothing is shown.
 *   - Fallback: a graded Group Practice attempt response also carries
 *     expectedAnswer (captured into lastRevealedAnswer by submitAnswer).
 *
 * Never calls the server itself and never shows anything for any item
 * other than the one currently on screen.
 */
function syncAnswerReveal() {
    if (!window.AnswerReveal) return;
    if (el('screen-exercise').hidden || !currentItem) {
        window.AnswerReveal.clear();
        return;
    }

    const modeLabel = MODE_LABELS[currentItem.mode] || currentItem.mode;

    if (currentItem.expectedAnswer) {
        window.AnswerReveal.publish({ label: modeLabel, answer: currentItem.expectedAnswer });
        return;
    }

    if (hasSubmittedCurrentItem && lastRevealedItemId === currentItem.itemId && lastRevealedAnswer) {
        window.AnswerReveal.publish({ label: modeLabel, answer: lastRevealedAnswer });
        return;
    }

    window.AnswerReveal.publish({ label: modeLabel, answer: t('groupSession.correctAnswerUnavailable') });
}

let toastTimer = null;
function showToast(message, type = 'default') {
    const t = el('toast');
    t.textContent = message;
    t.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        t.hidden = true;
    }, 4000);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
}

const MODE_LABELS = {
    get audio_to_text() { return t('groupSession.modeAudioToText'); },
    get morse_to_text() { return t('groupSession.modeMorseToText'); },
    get text_to_morse() { return t('groupSession.modeTextToMorse'); },
    get character_recognition() { return t('groupSession.modeCharacterRecognition'); },
    get transmission() { return t('groupSession.modeTransmission'); },
};

let currentUser = null;
let ws = null;
let joinedSessionId = null;
let latestSessionState = null; // last {session, roster} broadcast
let player = null;

// Clock-offset estimation (see sessionRuntime.js on the server for the
// matching half of this): serverNow ≈ Date.now() + clockOffsetMs. Uses
// clock-sync.js's pure helpers, fed by a small burst of ping/pong
// round trips rather than a single sample (see recordOffsetSample).
let clockOffsetMs = 0;
let offsetSamples = [];
const MAX_OFFSET_SAMPLES = 5;

let currentItem = null; // the item payload from scheduled_start / item_active
let currentItemIndex = null;
let itemsTotal = null;
let scheduledStartAt = null; // future SERVER timestamp for this item's playback
let itemDeadlineAt = null; // future SERVER timestamp when the answer window closes
let itemActivatedAt = null; // local Date.now() when this item became answerable, for durationMs
let hasSubmittedCurrentItem = false;
let hasPlayedCurrentItem = false; // whether audio has actually played in THIS browser instance for the current item
let countdownTimer = null;

// See syncAnswerReveal(): the only place this client ever legitimately
// learns an expected answer (a graded Group Practice item's own attempt
// response) is captured here, keyed by itemId so it can never be shown
// against a *different* item the moment the next one starts.
let lastRevealedItemId = null;
let lastRevealedAnswer = null;

// Morse Transmission: one TransmissionEngine per item (recreated the
// moment the item is revealed — see prepareItemDisplay), and Space-key
// state so the global keydown/keyup listeners below never double-fire on
// OS auto-repeat. Reuses the exact same engine Individual Training's
// Transmission mode uses — see morse-transmitter-core.js.
let gsTxEngine = null;
let gsTxKeyPhysicallyDown = false;

function ensurePlayer() {
    if (!player) {
        player = new MorseAudioPlayer({ volume: 0.7, maxPlays: null });
    }
    return player;
}

function estimatedServerNow() {
    return Date.now() + clockOffsetMs;
}

/** Records one ping/pong round trip's offset estimate and folds it into a rolling median. */
function recordOffsetSample(clientSentAt, serverTime, clientReceivedAt) {
    const { offsetMs } = ClockSync.estimateOffsetFromPong(clientSentAt, serverTime, clientReceivedAt);
    offsetSamples.push(offsetMs);
    if (offsetSamples.length > MAX_OFFSET_SAMPLES) offsetSamples.shift();
    clockOffsetMs = ClockSync.medianOffset(offsetSamples);
}

/** A short burst (not just one round trip) so one slow/blocked sample can't skew the estimate. */
function sendPingBurst(count = 3, spacingMs = 80) {
    for (let i = 0; i < count; i += 1) {
        setTimeout(() => send({ type: 'ping', clientTime: Date.now() }), i * spacingMs);
    }
}

// ---------------------------------------------------------------------
// Available-sessions list
// ---------------------------------------------------------------------
async function loadAvailableSessions() {
    if (!currentUser.classId) {
        el('no-class-notice').hidden = false;
        el('sessions-list').innerHTML = '';
        return;
    }
    try {
        const { sessions } = await api('/api/sessions/available');
        renderSessionsList(sessions);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderSessionsList(sessions) {
    const container = el('sessions-list');
    if (sessions.length === 0) {
        container.innerHTML = `<p class="muted">${escapeHtml(t('groupSession.noOpenSessions'))}</p>`;
        return;
    }
    container.innerHTML = '';
    sessions.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'gs-session-card';
        const typeLabel = s.type === 'test' ? t('groupSession.formalTest') : t('groupSession.groupPractice');
        card.innerHTML = `
            <div class="gs-session-card-info">
                <strong>${typeLabel} &middot; ${MODE_LABELS[s.exerciseMode] || s.exerciseMode}</strong>
                <span class="muted">${escapeHtml(s.difficulty || '—')} &middot; ${s.exerciseCount} ${escapeHtml(t('groupSession.itemsUnit'))} &middot; <span class="badge status-${s.status}">${s.status}</span></span>
            </div>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-small';
        btn.textContent = t('groupSession.joinSession');
        btn.addEventListener('click', () => joinSession(s.id));
        card.appendChild(btn);
        container.appendChild(card);
    });
}

// ---------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------
function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendJoin(sessionId) {
    send({ type: 'join_session', sessionId });
}

function connectWs(onOpenCb) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        if (onOpenCb) onOpenCb();
        return;
    }
    if (ws) {
        ws.onclose = null;
        ws.close();
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.addEventListener('open', () => {
        el('connection-banner').hidden = true;
        offsetSamples = [];
        sendPingBurst();
        if (onOpenCb) onOpenCb();
    });
    ws.addEventListener('message', handleWsMessage);
    ws.addEventListener('close', () => {
        // Auto-reconnect for a dropped/flaky LAN link, as long as we're
        // still supposed to be in a session — resyncs from server state
        // once reconnected rather than trusting anything cached locally.
        // Visible so a student isn't left staring at a frozen countdown
        // with no idea their connection actually dropped.
        if (joinedSessionId) {
            el('connection-banner').hidden = false;
            setTimeout(() => {
                if (joinedSessionId) connectWs(() => sendJoin(joinedSessionId));
            }, 2000);
        }
    });
}

function handleWsMessage(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
        case 'pong':
            recordOffsetSample(msg.clientTime, msg.serverTime, Date.now());
            break;
        case 'session_state':
            onSessionState(msg);
            break;
        case 'scheduled_start':
            onScheduledStart(msg);
            break;
        case 'item_active':
            onItemActive(msg);
            break;
        case 'item_closed':
            onItemClosed();
            break;
        case 'session_finished':
            onSessionFinished();
            break;
        case 'error':
            showToast(msg.error, 'error');
            // If we never got any state at all for a session we tried to
            // join/reconnect to, the join itself failed — fall back to the list
            // instead of leaving the student stuck on a blank waiting screen.
            if (joinedSessionId && !latestSessionState) leaveSession();
            break;
        default:
            break;
    }
}

// ---------------------------------------------------------------------
// Join / leave
// ---------------------------------------------------------------------
function joinSession(sessionId) {
    joinedSessionId = sessionId;
    latestSessionState = null;
    currentItem = null;
    currentItemIndex = null;
    hasSubmittedCurrentItem = false;
    hasPlayedCurrentItem = false;
    sessionStorage.setItem('gs_joined_session_id', String(sessionId));

    showScreen('waiting');
    el('waiting-config').textContent = t('groupSession.loadingSession');
    connectWs(() => sendJoin(sessionId));
}

function leaveSession() {
    joinedSessionId = null;
    sessionStorage.removeItem('gs_joined_session_id');
    clearInterval(countdownTimer);
    el('connection-banner').hidden = true;
    if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
    }
    showScreen('list');
    loadAvailableSessions();
}

// ---------------------------------------------------------------------
// session_state — waiting room / terminal states
// ---------------------------------------------------------------------
function onSessionState(msg) {
    if (!joinedSessionId || msg.session.id !== joinedSessionId) return;
    latestSessionState = msg;

    if (msg.session.status === 'cancelled') {
        showToast(t('groupSession.sessionCancelledToast'), 'error');
        leaveSession();
        return;
    }
    if (msg.session.status === 'finished') {
        showFinishedScreen();
        return;
    }
    // For 'waiting', render the waiting room. For 'running'/'paused' the
    // server already sent (or will send) scheduled_start/item_active as
    // part of the join-time resync — session_state itself just keeps the
    // roster/ready-count fresh, so it's safe to also refresh the waiting
    // room's counts even if we're mid-item (they're simply not shown then).
    if (el('screen-waiting').hidden === false || msg.session.status === 'waiting') {
        renderWaitingRoom(msg.session, msg.roster);
    }
}

function renderWaitingRoom(session, roster) {
    showScreen('waiting');
    const modeLabel = MODE_LABELS[session.exerciseMode] || session.exerciseMode;
    const typeLabel = session.type === 'test' ? t('groupSession.formalTest') : t('groupSession.groupPractice');
    el('waiting-config').textContent = `${typeLabel} · ${modeLabel} · ${session.difficulty || ''} · ${session.exerciseCount} ${t('groupSession.itemsUnit')}`;

    const badge = el('waiting-status-badge');
    badge.textContent = t('groupSession.sessionStatus' + session.status.charAt(0).toUpperCase() + session.status.slice(1));
    badge.className = `badge status-${session.status}`;

    const readyCount = roster.filter((r) => r.isReady).length;
    const connectedCount = roster.filter((r) => r.connectionStatus === 'connected').length;
    el('waiting-ready-count').textContent = t('groupSession.readyCount', { ready: readyCount, connected: connectedCount, total: roster.length });

    const instructionsBox = el('waiting-instructions-box');
    if (session.instructions) {
        instructionsBox.hidden = false;
        el('waiting-instructions').textContent = session.instructions;
    } else {
        instructionsBox.hidden = true;
    }

    const me = roster.find((r) => r.studentId === currentUser.id);
    const isReady = !!(me && me.isReady);
    const btn = el('ready-toggle-button');
    btn.textContent = isReady ? t('groupSession.notReady') : t('groupSession.imReady');
    btn.className = 'btn btn-large ' + (isReady ? 'btn-secondary' : 'btn-primary');
}

// ---------------------------------------------------------------------
// Exercise: scheduled countdown -> synchronized playback -> answer window
// ---------------------------------------------------------------------
function onScheduledStart(msg) {
    currentItem = msg.item;
    currentItemIndex = msg.itemIndex;
    itemsTotal = msg.itemsTotal;
    scheduledStartAt = msg.startAt;
    itemDeadlineAt = null;
    hasSubmittedCurrentItem = false;
    hasPlayedCurrentItem = false;

    // Refresh the clock-offset estimate right before it's actually used —
    // the freshest possible reading for the instant that matters most,
    // rather than relying solely on whatever was measured at connect time
    // (which could be seconds or minutes earlier for a student who joined
    // the waiting room early).
    sendPingBurst();

    showScreen('exercise');
    el('exercise-item-progress').textContent = t('groupSession.itemProgress', { current: msg.itemIndex + 1, total: itemsTotal });
    el('exercise-feedback').hidden = true;
    el('exercise-answer').value = '';
    el('exercise-answer').disabled = true;
    el('exercise-submit-button').disabled = true;
    el('exercise-countdown-banner').hidden = false;
    el('exercise-countdown-banner').textContent = t('groupSession.getReady');

    prepareItemDisplay(currentItem, { reveal: false });
    startCountdownLoop();
}

function onItemActive(msg) {
    // A resync (fresh join mid-item, or a reconnect) never went through
    // our own onScheduledStart countdown in this browser instance, so
    // nothing has played here yet — that must not be confused with
    // "already played" just because some other student's audio finished.
    const isResync = currentItemIndex !== msg.itemIndex || currentItem === null;
    if (isResync) hasPlayedCurrentItem = false;

    if (msg.item) currentItem = msg.item;
    currentItemIndex = msg.itemIndex;
    if (msg.itemsTotal) itemsTotal = msg.itemsTotal;
    // NOTE: scheduledStartAt is deliberately left untouched here (it is
    // NOT reset to null). item_active arrives at essentially the same
    // instant the local countdown independently reaches zero — nulling
    // this out used to silently race against the countdown loop's own
    // 150ms tick and could suppress the local play() trigger entirely if
    // this message happened to win the race, which on a fast LAN it
    // reliably did. hasPlayedCurrentItem (not scheduledStartAt) is what
    // now prevents re-triggering, so it's safe to leave this set.
    itemDeadlineAt = msg.deadlineAt;
    itemActivatedAt = Date.now();

    showScreen('exercise');
    el('exercise-item-progress').textContent = t('groupSession.itemProgress', { current: msg.itemIndex + 1, total: itemsTotal || '?' });
    el('exercise-feedback').hidden = true;
    el('exercise-countdown-banner').hidden = true;

    if (msg.item) {
        // Either the normal activation (right after our own countdown
        // reached zero) or a reconnect resync straight into an
        // already-playing item — either way, make sure audio/prompt state
        // actually matches what the server says is active right now.
        prepareItemDisplay(currentItem, { reveal: true });

        const needsAudio = currentItem.mode === 'audio_to_text' || currentItem.mode === 'character_recognition';
        if (isResync && needsAudio) {
            // Browser autoplay restrictions mean the server activating the
            // item is not enough on a genuine resync — there was no user
            // gesture at this exact moment, so audio cannot auto-play
            // here. Make the manual control clearly available and
            // clearly labeled rather than leaving the student staring at
            // a silent screen. (A normal, non-resync activation is
            // instead auto-played by the countdown loop below, driven by
            // the student's own earlier "I'm Ready" gesture.)
            const btn = el('exercise-replay-button');
            btn.hidden = false;
            btn.textContent = t('groupSession.play');
            el('exercise-feedback').hidden = false;
            el('exercise-feedback').textContent = t('groupSession.itemAlreadyPlaying');
            hasPlayedCurrentItem = true;
        }
    }

    if (!hasSubmittedCurrentItem) {
        el('exercise-answer').disabled = false;
        el('exercise-submit-button').disabled = false;
        el('exercise-answer').focus();
    }
    startCountdownLoop();
}

function onItemClosed() {
    clearInterval(countdownTimer);
    el('exercise-answer').disabled = true;
    el('exercise-submit-button').disabled = true;
    el('exercise-countdown').textContent = t('groupSession.timeUp');
    gsTxKeyPhysicallyDown = false;
    if (!hasSubmittedCurrentItem) {
        el('exercise-feedback').hidden = false;
        el('exercise-feedback').textContent = t('groupSession.timesUpNoAnswer');
    }
}

function onSessionFinished() {
    clearInterval(countdownTimer);
    if (player) player.stop();
    showFinishedScreen();
}

/** Renders the pre-start (masked) or post-start (revealed) prompt for the current item's mode. */
function prepareItemDisplay(item, { reveal }) {
    const audioControls = el('exercise-audio-controls');
    const textPrompt = el('exercise-text-prompt');
    const needsAudio = item.mode === 'audio_to_text' || item.mode === 'character_recognition';
    const isTransmission = item.mode === 'transmission';
    audioControls.hidden = !needsAudio;
    textPrompt.hidden = needsAudio;
    el('exercise-replay-button').hidden = true;

    if (needsAudio) {
        const p = ensurePlayer();
        if (item.toneFrequencyHz) p.toneFrequencyHz = item.toneFrequencyHz;
        p.loadPlan(item.plan, { durationMs: item.durationMs });
    } else if (item.mode === 'morse_to_text') {
        textPrompt.textContent = reveal ? item.promptMorse : '•••';
    } else if (item.mode === 'text_to_morse' || isTransmission) {
        // Same masking discipline as every other mode: the target is
        // already in this client's memory (sent unconditionally, since
        // it isn't the graded "answer" the way expectedAnswer is — see
        // sessionRuntime.js's publicItemPayload), but the UI still hides
        // it with '•••' until the item is genuinely active, so there is
        // no early reading/prep time before the clock starts.
        textPrompt.textContent = reveal ? item.promptText : '•••';
    }

    // Morse Transmission uses its own Space-bar keying panel instead of
    // the plain text input every other mode types into.
    el('exercise-transmission-panel').hidden = !isTransmission;
    el('exercise-answer-field').hidden = isTransmission;
    if (isTransmission && reveal) {
        // A fresh engine per reveal — covers both the normal
        // countdown->active transition and a resync straight into an
        // already-active item, exactly like beginScheduledPlayback's
        // audio-play/prompt-reveal already does for other modes.
        gsTxEngine = new MorseTransmitterCore.TransmissionEngine({
            wpm: item.wpm,
            toleranceFactor: item.toleranceFactor,
            onFeedback: (f) => showGsTxFeedback(f),
            onCharacterDecoded: () => updateGsTxLiveDisplay(),
            onSequenceChange: () => updateGsTxLiveDisplay(),
        });
        gsTxKeyPhysicallyDown = false;
        el('gs-tx-current-morse').innerHTML = '&nbsp;';
        el('gs-tx-decoded').textContent = '';
        el('gs-tx-feedback').textContent = '';
        el('gs-tx-feedback').className = 'tx-feedback';
    }

    const answerLabel = el('exercise-answer-label');
    const answerInput = el('exercise-answer');
    if (item.mode === 'text_to_morse') {
        answerLabel.textContent = t('groupSession.yourAnswerMorseHint');
        answerInput.removeAttribute('maxlength');
    } else if (item.mode === 'character_recognition') {
        answerLabel.textContent = t('groupSession.whichCharacterHeard');
        answerInput.maxLength = 1;
    } else {
        answerLabel.textContent = t('groupSession.yourAnswer');
        answerInput.removeAttribute('maxlength');
    }
}

function updateGsTxLiveDisplay() {
    el('gs-tx-current-morse').textContent = gsTxEngine.currentMorse || ' ';
    el('gs-tx-decoded').textContent = gsTxEngine.decodedText || ' ';
}

function showGsTxFeedback(feedback) {
    const box = el('gs-tx-feedback');
    box.textContent = t(`transmission.fb.${feedback.messageKey}`);
    box.className = 'tx-feedback' + (feedback.verdict === 'correct' ? ' state-correct' : feedback.verdict === 'irregular' ? ' state-warning' : '');
}

/** Gated to an active, unsubmitted Transmission item only — every other screen's Space presses (including every other exercise mode) are completely untouched. */
function onGsTransmissionKeydown(e) {
    if (el('screen-exercise').hidden || !currentItem || currentItem.mode !== 'transmission') return;
    if (!gsTxEngine || itemDeadlineAt === null || hasSubmittedCurrentItem) return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    if (gsTxKeyPhysicallyDown) return;
    gsTxKeyPhysicallyDown = true;
    gsTxEngine.keyDown(performance.now());
}

function onGsTransmissionKeyup(e) {
    if (el('screen-exercise').hidden || !currentItem || currentItem.mode !== 'transmission') return;
    if (!gsTxEngine || !gsTxKeyPhysicallyDown) return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    gsTxKeyPhysicallyDown = false;
    gsTxEngine.keyUp(performance.now());
    updateGsTxLiveDisplay();
}

/** Triggers local playback/reveal once our own corrected clock reaches the server's scheduled instant — never on message arrival. */
function beginScheduledPlayback() {
    hasPlayedCurrentItem = true;
    const needsAudio = currentItem.mode === 'audio_to_text' || currentItem.mode === 'character_recognition';
    if (needsAudio) {
        ensurePlayer().play();
        const btn = el('exercise-replay-button');
        btn.hidden = false;
        btn.textContent = '↻ ' + t('groupSession.replay');
    } else {
        prepareItemDisplay(currentItem, { reveal: true });
    }
}

function startCountdownLoop() {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
        const now = estimatedServerNow();

        // Whether to start playback is checked every tick using
        // hasPlayedCurrentItem as the sole guard against re-triggering —
        // deliberately NOT gated on itemDeadlineAt being unset. The
        // server's item_active broadcast (which sets itemDeadlineAt)
        // arrives at essentially the same instant this countdown
        // independently reaches zero; if this check were skipped just
        // because itemDeadlineAt had already become known, a fast
        // low-latency client (ironically, the *best*-synchronized ones)
        // could have its item_active message win that race and silently
        // suppress the local play() trigger entirely.
        if (scheduledStartAt !== null && !hasPlayedCurrentItem) {
            const remaining = scheduledStartAt - now;
            if (remaining > 0) {
                el('exercise-countdown').textContent = t('groupSession.startingIn', { seconds: (remaining / 1000).toFixed(1) });
            } else {
                el('exercise-countdown-banner').hidden = true;
                beginScheduledPlayback();
                el('exercise-countdown').textContent = t('groupSession.playingStatus');
            }
        }

        if (itemDeadlineAt !== null && hasPlayedCurrentItem) {
            const remaining = itemDeadlineAt - now;
            if (remaining > 0) {
                el('exercise-countdown').textContent = t('groupSession.timeLeft', { seconds: Math.ceil(remaining / 1000) });
            } else {
                el('exercise-countdown').textContent = t('groupSession.timeUp');
                clearInterval(countdownTimer);
            }
        }
    }, 150);
}

async function submitAnswer() {
    if (hasSubmittedCurrentItem || !currentItem) return;

    let submittedAnswer;
    if (currentItem.mode === 'transmission') {
        if (!gsTxEngine) return;
        if (gsTxKeyPhysicallyDown) {
            gsTxEngine.keyUp(performance.now()); // account for a still-held key at submit time
            gsTxKeyPhysicallyDown = false;
        }
        gsTxEngine.flush();
        if (gsTxEngine.elementLog.length === 0) {
            showToast(t('groupSession.keyAtLeastOne'), 'error');
            return;
        }
        submittedAnswer = JSON.stringify(gsTxEngine.elementLog);
    } else {
        submittedAnswer = el('exercise-answer').value;
        if (!submittedAnswer) return;
    }

    const durationMs = itemActivatedAt ? Date.now() - itemActivatedAt : undefined;
    try {
        const result = await api(`/api/sessions/${joinedSessionId}/items/${currentItem.itemId}/attempts`, {
            method: 'POST',
            body: JSON.stringify({ submittedAnswer, durationMs }),
        });
        hasSubmittedCurrentItem = true;
        el('exercise-answer').disabled = true;
        el('exercise-submit-button').disabled = true;
        el('exercise-feedback').hidden = false;
        if (result.score) {
            lastRevealedItemId = currentItem.itemId;
            lastRevealedAnswer = result.expectedAnswer;
            const markNote = result.characterGrade ? t('groupSession.markLabel', { grade: result.characterGrade.grade }) : '';
            el('exercise-feedback').textContent = t('groupSession.submittedAccuracy', { percent: result.score.accuracyPercent }) + markNote + t('groupSession.correctAnswerLabel', { answer: result.expectedAnswer });
        } else {
            el('exercise-feedback').textContent = t('groupSession.answerSubmittedPending');
        }
        syncAnswerReveal();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ---------------------------------------------------------------------
// Finished screen
// ---------------------------------------------------------------------
async function showFinishedScreen() {
    showScreen('finished');
    const isTest = latestSessionState && latestSessionState.session.type === 'test';
    el('finished-subtitle').textContent = isTest
        ? t('groupSession.testSubmittedForGrading')
        : t('groupSession.niceWorkResults');

    try {
        const { results } = await api(`/api/sessions/${joinedSessionId}/results`);
        renderFinishedResults(results);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

/** Renders the centralized 4-10 school grade (see grading.js) as a small badge, or an em dash if this item has no grade yet. */
function renderMarkBadge(characterGrade) {
    if (!characterGrade) return '—';
    const cls = window.GradingService ? window.GradingService.gradeBadgeClass(characterGrade.grade) : 'badge-grade-mid';
    return `<span class="badge ${cls}">${characterGrade.grade}</span>`;
}

function renderFinishedResults(results) {
    const tbody = el('finished-results-tbody');
    if (results.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(t('groupSession.noResults'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    results.forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${r.orderIndex + 1}</td>
            <td>${escapeHtml(r.transmittedText || r.submittedText || '—')}</td>
            <td>${r.score !== undefined && r.score !== null ? r.score + '%' : '—'}</td>
            <td>${r.grade || '—'}</td>
            <td>${renderMarkBadge(r.characterGrade)}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------
async function init() {
    try {
        const { user } = await api('/api/auth/me');
        if (user.role !== 'student') {
            window.location.href = '/';
            return;
        }
        currentUser = user;
        el('user-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();
    } catch {
        window.location.href = '/';
        return;
    }

    el('auth-gate').hidden = true;
    el('app').hidden = false;

    el('refresh-list-button').addEventListener('click', loadAvailableSessions);
    el('leave-waiting-button').addEventListener('click', leaveSession);
    el('finished-back-button').addEventListener('click', leaveSession);

    el('ready-toggle-button').addEventListener('click', () => {
        // The click that marks readiness also unlocks the AudioContext —
        // this is the user gesture the browser's autoplay policy requires,
        // ahead of the later scheduled (non-gesture) playback trigger.
        ensurePlayer().unlock().catch(() => {});
        const me = latestSessionState && latestSessionState.roster.find((r) => r.studentId === currentUser.id);
        send({ type: 'set_ready', ready: !(me && me.isReady) });
    });

    el('exercise-replay-button').addEventListener('click', () => {
        ensurePlayer().play();
        hasPlayedCurrentItem = true;
        el('exercise-replay-button').textContent = '↻ Replay';
    });
    el('exercise-submit-button').addEventListener('click', submitAnswer);
    el('exercise-answer').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAnswer();
    });
    // Morse Transmission keying — gated inside the handlers themselves to
    // an active, unsubmitted Transmission item only (see
    // onGsTransmissionKeydown), so every other mode/screen's Space
    // presses are completely unaffected.
    document.addEventListener('keydown', onGsTransmissionKeydown);
    document.addEventListener('keyup', onGsTransmissionKeyup);

    const storedSessionId = sessionStorage.getItem('gs_joined_session_id');
    if (storedSessionId) {
        joinedSessionId = Number(storedSessionId);
        showScreen('waiting');
        el('waiting-config').textContent = t('groupSession.reconnecting');
        connectWs(() => sendJoin(joinedSessionId));
    } else {
        showScreen('list');
    }

    await loadAvailableSessions();
    setInterval(() => {
        if (!el('screen-list').hidden) loadAvailableSessions();
    }, 10000);
}

init();
