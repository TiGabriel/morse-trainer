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
let ws = null;
let monitoredSessionId = null;

// ---------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    classesCache = classes.filter((c) => c.isActive);
    const select = el('new-class');
    select.innerHTML = classesCache.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
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
        tr.innerHTML = `
            <td>${escapeHtml(s.className || '—')}</td>
            <td>${MODE_LABELS[s.exerciseMode] || s.exerciseMode}</td>
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

async function createSession(e) {
    e.preventDefault();
    el('create-error').hidden = true;

    const body = {
        classId: Number(el('new-class').value),
        exerciseMode: el('new-mode').value,
        difficulty: el('new-difficulty').value,
        wpm: el('new-wpm').value || undefined,
        exerciseCount: Number(el('new-count').value),
    };

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
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No students in this class yet.</td></tr>';
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
