/**
 * Electronic gradebook ("Catalog electronic") — teacher-only page.
 *
 * Left: a searchable/class-filterable student list (the existing
 * teacher-only GET /api/users?role=student). Right: the selected
 * student's entries (GET /api/gradebook/students/:id/entries), split into
 * "to confirm" (temporary, automatic Formal Test results) and the saved
 * gradebook itself, plus an inline form to add a grade or a note.
 *
 * Everything here is also enforced server-side (see
 * server/src/modules/gradebook/): the page is refused to non-teachers
 * before it's even served, every API is requireRole('teacher'), and the
 * temporary/permanent rules (a permanently saved Formal Test grade is
 * locked and can't be deleted) are checked by the controller — the UI
 * only mirrors them by not offering actions that would be refused.
 */
async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) window.location.href = '/';
        throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
}

function el(id) {
    return document.getElementById(id);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
}

let toastTimer = null;
function showToast(message, type = 'default') {
    const box = el('toast');
    box.textContent = message;
    box.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        box.hidden = true;
    }, 4000);
}

/** Stored as SQLite UTC "YYYY-MM-DD HH:MM:SS" — shown in the classroom PC's local time. */
function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return String(value);
    const lang = window.I18N ? window.I18N.getLanguage() : 'ro';
    return d.toLocaleString(lang === 'en' ? 'en-GB' : 'ro-RO', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

const MODE_LABEL_KEYS = {
    audio_to_text: 'groupSession.modeAudioToText',
    morse_to_text: 'groupSession.modeMorseToText',
    text_to_morse: 'groupSession.modeTextToMorse',
    character_recognition: 'groupSession.modeCharacterRecognition',
    transmission: 'groupSession.modeTransmission',
};

let students = [];
let pendingCounts = {};
let selectedStudentId = null;
let selectedStudent = null;
let entries = [];
let addType = 'grade';
let editingEntryId = null;
let searchTimer = null;

function studentName(s) {
    return [s.lastName, s.firstName].filter(Boolean).join(' ') || s.username;
}

// ---------------------------------------------------------------------
// Student list
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    const select = el('gb-class-filter');
    const current = select.value;
    select.innerHTML = `<option value="" data-i18n="teacher.allClasses">${escapeHtml(t('teacher.allClasses'))}</option>`;
    classes.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = c.name;
        select.appendChild(opt);
    });
    select.value = current;
}

