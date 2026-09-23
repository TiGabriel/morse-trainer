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
        select.innerHTML = `<option value="">${escapeHtml(t('stats.noClassesYet'))}</option>`;
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
        tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(t('stats.noActiveStudentsInClass'))}</td></tr>`;
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
let currentDetailStudentId = null;

async function openStudentDetail(studentId, name) {
    try {
        const data = await api(`/api/stats/students/${studentId}`);
        currentDetailStudentId = studentId;
        el('student-detail-panel').hidden = false;
        el('student-detail-title').textContent = `${name} — ${t('stats.progressWord')}`;
        el('detail-practice-count').textContent = data.practice.attemptCount;
        el('detail-practice-accuracy').textContent = pct(data.practice.avgAccuracy);
        el('detail-trend').textContent = data.practice.recentTrend
            ? t('stats.trendText', { recent: pct(data.practice.recentTrend.recentAvgAccuracy), overall: pct(data.practice.recentTrend.overallAvgAccuracy) })
            : t('stats.notEnoughForTrend');

        const tbody = el('detail-by-day-tbody');
        if (data.accuracyByDay.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="muted">${escapeHtml(t('stats.noRecentActivity'))}</td></tr>`;
        } else {
            tbody.innerHTML = '';
            [...data.accuracyByDay].reverse().forEach((row) => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${escapeHtml(row.day)}</td><td>${row.count}</td><td>${pct(row.avgAccuracy)}</td>`;
                tbody.appendChild(tr);
            });
        }
        el('detail-filter-form').reset();
        await loadDetailHistory({ reset: true });
        el('student-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// ---------------------------------------------------------------------
// Teacher Result Management: per-student inspection, delete/reset, export
// ---------------------------------------------------------------------
const DETAIL_HISTORY_PAGE_SIZE = 20;
let detailHistoryOffset = 0;
let detailHistoryRows = [];

function detailHistoryFilters() {
    const filters = {};
    const direction = el('detail-filter-direction').value;
    const exerciseType = el('detail-filter-exercise-type').value;
    const since = el('detail-filter-since').value;
    const until = el('detail-filter-until').value;
    const minWpm = el('detail-filter-min-wpm').value;
    const maxWpm = el('detail-filter-max-wpm').value;
    if (direction) filters.direction = direction;
    if (exerciseType) filters.exerciseType = exerciseType;
    if (since) filters.since = since;
    if (until) filters.until = until;
    if (minWpm) filters.minWpm = minWpm;
    if (maxWpm) filters.maxWpm = maxWpm;
    return filters;
}

async function loadDetailHistory({ reset = true } = {}) {
    if (!currentDetailStudentId) return;
    if (reset) {
        detailHistoryOffset = 0;
        detailHistoryRows = [];
    }
    const params = new URLSearchParams({ limit: String(DETAIL_HISTORY_PAGE_SIZE), offset: String(detailHistoryOffset), ...detailHistoryFilters() });
    try {
        const data = await api(`/api/stats/students/${currentDetailStudentId}/history?${params.toString()}`);
        detailHistoryRows = reset ? data.attempts : detailHistoryRows.concat(data.attempts);
        detailHistoryOffset += data.attempts.length;
        renderDetailHistoryTable(detailHistoryRows, data.total);
        el('detail-history-load-more-button').hidden = detailHistoryOffset >= data.total;
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderDetailHistoryTable(rows, total) {
    el('detail-history-empty-notice').hidden = rows.length > 0;
    const tbody = el('detail-history-tbody');
    tbody.innerHTML = '';
    rows.forEach((r) => {
        const tr = document.createElement('tr');
        const grade = r.characterGrade ? String(r.characterGrade.grade) : '—';
        const actualWpm = r.timingStats && r.timingStats.actualWpm !== null && r.timingStats.actualWpm !== undefined ? r.timingStats.actualWpm : '—';
        const rhythm = r.timingStats && r.timingStats.rhythmConsistencyPercent !== null && r.timingStats.rhythmConsistencyPercent !== undefined ? `${r.timingStats.rhythmConsistencyPercent}%` : '—';
        tr.innerHTML = `
            <td>${escapeHtml(formatDateTime(r.createdAt))}</td>
            <td>${escapeHtml(EXERCISE_TYPE_LABELS[r.exerciseType] || r.exerciseType)}</td>
            <td>${r.direction ? `<span class="direction-badge direction-${r.direction}">${r.direction}</span>` : '—'}</td>
            <td>${r.wpm || '—'}</td>
            <td>${pct(r.accuracyPercent)}</td>
            <td>${r.errorCount}</td>
            <td>${escapeHtml(grade)}</td>
            <td>${actualWpm}</td>
            <td>${rhythm}</td>
            <td class="no-print"></td>
        `;
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'link-button';
        deleteBtn.style.cssText = 'width:auto;padding:0;color:var(--error);';
        deleteBtn.textContent = t('common.delete');
        deleteBtn.addEventListener('click', () => deleteDetailAttempt(r.id));
        tr.lastElementChild.appendChild(deleteBtn);
        tbody.appendChild(tr);
    });
    el('detail-history-count-label').textContent = rows.length ? t('stats.showingXofY', { shown: rows.length, total }) : '';
}

async function deleteDetailAttempt(attemptId) {
    if (!currentDetailStudentId) return;
    if (!window.confirm(t('stats.confirmDeleteResult'))) return;
    try {
        await api(`/api/stats/students/${currentDetailStudentId}/history/${attemptId}`, { method: 'DELETE' });
        showToast(t('stats.resultDeleted'), 'success');
        await loadDetailHistory({ reset: true });
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function resetDetailHistory() {
    if (!currentDetailStudentId) return;
    const filters = detailHistoryFilters();
    const scoped = Object.keys(filters).length > 0;
    const warning = scoped
        ? t('stats.confirmResetFiltered')
        : t('stats.confirmResetEntire');
    if (!window.confirm(warning)) return;

    try {
        const params = new URLSearchParams(filters);
        const result = await api(`/api/stats/students/${currentDetailStudentId}/history?${params.toString()}`, { method: 'DELETE' });
        showToast(t('stats.deletedCount', { count: result.deletedCount }), 'success');
        await loadDetailHistory({ reset: true });
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function exportCsvUrl({ classId, studentId, filters }) {
    const params = new URLSearchParams(filters || {});
    if (studentId) params.set('studentId', String(studentId));
    return `/api/stats/classes/${classId}/export.csv?${params.toString()}`;
}

function wireTeacherResultManagement() {
    el('class-export-csv-button').addEventListener('click', () => {
        const classId = el('stats-class-select').value;
        if (!classId) return;
        window.location.href = exportCsvUrl({ classId });
    });

    el('detail-export-csv-button').addEventListener('click', () => {
        const classId = el('stats-class-select').value;
        if (!classId || !currentDetailStudentId) return;
        window.location.href = exportCsvUrl({ classId, studentId: currentDetailStudentId, filters: detailHistoryFilters() });
    });

    el('detail-print-button').addEventListener('click', () => window.print());
    el('detail-reset-history-button').addEventListener('click', resetDetailHistory);

    el('detail-filter-form').addEventListener('submit', (e) => {
        e.preventDefault();
        loadDetailHistory({ reset: true });
    });
    el('detail-filter-clear').addEventListener('click', () => {
        el('detail-filter-form').reset();
        loadDetailHistory({ reset: true });
    });
    el('detail-history-load-more-button').addEventListener('click', () => loadDetailHistory({ reset: false }));
}

// ---------------------------------------------------------------------
// Student view: My History & Progress
// ---------------------------------------------------------------------
const EXERCISE_TYPE_LABELS = {
    get audio_to_text() { return t('stats.exReceptionAudio'); },
    get morse_to_text() { return t('groupSession.modeMorseToText'); },
    get text_to_morse() { return t('groupSession.modeTransmission'); },
    get character_recognition() { return t('groupSession.modeCharacterRecognition'); },
    get radiogram_training() { return t('stats.exRadiogramTraining'); },
    get character_training() { return t('stats.exCharacterTraining'); },
};

/** "2026-09-22" -> "09/22" — compact enough for a chart x-axis with many points. */
function shortDay(dayStr) {
    const parts = String(dayStr).split('-');
    return parts.length === 3 ? `${parts[1]}/${parts[2]}` : dayStr;
}

/** Stored as SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS") — displayed as-is, just with the separator normalized. */
function formatDateTime(value) {
    return value ? String(value).replace('T', ' ').slice(0, 19) : '—';
}

async function loadMyProgress() {
    try {
        const data = await api(`/api/stats/students/${currentUser.id}`);
        renderPersonalStats(data.personalStats);
        renderProgressCharts(data.dailySeries, data.personalStats);
        renderWeakAreas(data.weakCharacters);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderPersonalStats(s) {
    el('my-total-exercises').textContent = s.totalExercises;
    el('my-avg-accuracy').textContent = pct(s.avgAccuracy);
    el('my-best-accuracy').textContent = pct(s.bestAccuracy);
    el('my-avg-wpm').textContent = s.avgWpm !== null ? `${s.avgWpm} ${t('common.wpmShort')}` : '—';
    el('my-best-wpm').textContent = s.bestWpm !== null ? `${s.bestWpm} ${t('common.wpmShort')}` : '—';
    el('my-total-errors').textContent = s.totalErrors;
    el('my-reception-avg').textContent = pct(s.receptionAvgAccuracy);
    el('my-transmission-avg').textContent = pct(s.transmissionAvgAccuracy);
    el('my-stats-empty-notice').hidden = s.totalExercises > 0;
}

/** Renders the four small inline-SVG charts (see mini-chart.js) from the same daily series — one fetch, four views. */
function renderProgressCharts(series, personalStats) {
    const accuracyPoints = series.map((d) => ({ x: shortDay(d.day), y: d.avgAccuracy }));
    const wpmPoints = series.map((d) => ({ x: shortDay(d.day), y: d.avgWpm }));
    const errorPoints = series.map((d) => ({ x: shortDay(d.day), y: d.totalErrors }));

    window.MiniChart.renderLineChart(el('chart-accuracy'), accuracyPoints, { color: '#6fbf73', unit: '%', min: 0, max: 100 });
    window.MiniChart.renderLineChart(el('chart-wpm'), wpmPoints, { color: '#3d7ab8', unit: ' WPM' });
    window.MiniChart.renderLineChart(el('chart-errors'), errorPoints, { color: '#e2726a', unit: '' });

    // Sourced from the whole-history personalStats totals (already
    // correctly weighted by row, not by day) rather than re-averaging
    // the daily series here, which would silently under-weight busier days.
    window.MiniChart.renderBarChart(
        el('chart-direction'),
        [
            { label: t('stats.reception'), value: personalStats.receptionAvgAccuracy, color: '#3d7ab8' },
            { label: t('stats.transmission'), value: personalStats.transmissionAvgAccuracy, color: '#7fae6f' },
        ],
        { unit: '%' }
    );
}

function renderWeakAreas(list) {
    el('weak-areas-empty-notice').hidden = list.length > 0;
    const tbody = el('weak-areas-tbody');
    tbody.innerHTML = '';
    list.forEach((w) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><span class="weak-char-badge">${escapeHtml(w.char)}</span></td>
            <td>${w.attempts}</td>
            <td>${w.errors}</td>
            <td>${pct(w.accuracyPercent)}</td>
        `;
        tbody.appendChild(tr);
    });
}

