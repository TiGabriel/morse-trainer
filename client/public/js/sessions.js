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

let toastTimer = null;
function showToast(message, type = 'default') {
    const t = el('toast');
    t.textContent = message;
    t.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

const MODE_LABELS = {
    audio_to_text: 'Audio → Text',
    morse_to_text: 'Morse → Text',
    text_to_morse: 'Text → Morse',
    character_recognition: 'Character Recognition',
};

let classesCache = [];
let studentsInSelectedClass = [];
let ws = null;
let monitoredSessionId = null;
let currentSessionType = 'group';
// itemIndex -> Set of studentIds who have submitted, reset each time a new item is scheduled.
let progressByItem = new Map();
let currentItemIndex = null;
let currentItemsTotal = null;

// ---------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    classesCache = classes.filter((c) => c.isActive);
    const select = el('new-class');
    select.innerHTML = classesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    await loadParticipantsForSelectedClass();
}

// ---------------------------------------------------------------------
// Participant selection (defaults to "everyone in the class")
// ---------------------------------------------------------------------
async function loadParticipantsForSelectedClass() {
    const classId = el('new-class').value;
    const container = el('participants-list');
    if (!classId) {
        container.innerHTML = '<span class="muted">Select a class to choose participants&hellip;</span>';
        studentsInSelectedClass = [];
        return;
    }
    try {
        const { users } = await api(`/api/users?role=student&classId=${classId}&status=active`);
        studentsInSelectedClass = users;
        if (users.length === 0) {
            container.innerHTML = '<span class="muted">No active students in this class yet.</span>';
            return;
        }
        container.innerHTML = users
            .map((u) => {
                const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
                return `
                    <label class="participant-checkbox">
                        <input type="checkbox" class="participant-check" value="${u.id}" checked />
                        ${escapeHtml(name)}
                    </label>
                `;
            })
            .join('');
    } catch (err) {
        container.innerHTML = `<span class="muted">Could not load students: ${escapeHtml(err.message)}</span>`;
    }
}

/** Returns null (meaning "everyone in the class", the default) unless the teacher has explicitly narrowed the selection. */
function getSelectedParticipantIds() {
    const checkboxes = Array.from(document.querySelectorAll('.participant-check'));
    if (checkboxes.length === 0) return undefined;
    const checked = checkboxes.filter((cb) => cb.checked).map((cb) => Number(cb.value));
    if (checked.length === checkboxes.length) return undefined; // everyone selected = no restriction
    return checked;
}