async function loadStudents() {
    const params = new URLSearchParams({ role: 'student', status: 'active' });
    const search = el('gb-search').value.trim();
    const classId = el('gb-class-filter').value;
    if (search) params.set('search', search);
    if (classId) params.set('classId', classId);
    try {
        const [{ users }, { pending }] = await Promise.all([api(`/api/users?${params}`), api('/api/gradebook/pending-counts')]);
        students = users;
        pendingCounts = pending || {};
        renderStudentList();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderStudentList() {
    const list = el('gb-student-list');
    if (students.length === 0) {
        list.innerHTML = `<li class="muted gb-list-empty">${escapeHtml(t('gradebook.noStudents'))}</li>`;
        return;
    }
    list.innerHTML = '';
    students.forEach((s) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gb-student-item' + (s.id === selectedStudentId ? ' is-selected' : '');
        btn.setAttribute('aria-pressed', String(s.id === selectedStudentId));
        const pending = pendingCounts[s.id] || 0;
        btn.innerHTML = `
            <span class="gb-student-item-main">
                <span class="gb-student-item-name">${escapeHtml(studentName(s))}</span>
                <span class="gb-student-item-meta">${escapeHtml([s.rank, s.className || t('gradebook.noClass')].filter(Boolean).join(' · '))}</span>
            </span>
            ${pending > 0 ? `<span class="badge gb-pending-badge">${escapeHtml(t('gradebook.pendingBadge', { count: pending }))}</span>` : ''}
        `;
        btn.addEventListener('click', () => selectStudent(s.id));
        li.appendChild(btn);
        list.appendChild(li);
    });
}

// ---------------------------------------------------------------------
// Selected student's gradebook
// ---------------------------------------------------------------------
async function selectStudent(studentId) {
    selectedStudentId = studentId;
    editingEntryId = null;
    renderStudentList();
    await loadEntries();
    // On a narrow (stacked) layout, bring the opened gradebook into view.
    if (window.matchMedia('(max-width: 860px)').matches) el('gb-detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadEntries() {
    if (!selectedStudentId) return;
    try {
        const data = await api(`/api/gradebook/students/${selectedStudentId}/entries`);
        selectedStudent = data.student;
        entries = data.entries;
        renderDetail();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderDetail() {
    el('gb-detail-empty').hidden = true;
    el('gb-detail').hidden = false;
    el('gb-student-name').textContent = studentName(selectedStudent);
    el('gb-student-meta').textContent = [selectedStudent.rank, selectedStudent.className || t('gradebook.noClass'), selectedStudent.username]
        .filter(Boolean)
        .join(' · ');

    const pending = entries.filter((e) => !e.isPermanent);
    const saved = entries.filter((e) => e.isPermanent);

    el('gb-pending-section').hidden = pending.length === 0;
    renderEntryList(el('gb-pending-list'), pending);
    renderEntryList(el('gb-entry-list'), saved);
    el('gb-no-entries').hidden = saved.length > 0;
}

function gradeBadge(grade) {
    if (grade === null || grade === undefined) return `<span class="gb-grade gb-grade-none">—</span>`;
    const cls = window.GradingService ? window.GradingService.gradeBadgeClass(grade) : 'badge-grade-mid';
    return `<span class="gb-grade ${cls}">${escapeHtml(grade)}</span>`;
}

function formalTestSummary(entry) {
    const d = entry.details || {};
    const parts = [t('gradebook.testSummary', { id: entry.sourceSessionId ?? '—', mode: MODE_LABEL_KEYS[d.exerciseMode] ? t(MODE_LABEL_KEYS[d.exerciseMode]) : d.exerciseMode || '—' })];
    if (d.accuracyPercent !== null && d.accuracyPercent !== undefined) parts.push(t('gradebook.accuracy', { value: Math.round(d.accuracyPercent * 10) / 10 }));
    if (d.itemsTotal) parts.push(t('gradebook.itemsAnswered', { answered: d.itemsAnswered, total: d.itemsTotal }));
    if (d.passFail) parts.push(t(d.passFail === 'pass' ? 'gradebook.pass' : 'gradebook.fail'));
    return parts.join(' · ');
}

function renderEntryList(listEl, list) {
    listEl.innerHTML = '';
    list.forEach((entry) => {
        const li = document.createElement('li');
        const isFormal = entry.source === 'formal_test';
        const lockedGrade = isFormal && entry.isPermanent;
        li.className = 'gb-entry' + (entry.isPermanent ? '' : ' is-temporary') + (isFormal ? ' is-formal' : '');
        li.dataset.entryId = String(entry.id);

        const sourceBadge = isFormal
            ? `<span class="badge gb-badge-formal">${escapeHtml(t('gradebook.sourceFormalTest'))}</span>`
            : `<span class="badge gb-badge-manual">${escapeHtml(t('gradebook.sourceManual'))}</span>`;
        const statusBadge = entry.isPermanent
            ? `<span class="badge gb-badge-permanent">${escapeHtml(t('gradebook.statusPermanent'))}</span>`
            : `<span class="badge gb-badge-temporary">${escapeHtml(t('gradebook.statusTemporary'))}</span>`;
        const typeLabel = t(entry.type === 'grade' ? 'gradebook.typeGrade' : 'gradebook.typeNote');
        const meta = [formatDateTime(entry.createdAt), entry.teacherName ? t('gradebook.byTeacher', { name: entry.teacherName }) : null]
            .concat(entry.updatedAt && entry.updatedAt !== entry.createdAt ? [t('gradebook.updatedAt', { date: formatDateTime(entry.updatedAt) })] : [])
            .filter(Boolean)
            .join(' · ');

        const isEditing = editingEntryId === entry.id;
        const body = isEditing
            ? `
                <form class="gb-edit-form" novalidate>
                    ${entry.type === 'grade' && !lockedGrade ? `
                    <div class="modal-field">
                        <label><span>${escapeHtml(t('gradebook.grade'))}</span> <span class="muted">${escapeHtml(t('gradebook.gradeHint'))}</span></label>
                        <input type="number" name="grade" min="1" max="10" step="1" value="${entry.grade ?? ''}" />
                    </div>` : ''}
                    <div class="modal-field">
                        <label>${escapeHtml(t(entry.type === 'note' ? 'gradebook.note' : 'gradebook.noteOptional'))}</label>
                        <textarea name="note" rows="2" maxlength="2000">${escapeHtml(entry.note || '')}</textarea>
                    </div>
                    <div class="modal-error gb-edit-error" hidden></div>
                    <div class="gb-entry-actions">
                        <button type="button" class="btn btn-secondary btn-small" data-action="cancel-edit">${escapeHtml(t('common.cancel'))}</button>
                        <button type="submit" class="btn btn-primary btn-small">${escapeHtml(t('common.save'))}</button>
                    </div>
                </form>`
            : `
                ${isFormal ? `<p class="gb-entry-summary">${escapeHtml(formalTestSummary(entry))}</p>` : ''}
                ${entry.note ? `<p class="gb-entry-note">${escapeHtml(entry.note)}</p>` : ''}
                ${lockedGrade ? `<p class="muted gb-entry-locked">${escapeHtml(t('gradebook.gradeLocked'))}</p>` : ''}
                <div class="gb-entry-actions">
                    ${!entry.isPermanent ? `<button type="button" class="btn btn-primary btn-small" data-action="confirm">✓ ${escapeHtml(t('gradebook.savePermanently'))}</button>` : ''}
                    <button type="button" class="btn btn-secondary btn-small" data-action="edit">${escapeHtml(t('gradebook.edit'))}</button>
                    ${!lockedGrade ? `<button type="button" class="btn btn-danger btn-small" data-action="delete">${escapeHtml(t(isFormal ? 'gradebook.discard' : 'gradebook.delete'))}</button>` : ''}
                </div>`;

        li.innerHTML = `
            <div class="gb-entry-grade">${entry.type === 'grade' ? gradeBadge(entry.grade) : '<span class="gb-grade gb-grade-note" aria-hidden="true">✎</span>'}</div>
            <div class="gb-entry-body">
                <div class="gb-entry-head">
                    <span class="gb-entry-type">${escapeHtml(typeLabel)}</span>
                    ${sourceBadge}
                    ${statusBadge}
                </div>
                <div class="gb-entry-meta muted">${escapeHtml(meta)}</div>
                ${body}
            </div>
        `;
        listEl.appendChild(li);
    });
}

async function handleEntryAction(entryId, action) {
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return;
    try {
        if (action === 'edit') {
            editingEntryId = entryId;
            renderDetail();
            const field = document.querySelector(`.gb-entry[data-entry-id="${entryId}"] .gb-edit-form input, .gb-entry[data-entry-id="${entryId}"] .gb-edit-form textarea`);
            if (field) field.focus();
        } else if (action === 'cancel-edit') {
            editingEntryId = null;
            renderDetail();
        } else if (action === 'confirm') {
            if (!window.confirm(t('gradebook.confirmPermanent'))) return;
            await api(`/api/gradebook/entries/${entryId}/confirm`, { method: 'POST' });
            showToast(t('gradebook.toastPermanent'), 'success');
            await Promise.all([loadEntries(), loadStudents()]);
        } else if (action === 'delete') {
            const question = entry.source === 'formal_test' ? t('gradebook.confirmDiscard') : t('gradebook.confirmDelete');
            if (!window.confirm(question)) return;
            await api(`/api/gradebook/entries/${entryId}`, { method: 'DELETE' });
            showToast(t('gradebook.toastDeleted'), 'success');
            await Promise.all([loadEntries(), loadStudents()]);
        }
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function submitEdit(entryId, form) {
    const entry = entries.find((e) => e.id === entryId);
    const errorBox = form.querySelector('.gb-edit-error');
    const body = { note: form.elements.note.value };
    if (form.elements.grade) {
        const grade = Number(form.elements.grade.value);
        if (!Number.isInteger(grade) || grade < 1 || grade > 10) {
            errorBox.textContent = t('gradebook.gradeInvalid');
            errorBox.hidden = false;
            return;
        }
        body.grade = grade;
    }
    if (entry.type === 'note' && !body.note.trim()) {
        errorBox.textContent = t('gradebook.noteRequired');
        errorBox.hidden = false;
        return;
    }
    try {
        await api(`/api/gradebook/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(body) });
        editingEntryId = null;
        showToast(t('gradebook.toastSaved'), 'success');
        await loadEntries();
    } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
    }
}

// ---------------------------------------------------------------------
// Add grade / add note
// ---------------------------------------------------------------------
function setAddType(type) {
    addType = type;
    document.querySelectorAll('.gb-type-btn').forEach((btn) => {
        const active = btn.dataset.entryType === type;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-checked', String(active));
    });
    el('gb-grade-field').hidden = type !== 'grade';
    const noteLabel = el('gb-note-label');
    noteLabel.dataset.i18n = type === 'grade' ? 'gradebook.noteOptional' : 'gradebook.note';
    noteLabel.textContent = t(noteLabel.dataset.i18n);
    el('gb-add-error').hidden = true;
}

async function submitAdd(e) {
    e.preventDefault();
    if (!selectedStudentId) return;
    const errorBox = el('gb-add-error');
    errorBox.hidden = true;
    const note = el('gb-note-input').value;
    const body = { type: addType, note };
    if (addType === 'grade') {
        const grade = Number(el('gb-grade-input').value);
        if (!el('gb-grade-input').value || !Number.isInteger(grade) || grade < 1 || grade > 10) {
            errorBox.textContent = t('gradebook.gradeInvalid');
            errorBox.hidden = false;
            return;
        }
        body.grade = grade;
    } else if (!note.trim()) {
        errorBox.textContent = t('gradebook.noteRequired');
        errorBox.hidden = false;
        return;
    }

    el('gb-add-submit').disabled = true;
    try {
        await api(`/api/gradebook/students/${selectedStudentId}/entries`, { method: 'POST', body: JSON.stringify(body) });
        el('gb-grade-input').value = '';
        el('gb-note-input').value = '';
        showToast(t('gradebook.toastSaved'), 'success');
        await loadEntries();
    } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
    } finally {
        el('gb-add-submit').disabled = false;
    }
}

// ---------------------------------------------------------------------
// Bootstrapping
// ---------------------------------------------------------------------
async function init() {
    let user;
    try {
        ({ user } = await api('/api/auth/me'));
    } catch {
        window.location.href = '/';
        return;
    }
    if (user.role !== 'teacher') {
        window.location.href = '/';
        return;
    }

    el('auth-gate').hidden = true;
    el('dashboard').hidden = false;
    el('teacher-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();

    el('gb-search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadStudents, 250);
    });
    el('gb-class-filter').addEventListener('change', loadStudents);
    document.querySelectorAll('.gb-type-btn').forEach((btn) => btn.addEventListener('click', () => setAddType(btn.dataset.entryType)));
    el('gb-add-form').addEventListener('submit', submitAdd);

    // One delegated listener for every entry's buttons/edit form.
    const detail = el('gb-detail');
    detail.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        const item = e.target.closest('.gb-entry');
        if (btn && item) handleEntryAction(Number(item.dataset.entryId), btn.dataset.action);
    });
    detail.addEventListener('submit', (e) => {
        const form = e.target.closest('.gb-edit-form');
        const item = e.target.closest('.gb-entry');
        if (!form || !item) return;
        e.preventDefault();
        submitEdit(Number(item.dataset.entryId), form);
    });

    // Entries/list are rendered from fetched data with t(), so re-render on a live language switch.
    document.addEventListener('morseTrainer:languageChanged', () => {
        renderStudentList();
        if (selectedStudent) renderDetail();
        setAddType(addType);
    });

    await Promise.all([loadClasses(), loadStudents()]);
}

init();