const HISTORY_PAGE_SIZE = 20;
let historyOffset = 0;
let historyRows = [];

function currentHistoryFilters() {
    const filters = {};
    const direction = el('history-filter-direction').value;
    const exerciseType = el('history-filter-exercise-type').value;
    const since = el('history-filter-since').value;
    const until = el('history-filter-until').value;
    const minWpm = el('history-filter-min-wpm').value;
    const maxWpm = el('history-filter-max-wpm').value;
    if (direction) filters.direction = direction;
    if (exerciseType) filters.exerciseType = exerciseType;
    if (since) filters.since = since;
    if (until) filters.until = until;
    if (minWpm) filters.minWpm = minWpm;
    if (maxWpm) filters.maxWpm = maxWpm;
    return filters;
}

async function loadMyHistory({ reset = true } = {}) {
    if (reset) {
        historyOffset = 0;
        historyRows = [];
    }
    const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE), offset: String(historyOffset), ...currentHistoryFilters() });
    try {
        const data = await api(`/api/practice/history?${params.toString()}`);
        historyRows = reset ? data.attempts : historyRows.concat(data.attempts);
        historyOffset += data.attempts.length;
        renderHistoryTable(historyRows, data.total);
        el('history-load-more-button').hidden = historyOffset >= data.total;
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderHistoryTable(rows, total) {
    el('history-empty-notice').hidden = rows.length > 0;
    const tbody = el('history-tbody');
    if (rows.length === 0) {
        tbody.innerHTML = '';
        el('history-count-label').textContent = '';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach((r) => {
        const tr = document.createElement('tr');
        const grade = r.characterGrade ? String(r.characterGrade.grade) : '—';
        tr.innerHTML = `
            <td>${escapeHtml(formatDateTime(r.createdAt))}</td>
            <td>${escapeHtml(EXERCISE_TYPE_LABELS[r.exerciseType] || r.exerciseType)}</td>
            <td>${r.direction ? `<span class="direction-badge direction-${r.direction}">${r.direction}</span>` : '—'}</td>
            <td>${r.wpm || '—'}</td>
            <td>${pct(r.accuracyPercent)}</td>
            <td>${r.errorCount}</td>
            <td>${escapeHtml(grade)}</td>
        `;
        tbody.appendChild(tr);
    });
    el('history-count-label').textContent = t('stats.showingXofY', { shown: rows.length, total });
}

function wireStudentView() {
    el('history-filter-form').addEventListener('submit', (e) => {
        e.preventDefault();
        loadMyHistory({ reset: true });
    });
    el('history-filter-clear').addEventListener('click', () => {
        el('history-filter-form').reset();
        loadMyHistory({ reset: true });
    });
    el('history-load-more-button').addEventListener('click', () => loadMyHistory({ reset: false }));
}

// ---------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------
let currentUser = null;

function wireTeacherView() {
    el('stats-class-select').addEventListener('change', () => {
        el('student-detail-panel').hidden = true;
        loadClassStats();
    });
    el('student-detail-close').addEventListener('click', () => {
        el('student-detail-panel').hidden = true;
        currentDetailStudentId = null;
    });
    wireTeacherResultManagement();
}

async function init() {
    let user;
    try {
        ({ user } = await api('/api/auth/me'));
    } catch {
        window.location.href = '/';
        return;
    }
    currentUser = user;

    el('auth-gate').hidden = true;
    el('dashboard').hidden = false;
    el('teacher-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();
    if (window.ScrollReveal) window.ScrollReveal.observe('.reveal-on-scroll');

    if (user.role === 'teacher') {
        el('teacher-view').hidden = false;
        wireTeacherView();
        await loadClasses();
    } else {
        el('student-view').hidden = false;
        el('stats-page-subtitle').textContent = t('stats.studentSubtitle');
        wireStudentView();
        await loadMyProgress();
        await loadMyHistory();
    }

    // Tables/summaries built from fetched data (not data-i18n) don't
    // retranslate themselves on a same-page language switch — re-run
    // whichever load path built the currently visible view so nothing
    // is left stuck in the old language. Cheap: same LAN-local data
    // already fetched once, no user-visible loading state needed for
    // datasets this small.
    document.addEventListener('morseTrainer:languageChanged', () => {
        if (currentUser.role === 'teacher') {
            loadClassStats();
            if (currentDetailStudentId) openStudentDetail(currentDetailStudentId, el('student-detail-title').textContent.replace(/ — .*/, ''));
        } else {
            el('stats-page-subtitle').textContent = t('stats.studentSubtitle');
            loadMyProgress();
            loadMyHistory();
        }
    });
}

init();
