async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
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
    get audio_to_text() { return t('groupSession.modeAudioToText'); },
    get morse_to_text() { return t('groupSession.modeMorseToText'); },
    get text_to_morse() { return t('groupSession.modeTextToMorse'); },
    get character_recognition() { return t('groupSession.modeCharacterRecognition'); },
    get transmission() { return t('groupSession.modeTransmission'); },
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
// New Session wizard (Step 1: type -> Step 2: class -> Step 3: exercise
// type -> Step 4: settings). Each step is its own <div class="wizard-step">
// in the DOM (see sessions.html); showing/hiding them is the only thing
// that has changed here — the underlying session-creation request body
// and createSession() logic are unchanged from before the wizard existed.
// ---------------------------------------------------------------------
const WIZARD_STEPS = ['type', 'class', 'mode', 'settings'];
let wizardType = null;
let wizardClassId = null;
let wizardMode = null;
const groupSessionPool = createPoolPicker('gs');

function goToWizardStep(step) {
    WIZARD_STEPS.forEach((s) => {
        el(`wizard-step-${s}`).hidden = s !== step;
    });
}

function selectWizardType(type) {
    wizardType = type;
    document.querySelectorAll('[data-select-type]').forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.selectType === type);
    });
    updateTestSettingsVisibility();
    goToWizardStep('class');
}

function renderWizardClassList() {
    const container = el('wizard-class-list');
    if (classesCache.length === 0) {
        container.innerHTML = `<span class="muted">${escapeHtml(t('sessions.noActiveClasses'))}</span>`;
        return;
    }
    container.innerHTML = classesCache
        .map((c) => `<button type="button" class="wizard-class-button" data-class-id="${c.id}">${escapeHtml(c.name)}</button>`)
        .join('');
    container.querySelectorAll('.wizard-class-button').forEach((btn) => {
        btn.addEventListener('click', () => selectWizardClass(Number(btn.dataset.classId)));
    });
}

async function selectWizardClass(classId) {
    wizardClassId = classId;
    document.querySelectorAll('.wizard-class-button').forEach((btn) => {
        btn.classList.toggle('is-selected', Number(btn.dataset.classId) === classId);
    });
    await loadParticipantsForSelectedClass();
    goToWizardStep('mode');
}

function selectWizardMode(mode) {
    wizardMode = mode;
    document.querySelectorAll('[data-select-mode]').forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.selectMode === mode);
    });
    renderWizardSettingsStep();
    goToWizardStep('settings');
}

/** Populates the Step 4 summary line and shows/hides settings that don't apply to the selected exercise type. */
function renderWizardSettingsStep() {
    const cls = classesCache.find((c) => c.id === wizardClassId);
    const typeLabel = wizardType === 'test' ? t('groupSession.formalTest') : t('groupSession.groupPractice');
    el('wizard-summary').textContent = `${typeLabel} · ${cls ? cls.name : '—'} · ${MODE_LABELS[wizardMode] || wizardMode}`;

    // A radiogram (audio_to_text) is always the fixed 3x10x4/120-character
    // shape (see server sessionEngine.buildRadiogramExercise) — item
    // length is not configurable for it, so hide the field entirely
    // rather than show a control that's silently ignored.
    el('new-length-field').hidden = wizardMode === 'audio_to_text';

    // Timing tolerance (dot/dash/gap classification forgiveness) only
    // applies to Transmission — every other mode has no Space-bar keying
    // to classify.
    el('new-tolerance-field').hidden = wizardMode !== 'transmission';
}

function resetWizard() {
    wizardType = null;
    wizardClassId = null;
    wizardMode = null;
    document.querySelectorAll('[data-select-type], [data-select-mode], .wizard-class-button').forEach((btn) => {
        btn.classList.remove('is-selected');
    });
    el('create-form').reset();
    el('create-error').hidden = true;
    groupSessionPool.applyPreset('clear');
    goToWizardStep('type');
}

// ---------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    classesCache = classes.filter((c) => c.isActive);
    renderWizardClassList();
    await loadParticipantsForSelectedClass();
}