async function loadSessions() {
    const { sessions } = await api('/api/sessions');
    const tbody = el('sessions-tbody');
    if (sessions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">No sessions yet. Create one above.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    sessions.forEach((s) => {
        const tr = document.createElement('tr');
        const typeLabel = s.type === 'test' ? 'Formal Test' : 'Group Practice';
        tr.innerHTML = `
            <td>${escapeHtml(s.className || '—')}</td>
            <td>${typeLabel} &middot; ${MODE_LABELS[s.exerciseMode] || s.exerciseMode}</td>
            <td>${escapeHtml(s.difficulty || '—')}</td>
            <td>${s.wpm || '—'}</td>
            <td>${s.exerciseCount}</td>
            <td><span class="badge status-${s.status}">${s.status}</span></td>
            <td class="col-actions"></td>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-small';
        btn.textContent = 'Monitor';
        btn.addEventListener('click', () => openMonitor(s.id));
        tr.querySelector('.col-actions').appendChild(btn);
        tbody.appendChild(tr);
    });
}

function updateTestSettingsVisibility() {
    const isTest = el('new-type').value === 'test';
    el('test-settings').hidden = !isTest;
}

async function createSession(e) {
    e.preventDefault();
    el('create-error').hidden = true;

    const type = el('new-type').value;
    const body = {
        type,
        classId: Number(el('new-class').value),
        exerciseMode: el('new-mode').value,
        difficulty: el('new-difficulty').value,
        wpm: el('new-wpm').value || undefined,
        farnsworthWpm: el('new-farnsworth').value || undefined,
        toneFrequencyHz: el('new-tone').value || undefined,
        length: el('new-length').value || undefined,
        exerciseCount: Number(el('new-count').value),
        instructions: el('new-instructions').value.trim() || undefined,
        participantIds: getSelectedParticipantIds(),
    };
    if (type === 'test') {
        body.prepTimeMs = Number(el('new-prep-time').value) * 1000;
        body.answerTimeMs = Number(el('new-answer-time').value) * 1000;
        body.allowedAttempts = Number(el('new-allowed-attempts').value);
        body.passThresholdPercent = el('new-pass-threshold').value === '' ? undefined : Number(el('new-pass-threshold').value);
    }

    try {
        const { session } = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
        showToast('Session created.', 'success');
        await loadSessions();
        openMonitor(session.id);
    } catch (err) {
        el('create-error').textContent = err.message;
        el('create-error').hidden = false;
    }
}

// ---------------------------------------------------------------------
// Monitor view
// ---------------------------------------------------------------------
function showView(name) {
    el('view-list').hidden = name !== 'list';
    el('view-monitor').hidden = name !== 'monitor';
}

function openMonitor(sessionId) {
    monitoredSessionId = sessionId;
    progressByItem = new Map();
    currentItemIndex = null;
    currentItemsTotal = null;
    el('progress-panel').hidden = true;
    el('results-panel').hidden = true;
    showView('monitor');
    connectWebSocket(sessionId);
}

function closeMonitor() {
    if (ws) {
        ws.close();
        ws = null;
    }
    monitoredSessionId = null;
    showView('list');
    loadSessions();
}

function renderProgress() {
    if (currentItemIndex === null) return;
    el('progress-panel').hidden = false;
    const submittedCount = (progressByItem.get(currentItemIndex) || new Set()).size;
    const total = currentItemsTotal !== null ? currentItemsTotal : '?';
    el('progress-summary').textContent =
        `Item ${currentItemIndex + 1} of ${total} — ${submittedCount} submission(s) so far`;
}

async function loadResults(sessionId) {
    try {
        const { results } = await api(`/api/sessions/${sessionId}/results`);
        el('results-panel').hidden = false;
        const tbody = el('results-tbody');
        if (results.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="muted">No results yet.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        results.forEach((r) => {
            const tr = document.createElement('tr');
            const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username;
            tr.innerHTML = `
                <td>${r.orderIndex + 1}</td>
                <td>${escapeHtml(name)}</td>
                <td>${escapeHtml(r.submittedText || '—')}</td>
                <td>${r.attemptCount}</td>
                <td>${r.score !== null && r.score !== undefined ? r.score + '%' : '—'}</td>
                <td>${r.grade ? `<span class="badge status-${r.grade === 'pass' ? 'running' : 'cancelled'}">${r.grade}</span>` : '—'}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function connectWebSocket(sessionId) {
    if (ws) ws.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'monitor_session', sessionId }));
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session_state') {
            renderMonitor(msg.session, msg.roster);
            currentSessionType = msg.session.type;
            if (msg.session.status === 'finished') loadResults(sessionId);
        } else if (msg.type === 'scheduled_start') {
            currentItemIndex = msg.itemIndex;
            currentItemsTotal = msg.itemsTotal;
            progressByItem.set(msg.itemIndex, new Set());
            renderProgress();
            showToast(`Item ${msg.itemIndex + 1} of ${msg.itemsTotal} starting shortly…`);
        } else if (msg.type === 'item_active') {
            currentItemIndex = msg.itemIndex;
            renderProgress();
        } else if (msg.type === 'progress_update') {
            if (!progressByItem.has(msg.itemIndex)) progressByItem.set(msg.itemIndex, new Set());
            progressByItem.get(msg.itemIndex).add(msg.studentId);
            renderProgress();
        } else if (msg.type === 'item_closed') {
            renderProgress();
        } else if (msg.type === 'session_finished') {
            showToast('Session finished.', 'success');
            loadResults(sessionId);
        } else if (msg.type === 'error') {
            showToast(msg.error, 'error');
        }
    });

    ws.addEventListener('close', () => {
        // Simple auto-reconnect for flaky Wi-Fi: try again shortly if
        // we're still supposed to be monitoring this session.
        if (monitoredSessionId === sessionId) {
            setTimeout(() => {
                if (monitoredSessionId === sessionId) connectWebSocket(sessionId);
            }, 2000);
        }
    });
}

