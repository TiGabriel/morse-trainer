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
    toastTimer = setTimeout(() => {
        t.hidden = true;
    }, 4000);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
}

/** "—" for null (no data), a formatted percentage otherwise — never a fake 0%. */
function pct(value) {
    return value === null || value === undefined ? '—' : `${value}%`;
}

// ---------------------------------------------------------------------
// Class summary
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    const select = el('stats-class-select');
    const active = classes.filter((c) => c.isActive);
    if (active.length === 0) {
        select.innerHTML = '<option value="">No classes yet</option>';
        return;
    }
    select.innerHTML = active.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    await loadClassStats();
}

async function loadClassStats() {
    const classId = el('stats-class-select').value;
    if (!classId) return;
    try {
        const data = await api(`/api/stats/classes/${classId}`);
        renderClassStats(data);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function findByType(rows, type) {
    return rows.find((r) => r.type === type) || null;
}

function renderClassStats(data) {
    el('stats-student-count').textContent = data.studentCount;
    el('stats-practice-count').textContent = data.practice.attemptCount;
    el('stats-practice-accuracy').textContent = pct(data.practice.avgAccuracy);

    const testRow = findByType(data.sessions, 'test');
    el('stats-test-count').textContent = testRow ? testRow.sessionCount : 0;
    el('stats-test-score').textContent = testRow ? pct(testRow.avgScore) : '—';
    el('stats-test-pass-rate').textContent = testRow ? pct(testRow.passRatePercent) : '—';

    const groupRow = findByType(data.sessions, 'group');
    el('stats-group-count').textContent = groupRow ? groupRow.sessionCount : 0;
    el('stats-group-score').textContent = groupRow ? pct(groupRow.avgScore) : '—';

    el('stats-empty-notice').hidden = data.practice.attemptCount > 0 || data.sessions.length > 0;

    const tbody = el('stats-students-tbody');
    if (data.students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">No active students in this class.</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    data.students.forEach((s) => {
        const tr = document.createElement('tr');
        const name = [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username;
        tr.innerHTML = `
            <td>${escapeHtml(s.rank || '—')}</td>
            <td>${escapeHtml(name)}</td>
            <td>${s.practiceAttemptCount}</td>
            <td>${pct(s.practiceAvgAccuracy)}</td>
            <td>${s.testSessionCount}</td>
            <td>${pct(s.testAvgScore)}</td>
            <td>${pct(s.testPassRatePercent)}</td>
        `;
        tr.classList.add('clickable-row');
        tr.addEventListener('click', () => openStudentDetail(s.studentId, name));
        tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------
// Per-student detail
// ---------------------------------------------------------------------
async function openStudentDetail(studentId, name) {
    try {
        const data = await api(`/api/stats/students/${studentId}`);
        el('student-detail-panel').hidden = false;
        el('student-detail-title').textContent = `${name} — Progress`;
        el('detail-practice-count').textContent = data.practice.attemptCount;
        el('detail-practice-accuracy').textContent = pct(data.practice.avgAccuracy);
        el('detail-trend').textContent = data.practice.recentTrend
            ? `${pct(data.practice.recentTrend.recentAvgAccuracy)} recent vs. ${pct(data.practice.recentTrend.overallAvgAccuracy)} overall`
            : 'Not enough attempts yet for a trend (needs 10+).';

        const tbody = el('detail-by-day-tbody');
        if (data.accuracyByDay.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="muted">No recent activity.</td></tr>';
        } else {
            tbody.innerHTML = '';
            [...data.accuracyByDay].reverse().forEach((row) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${escapeHtml(row.day)}</td><td>${row.count}</td><td>${pct(row.avgAccuracy)}</td>`;
                tbody.appendChild(tr);
            });
        }
        el('student-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        showToast(err.message, 'error');
    }
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
    if (window.ScrollReveal) window.ScrollReveal.observe('.reveal-on-scroll');

    el('stats-class-select').addEventListener('change', () => {
        el('student-detail-panel').hidden = true;
        loadClassStats();
    });
    el('student-detail-close').addEventListener('click', () => {
        el('student-detail-panel').hidden = true;
    });

    await loadClasses();
}

init();