// ---------------------------------------------------------------------
// Participant selection (defaults to "everyone in the class")
// ---------------------------------------------------------------------
async function loadParticipantsForSelectedClass() {
    const classId = wizardClassId;
    const container = el('participants-list');
    if (!classId) {
        container.innerHTML = `<span class="muted">${escapeHtml(t('sessions.selectClassFirst'))}</span>`;
        studentsInSelectedClass = [];
        return;
    }
    try {
        const { users } = await api(`/api/users?role=student&classId=${classId}&status=active`);
        studentsInSelectedClass = users;
        if (users.length === 0) {
            container.innerHTML = `<span class="muted">${escapeHtml(t('sessions.noActiveStudents'))}</span>`;
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
        container.innerHTML = `<span class="muted">${escapeHtml(t('sessions.couldNotLoadStudents'))}: ${escapeHtml(err.message)}</span>`;
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
        tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(t('sessions.noSessionsYet'))}</td></tr>`;
        return;
    }
    tbody.innerHTML = '';
    sessions.forEach((s) => {
        const tr = document.createElement('tr');
        const typeLabel = s.type === 'test' ? t('groupSession.formalTest') : t('groupSession.groupPractice');
        tr.innerHTML = `
            <td>${escapeHtml(s.className || '—')}</td>
            <td>${typeLabel} &middot; ${MODE_LABELS[s.exerciseMode] || s.exerciseMode}</td>
            <td>${escapeHtml(s.difficulty || '—')}</td>
            <td>${s.wpm || '—'}</td>
            <td>${s.exerciseCount}</td>
            <td><span class="badge status-${s.status}">${t('groupSession.sessionStatus' + s.status.charAt(0).toUpperCase() + s.status.slice(1))}</span></td>
            <td class="col-actions"></td>
        `;
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-small';
        btn.textContent = t('sessions.monitorBtn');
        btn.addEventListener('click', () => openMonitor(s.id));
        tr.querySelector('.col-actions').appendChild(btn);
        tbody.appendChild(tr);
    });
}

function updateTestSettingsVisibility() {
    el('test-settings').hidden = wizardType !== 'test';
}

async function createSession(e) {
    e.preventDefault();
    el('create-error').hidden = true;

    const type = wizardType;
    const body = {
        type,
        classId: wizardClassId,
        exerciseMode: wizardMode,
        difficulty: el('new-difficulty').value,
        wpm: el('new-wpm').value || undefined,
        farnsworthWpm: el('new-farnsworth').value || undefined,
        toneFrequencyHz: el('new-tone').value || undefined,
        toleranceFactor: el('new-tolerance').value || undefined,
        length: el('new-length').value || undefined,
        exerciseCount: Number(el('new-count').value),
        instructions: el('new-instructions').value.trim() || undefined,
        participantIds: getSelectedParticipantIds(),
        // Optional teacher-picked character pool (Individual Training's
        // own picker component, reused as-is — see character-pool.js).
        // Empty means "no override", so the backend falls back to the
        // difficulty preset's own pool exactly as before this existed.
        characters: groupSessionPool.getSelected(),
    };
    if (type === 'test') {
        body.prepTimeMs = Number(el('new-prep-time').value) * 1000;
        body.answerTimeMs = Number(el('new-answer-time').value) * 1000;
        body.allowedAttempts = Number(el('new-allowed-attempts').value);
        body.passThresholdPercent = el('new-pass-threshold').value === '' ? undefined : Number(el('new-pass-threshold').value);
    }

    try {
        const { session } = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
        showToast(t('sessions.createdToast'), 'success');
        resetWizard();
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
    el('monitor-connection-banner').hidden = true;
    showView('list');
    loadSessions();
}

function renderProgress() {
    if (currentItemIndex === null) return;
    el('progress-panel').hidden = false;
    const submittedCount = (progressByItem.get(currentItemIndex) || new Set()).size;
    const total = currentItemsTotal !== null ? currentItemsTotal : '?';
    el('progress-summary').textContent = t('sessions.progressSummary', { current: currentItemIndex + 1, total, count: submittedCount });
}

/** Renders the centralized 4-10 school grade (see grading.js) as a small badge, or an em dash if this item has no grade yet. */
function renderMarkBadge(characterGrade) {
    if (!characterGrade) return '—';
    const cls = window.GradingService ? window.GradingService.gradeBadgeClass(characterGrade.grade) : 'badge-grade-mid';
    return `<span class="badge ${cls}">${characterGrade.grade}</span>`;
}

/** One row's worth of the per-exercise detail table (Item/Correct Answer/Student Answer/Attempts/Score/Grade/Mark). */
function renderResultDetailRow(r) {
    const correctAnswerCell =
        r.expectedAnswer !== null && r.expectedAnswer !== undefined
            ? `<span class="result-answer result-answer-correct">${escapeHtml(r.expectedAnswer)}</span>`
            : `<span class="result-answer-unavailable">${escapeHtml(t('sessions.originalUnavailable'))}</span>`;
    return `
        <tr>
            <td>${r.orderIndex + 1}</td>
            <td>${correctAnswerCell}</td>
            <td><span class="result-answer">${escapeHtml(r.submittedText || '—')}</span></td>
            <td>${r.attemptCount}</td>
            <td>${r.score !== null && r.score !== undefined ? r.score + '%' : '—'}</td>
            <td>${r.grade ? `<span class="badge status-${r.grade === 'pass' ? 'running' : 'cancelled'}">${r.grade === 'pass' ? t('sessions.pass') : t('sessions.fail')}</span>` : '—'}</td>
            <td>${renderMarkBadge(r.characterGrade)}</td>
        </tr>
    `;
}

/**
 * A student's overall accuracy (mean of their scored items), grade
 * (fail if any item failed, pass if every graded item passed, null if
 * the session has no grading configured), and mark — the centralized
 * 4-10 school grade (see grading.js), averaged across every item that
 * has one and rounded to the nearest whole grade. `grade` (pass/fail)
 * and `mark` (4-10) are two unrelated concepts that happen to summarize
 * the same rows.
 */
function summarizeStudentResults(rows) {
    const scored = rows.filter((r) => r.score !== null && r.score !== undefined);
    const accuracy = scored.length > 0 ? scored.reduce((sum, r) => sum + r.score, 0) / scored.length : null;
    const grades = rows.map((r) => r.grade).filter(Boolean);
    const grade = grades.length === 0 ? null : grades.includes('fail') ? 'fail' : 'pass';

    const marks = rows.map((r) => r.characterGrade && r.characterGrade.grade).filter((g) => g !== null && g !== undefined);
    const mark = marks.length > 0 ? Math.round(marks.reduce((sum, g) => sum + g, 0) / marks.length) : null;

    return { accuracy, grade, mark };
}

/**
 * One collapsed summary row per student (accuracy% + grade only), each
 * expandable on click into the full per-exercise breakdown — kept as a
 * second <tr> with a nested table rather than a separate panel, so the
 * existing .data-table styling/behavior (hover, badges, etc.) applies to
 * both levels for free.
 */
async function loadResults(sessionId) {
    try {
        const { results } = await api(`/api/sessions/${sessionId}/results`);
        el('results-panel').hidden = false;
        const tbody = el('results-tbody');
        if (results.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(t('sessions.noResultsYet'))}</td></tr>`;
            return;
        }

        const byStudent = new Map();
        results.forEach((r) => {
            if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
            byStudent.get(r.studentId).push(r);
        });

        tbody.innerHTML = '';
        byStudent.forEach((rows) => {
            const first = rows[0];
            const name = [first.firstName, first.lastName].filter(Boolean).join(' ') || first.username;
            const { accuracy, grade, mark } = summarizeStudentResults(rows);

            const summaryRow = document.createElement('tr');
            summaryRow.className = 'clickable-row';
            summaryRow.setAttribute('aria-expanded', 'false');
            summaryRow.innerHTML = `
                <td class="results-toggle-icon">&#9656;</td>
                <td>${escapeHtml(name)}</td>
                <td>${accuracy !== null ? accuracy.toFixed(2) + '%' : '—'}</td>
                <td>${grade ? `<span class="badge status-${grade === 'pass' ? 'running' : 'cancelled'}">${grade === 'pass' ? t('sessions.pass') : t('sessions.fail')}</span>` : '—'}</td>
                <td>${mark !== null ? renderMarkBadge({ grade: mark }) : '—'}</td>
            `;

            const detailRow = document.createElement('tr');
            detailRow.className = 'results-detail-row';
            detailRow.hidden = true;
            const detailBody = rows
                .slice()
                .sort((a, b) => a.orderIndex - b.orderIndex)
                .map(renderResultDetailRow)
                .join('');
            detailRow.innerHTML = `
                <td colspan="5" class="results-detail-cell">
                    <table class="data-table results-detail-table">
                        <thead>
                            <tr><th>${t('groupSession.item')}</th><th>${t('sessions.correctAnswerCol')}</th><th>${t('sessions.studentAnswerCol')}</th><th>${t('sessions.attempts')}</th><th>${t('common.score')}</th><th>${t('common.grade')}</th><th>${t('groupSession.mark')}</th></tr>
                        </thead>
                        <tbody>${detailBody}</tbody>
                    </table>
                </td>
            `;

            summaryRow.addEventListener('click', () => {
                const willShow = detailRow.hidden;
                detailRow.hidden = !willShow;
                summaryRow.setAttribute('aria-expanded', String(willShow));
                summaryRow.querySelector('.results-toggle-icon').innerHTML = willShow ? '&#9662;' : '&#9656;';
            });

            tbody.appendChild(summaryRow);
            tbody.appendChild(detailRow);
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
        el('monitor-connection-banner').hidden = true;
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
            showToast(t('sessions.itemStartingShortly', { current: msg.itemIndex + 1, total: msg.itemsTotal }));
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
            showToast(t('sessions.sessionFinishedToast'), 'success');
            loadResults(sessionId);
        } else if (msg.type === 'error') {
            showToast(msg.error, 'error');
        }
    });

    ws.addEventListener('close', () => {
        // Simple auto-reconnect for flaky Wi-Fi: try again shortly if
        // we're still supposed to be monitoring this session. Visible so
        // the teacher doesn't mistake a stale roster/progress view for
        // "nothing is happening" during the drop.
        if (monitoredSessionId === sessionId) {
            el('monitor-connection-banner').hidden = false;
            setTimeout(() => {
                if (monitoredSessionId === sessionId) connectWebSocket(sessionId);
            }, 2000);
        }
    });
}

