async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
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
    ['list', 'waiting', 'exercise', 'finished'].forEach((s) => {
        el(`screen-${s}`).hidden = s !== name;
    });
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
    audio_to_text: 'Audio → Text',
    morse_to_text: 'Morse → Text',
    text_to_morse: 'Text → Morse',
    character_recognition: 'Character Recognition',
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
        container.innerHTML = '<p class="muted">No open sessions right now. Check back once your teacher opens one.</p>';
        return;
    }
    container.innerHTML = '';
    sessions.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'gs-session-card';
        const typeLabel = s.type === 'test' ? 'Formal Test' : 'Group Practice';
        card.innerHTML = `
            <div class="gs-session-card-info">
                <strong>${typeLabel} &middot; ${MODE_LABELS[s.exerciseMode] || s.exerciseMode}</strong>
                <span class="muted">${escapeHtml(s.difficulty || '—')} &middot; ${s.exerciseCount} item(s) &middot; <span class="badge status-${s.status}">${s.status}</span></span>
            </div>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-small';
        btn.textContent = 'Join';
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
        offsetSamples = [];
        sendPingBurst();
        if (onOpenCb) onOpenCb();
    });
    ws.addEventListener('message', handleWsMessage);
    ws.addEventListener('close', () => {
        // Auto-reconnect for a dropped/flaky LAN link, as long as we're
        // still supposed to be in a session — resyncs from server state
        // once reconnected rather than trusting anything cached locally.
        if (joinedSessionId) {
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
    el('waiting-config').textContent = 'Loading session…';
    connectWs(() => sendJoin(sessionId));
}

function leaveSession() {
    joinedSessionId = null;
    sessionStorage.removeItem('gs_joined_session_id');
    clearInterval(countdownTimer);
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
        showToast('This session was cancelled by your teacher.', 'error');
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
    const typeLabel = session.type === 'test' ? 'Formal Test' : 'Group Practice';
    el('waiting-config').textContent = `${typeLabel} · ${modeLabel} · ${session.difficulty || ''} · ${session.exerciseCount} item(s)`;

    const badge = el('waiting-status-badge');
    badge.textContent = session.status;
    badge.className = `badge status-${session.status}`;

    const readyCount = roster.filter((r) => r.isReady).length;
    const connectedCount = roster.filter((r) => r.connectionStatus === 'connected').length;
    el('waiting-ready-count').textContent = `${readyCount} ready · ${connectedCount} connected of ${roster.length} in class`;

    const me = roster.find((r) => r.studentId === currentUser.id);
    const isReady = !!(me && me.isReady);
    const btn = el('ready-toggle-button');
    btn.textContent = isReady ? 'Not Ready' : "I'm Ready";
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
    el('exercise-item-progress').textContent = `Item ${msg.itemIndex + 1} of ${itemsTotal}`;
    el('exercise-feedback').hidden = true;
    el('exercise-answer').value = '';
    el('exercise-answer').disabled = true;
    el('exercise-submit-button').disabled = true;
    el('exercise-countdown-banner').hidden = false;
    el('exercise-countdown-banner').textContent = 'Get ready…';

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
    el('exercise-item-progress').textContent = `Item ${msg.itemIndex + 1} of ${itemsTotal || '?'}`;
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
            btn.textContent = '▶ Play';
            el('exercise-feedback').hidden = false;
            el('exercise-feedback').textContent = 'This item is already playing for the class — press Play to hear it.';
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
    el('exercise-countdown').textContent = 'Time up';
    if (!hasSubmittedCurrentItem) {
        el('exercise-feedback').hidden = false;
        el('exercise-feedback').textContent = "Time's up — no answer was recorded for this item.";
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
    audioControls.hidden = !needsAudio;
    textPrompt.hidden = needsAudio;
    el('exercise-replay-button').hidden = true;

    if (needsAudio) {
        ensurePlayer().loadPlan(item.plan, { durationMs: item.durationMs });
    } else if (item.mode === 'morse_to_text') {
        textPrompt.textContent = reveal ? item.promptMorse : '•••';
    } else if (item.mode === 'text_to_morse') {
        textPrompt.textContent = reveal ? item.promptText : '•••';
    }

    const answerLabel = el('exercise-answer-label');
    const answerInput = el('exercise-answer');
    if (item.mode === 'text_to_morse') {
        answerLabel.textContent = 'Your answer (Morse: use . and - , space between letters)';
        answerInput.removeAttribute('maxlength');
    } else if (item.mode === 'character_recognition') {
        answerLabel.textContent = 'Which character did you hear?';
        answerInput.maxLength = 1;
    } else {
        answerLabel.textContent = 'Your answer';
        answerInput.removeAttribute('maxlength');
    }
}

/** Triggers local playback/reveal once our own corrected clock reaches the server's scheduled instant — never on message arrival. */
function beginScheduledPlayback() {
    hasPlayedCurrentItem = true;
    const needsAudio = currentItem.mode === 'audio_to_text' || currentItem.mode === 'character_recognition';
    if (needsAudio) {
        ensurePlayer().play();
        const btn = el('exercise-replay-button');
        btn.hidden = false;
        btn.textContent = '↻ Replay';
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
                el('exercise-countdown').textContent = `Starting in ${(remaining / 1000).toFixed(1)}s`;
            } else {
                el('exercise-countdown-banner').hidden = true;
                beginScheduledPlayback();
                el('exercise-countdown').textContent = 'Playing…';
            }
        }

        if (itemDeadlineAt !== null && hasPlayedCurrentItem) {
            const remaining = itemDeadlineAt - now;
            if (remaining > 0) {
                el('exercise-countdown').textContent = `Time left: ${Math.ceil(remaining / 1000)}s`;
            } else {
                el('exercise-countdown').textContent = 'Time up';
                clearInterval(countdownTimer);
            }
        }
    }, 150);
}

async function submitAnswer() {
    if (hasSubmittedCurrentItem || !currentItem) return;
    const submittedAnswer = el('exercise-answer').value;
    if (!submittedAnswer) return;

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
            el('exercise-feedback').textContent = `Submitted — accuracy ${result.score.accuracyPercent}%. Correct answer: ${result.expectedAnswer}`;
        } else {
            el('exercise-feedback').textContent = 'Answer submitted. Results will be available once the test ends.';
        }
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
        ? 'Your test has been submitted for grading.'
        : 'Nice work — here is how you did.';

    try {
        const { results } = await api(`/api/sessions/${joinedSessionId}/results`);
        renderFinishedResults(results);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderFinishedResults(results) {
    const tbody = el('finished-results-tbody');
    if (results.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No results.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    results.forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${r.orderIndex + 1}</td>
            <td>${escapeHtml(r.submittedText || '—')}</td>
            <td>${r.score !== undefined && r.score !== null ? r.score + '%' : '—'}</td>
            <td>${r.grade || '—'}</td>
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

    const storedSessionId = sessionStorage.getItem('gs_joined_session_id');
    if (storedSessionId) {
        joinedSessionId = Number(storedSessionId);
        showScreen('waiting');
        el('waiting-config').textContent = 'Reconnecting…';
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