function renderMonitor(session, roster) {
    el('monitor-title').textContent = `Session #${session.id}`;
    const badge = el('monitor-status-badge');
    badge.textContent = session.status;
    badge.className = `badge status-${session.status}`;

    el('monitor-class').textContent = session.className || '—';
    el('monitor-mode').textContent = MODE_LABELS[session.exerciseMode] || session.exerciseMode;
    el('monitor-difficulty').textContent = session.difficulty || '—';
    el('monitor-wpm').textContent = session.wpm || '(difficulty default)';
    el('monitor-count').textContent = session.exerciseCount;

    const connectedCount = roster.filter((r) => r.connectionStatus === 'connected').length;
    el('monitor-connected').textContent = `${connectedCount} / ${roster.length}`;

    const isRestricted = Array.isArray(session.participantIds) && session.participantIds.length > 0;
    el('monitor-participants-label').hidden = !isRestricted;
    el('monitor-participants').hidden = !isRestricted;
    if (isRestricted) {
        el('monitor-participants').textContent = `${session.participantIds.length} selected student(s) (not the whole class)`;
    }

    const instructionsBox = el('monitor-instructions-box');
    if (session.instructions) {
        instructionsBox.hidden = false;
        el('monitor-instructions').textContent = session.instructions;
    } else {
        instructionsBox.hidden = true;
    }

    const buttonVisibility = {
        created: ['btn-open', 'btn-cancel'],
        waiting: ['btn-start', 'btn-cancel'],
        running: ['btn-pause', 'btn-stop'],
        paused: ['btn-resume', 'btn-stop', 'btn-cancel'],
        finished: [],
        cancelled: [],
    };
    const visible = buttonVisibility[session.status] || [];
    ['btn-open', 'btn-start', 'btn-pause', 'btn-resume', 'btn-stop', 'btn-cancel'].forEach((id) => {
        el(id).hidden = !visible.includes(id);
    });

    const tbody = el('roster-tbody');
    if (roster.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="muted">No students in this class yet.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    roster.forEach((r) => {
        const tr = document.createElement('tr');
        const name = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.username;
        tr.innerHTML = `
            <td>${escapeHtml(r.rank || '—')}</td>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(r.className || '—')}</td>
            <td class="connection-${r.connectionStatus}">${r.connectionStatus === 'connected' ? '● Connected' : '○ Disconnected'}</td>
            <td>${r.isReady ? '✓ Ready' : '—'}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function sendTransition(action) {
    try {
        await api(`/api/sessions/${monitoredSessionId}/${action}`, { method: 'POST' });
        // The WS broadcast will update the view; no need to re-fetch.
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
}

// ---------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------
async function init() {
    let user;
    try {
        ({ user } = await api('/api/auth/me'));
        if (user.role !== 'teacher') {
            window.location.href = '/';
            return;
        }
    } catch {
        window.location.href = '/';
        return;
    }

    el('auth-gate').hidden = true;
    el('dashboard').hidden = false;
    el('teacher-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();

    el('logout-button').addEventListener('click', async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        window.location.href = '/';
    });

    el('create-form').addEventListener('submit', createSession);
    el('new-type').addEventListener('change', updateTestSettingsVisibility);
    updateTestSettingsVisibility();
    el('new-class').addEventListener('change', loadParticipantsForSelectedClass);
    el('participants-toggle-all').addEventListener('click', () => {
        const checkboxes = Array.from(document.querySelectorAll('.participant-check'));
        const allChecked = checkboxes.every((cb) => cb.checked);
        checkboxes.forEach((cb) => {
            cb.checked = !allChecked;
        });
    });
    el('back-to-list-button').addEventListener('click', closeMonitor);

    el('btn-open').addEventListener('click', () => sendTransition('open'));
    el('btn-start').addEventListener('click', () => sendTransition('start'));
    el('btn-pause').addEventListener('click', () => sendTransition('pause'));
    el('btn-resume').addEventListener('click', () => sendTransition('resume'));
    el('btn-stop').addEventListener('click', () => sendTransition('stop'));
    el('btn-cancel').addEventListener('click', () => {
        if (confirm('Cancel this session? This cannot be undone.')) sendTransition('cancel');
    });

    await loadClasses();
    await loadSessions();
}

init();