function renderMonitor(session, roster) {
    el('monitor-title').textContent = `${t('sessions.sessionWord')} #${session.id}`;
    const badge = el('monitor-status-badge');
    badge.textContent = t('groupSession.sessionStatus' + session.status.charAt(0).toUpperCase() + session.status.slice(1));
    badge.className = `badge status-${session.status}`;

    el('monitor-class').textContent = session.className || '—';
    el('monitor-mode').textContent = MODE_LABELS[session.exerciseMode] || session.exerciseMode;
    el('monitor-difficulty').textContent = session.difficulty || '—';
    el('monitor-wpm').textContent = session.wpm || t('sessions.difficultyDefault');
    el('monitor-count').textContent = session.exerciseCount;

    const connectedCount = roster.filter((r) => r.connectionStatus === 'connected').length;
    el('monitor-connected').textContent = `${connectedCount} / ${roster.length}`;

    const isRestricted = Array.isArray(session.participantIds) && session.participantIds.length > 0;
    el('monitor-participants-label').hidden = !isRestricted;
    el('monitor-participants').hidden = !isRestricted;
    if (isRestricted) {
        el('monitor-participants').textContent = t('sessions.selectedStudentsNote', { count: session.participantIds.length });
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
        tbody.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(t('sessions.noStudentsInClass'))}</td></tr>`;
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
            <td class="connection-${r.connectionStatus}">${r.connectionStatus === 'connected' ? '● ' + t('sessions.connectedWord') : '○ ' + t('sessions.disconnectedWord')}</td>
            <td>${r.isReady ? '✓ ' + t('sessions.ready') : '—'}</td>
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
    if (window.ScrollReveal) window.ScrollReveal.observe('#view-list .reveal-on-scroll');

    el('create-form').addEventListener('submit', createSession);
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
        if (confirm(t('sessions.confirmCancel'))) sendTransition('cancel');
    });

    // Wizard: Step 1 (type) and Step 3 (mode) are both click-to-select,
    // click-to-advance circles; Step 2 (class) buttons are wired once
    // classesCache is loaded (see renderWizardClassList). Back buttons
    // just show the previous step — none of them clear wizard state, so
    // changing an earlier choice never forces the teacher to redo a step
    // they'd already gotten right.
    document.querySelectorAll('[data-select-type]').forEach((btn) => {
        btn.addEventListener('click', () => selectWizardType(btn.dataset.selectType));
    });
    document.querySelectorAll('[data-select-mode]').forEach((btn) => {
        btn.addEventListener('click', () => selectWizardMode(btn.dataset.selectMode));
    });
    document.querySelectorAll('[data-wizard-back]').forEach((btn) => {
        btn.addEventListener('click', () => goToWizardStep(btn.dataset.wizardBack));
    });

    // Group Session's character-pool picker — same shared component/data
    // shape as Individual Training's (see character-pool.js), left with
    // nothing pre-selected so "no override" (difficulty preset governs
    // the pool, as before) is the actual default state, not just the
    // visual one.
    const charsets = await api('/api/practice/charsets');
    groupSessionPool.buildAllGrids(charsets);
    groupSessionPool.wireEvents('gs-pool-quick-actions');

    // "My Sessions" collapses by default so the wizard stays the visual
    // focus — see .collapsible-panel/.collapsible-body in styles.css.
    const mySessionsPanel = el('my-sessions-panel');
    const mySessionsToggle = el('my-sessions-toggle');
    mySessionsToggle.addEventListener('click', () => {
        const expanded = mySessionsPanel.dataset.expanded === 'true';
        mySessionsPanel.dataset.expanded = String(!expanded);
        mySessionsToggle.setAttribute('aria-expanded', String(!expanded));
    });

    goToWizardStep('type');
    await loadClasses();
    await loadSessions();

    // Deep link from the Teacher Dashboard's Group Sessions section
    // ("Open" action): /sessions.html?open=<id> jumps straight to that
    // session's monitor view instead of landing on the list.
    const openId = Number(new URLSearchParams(window.location.search).get('open'));
    if (Number.isInteger(openId) && openId > 0) {
        openMonitor(openId);
    }

    // "My Sessions" rows are built from fetched data and don't
    // retranslate themselves on a same-page language switch.
    document.addEventListener('morseTrainer:languageChanged', () => {
        loadSessions();
    });
}

init();
