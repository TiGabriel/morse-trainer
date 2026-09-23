// ---------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------
async function api(path, options = {}) {
    const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            // Session expired or was revoked mid-use (e.g. a teacher
            // deactivated this account, or the sliding TTL ran out) —
            // every further request would fail the same way, so send the
            // user back to log in again rather than leaving them looking
            // at a page full of "Not authenticated" errors.
            window.location.href = '/';
        }
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data;
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------
let toastTimer = null;
function showToast(message, type = 'default') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        el.hidden = true;
    }, 4500);
}

// ---------------------------------------------------------------------
// Generic modal (form-based)
// ---------------------------------------------------------------------
const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalError = document.getElementById('modal-error');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');

// Defense-in-depth: the `hidden` attribute alone depends on styles.css's
// global `[hidden] { display: none !important; }` rule to beat
// `.modal-backdrop { display: flex }` (same-specificity author CSS
// otherwise overrides the browser's default `[hidden]` behavior — see
// that rule's own comment for the prior incident this already caused).
// If that stylesheet is ever missing or stale on the client, the modal
// renders visible with nothing in it and both buttons appear inert
// (no onSubmit was ever registered). Setting `display` directly here
// makes this modal's visibility self-contained in JS, independent of
// any CSS file being present or up to date.
modalBackdrop.style.display = 'none';

let activeModalSubmit = null;

/**
 * fields: [{ key, label, type: 'text'|'password'|'select', options?: [{value,label}], value?, required? }]
 * onSubmit(values) -> should return a Promise; throw an Error with a
 * user-facing message to show it inline in the modal.
 */
function openModal({ title, fields, note, confirmLabel = t('common.save'), onSubmit }) {
    modalTitle.textContent = title;
    modalError.hidden = true;
    modalError.textContent = '';
    modalConfirmBtn.hidden = false;
    modalConfirmBtn.textContent = confirmLabel;

    modalBody.innerHTML = '';
    if (note) {
        const noteEl = document.createElement('p');
        noteEl.className = 'modal-note';
        noteEl.textContent = note;
        modalBody.appendChild(noteEl);
    }

    const inputs = {};
    (fields || []).forEach((field) => {
        const wrap = document.createElement('div');
        wrap.className = 'modal-field';

        const label = document.createElement('label');
        label.textContent = field.label;
        label.setAttribute('for', `field-${field.key}`);
        wrap.appendChild(label);

        let input;
        if (field.type === 'select') {
            input = document.createElement('select');
            (field.options || []).forEach((opt) => {
                const optionEl = document.createElement('option');
                optionEl.value = opt.value;
                optionEl.textContent = opt.label;
                input.appendChild(optionEl);
            });
        } else {
            input = document.createElement('input');
            input.type = field.type || 'text';
        }
        input.id = `field-${field.key}`;
        if (field.value !== undefined && field.value !== null) input.value = field.value;
        if (field.placeholder) input.placeholder = field.placeholder;

        wrap.appendChild(input);
        modalBody.appendChild(wrap);
        inputs[field.key] = input;
    });

    activeModalSubmit = async () => {
        const values = {};
        for (const [key, input] of Object.entries(inputs)) {
            values[key] = input.value;
        }
        try {
            modalConfirmBtn.disabled = true;
            const result = await onSubmit(values);
            if (!result || !result.keepOpen) {
                closeModal();
            }
        } catch (err) {
            modalError.textContent = err.message || t('teacher.somethingWrong');
            modalError.hidden = false;
        } finally {
            modalConfirmBtn.disabled = false;
        }
    };

    modalBackdrop.hidden = false;
    modalBackdrop.style.display = 'flex';
}

function closeModal() {
    modalBackdrop.hidden = true;
    modalBackdrop.style.display = 'none';
    activeModalSubmit = null;
}

modalConfirmBtn.addEventListener('click', () => {
    if (activeModalSubmit) activeModalSubmit();
});
modalCancelBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) closeModal();
});

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let classesCache = [];
let currentUser = null;

// ---------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------
async function loadClasses() {
    const { classes } = await api('/api/classes');
    classesCache = classes;
    renderClasses(classes);
    populateClassFilter(classes);
    populateGradesClassFilter(classes);
    return classes;
}

function renderClasses(classes) {
    const tbody = document.getElementById('classes-tbody');
    tbody.innerHTML = '';

    if (classes.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(t('teacher.noClassesYet'))}</td></tr>`;
        return;
    }

    classes.forEach((cls) => {
        const tr = document.createElement('tr');

        const statusBadge = cls.isActive
            ? `<span class="badge badge-active">${escapeHtml(t('common.active'))}</span>`
            : `<span class="badge badge-inactive">${escapeHtml(t('common.inactive'))}</span>`;

        tr.innerHTML = `
            <td>${escapeHtml(cls.name)}</td>
            <td>${statusBadge}</td>
            <td>${cls.studentCount}</td>
            <td class="col-actions"><div class="row-actions"></div></td>
        `;

        const actions = tr.querySelector('.row-actions');

        actions.appendChild(makeButton(t('teacher.rename'), 'btn-secondary', () => openRenameClassModal(cls), true));
        actions.appendChild(
            makeButton(
                cls.isActive ? t('teacher.deactivate') : t('teacher.reactivate'),
                cls.isActive ? 'btn-secondary' : 'btn-primary',
                () => toggleClassActive(cls),
                true
            )
        );

        const deleteBtn = makeButton(t('common.delete'), 'btn-danger', () => confirmDeleteClass(cls), true);
        deleteBtn.disabled = cls.studentCount > 0;
        if (cls.studentCount > 0) deleteBtn.title = t('teacher.reassignBeforeDelete');
        actions.appendChild(deleteBtn);

        tbody.appendChild(tr);
    });
}

function populateClassFilter(classes) {
    const select = document.getElementById('class-filter');
    const previousValue = select.value;
    select.innerHTML = `<option value="">${escapeHtml(t('teacher.allClasses'))}</option><option value="none">${escapeHtml(t('teacher.noClass'))}</option>`;
    classes.forEach((cls) => {
        const opt = document.createElement('option');
        opt.value = String(cls.id);
        opt.textContent = cls.isActive ? cls.name : `${cls.name} (inactive)`;
        select.appendChild(opt);
    });
    select.value = previousValue;
}

function openNewClassModal() {
    openModal({
        title: t('teacher.newClassModalTitle'),
        fields: [{ key: 'name', label: t('teacher.className'), type: 'text', placeholder: t('teacher.classNamePlaceholder') }],
        confirmLabel: t('teacher.create'),
        onSubmit: async (values) => {
            if (!values.name.trim()) throw new Error(t('teacher.errClassNameRequired'));
            await api('/api/classes', { method: 'POST', body: JSON.stringify({ name: values.name.trim() }) });
            showToast(t('teacher.toastClassCreated'), 'success');
            await Promise.all([loadClasses(), loadStudents()]);
        },
    });
}

function openRenameClassModal(cls) {
    openModal({
        title: t('teacher.renameModalTitle', { name: cls.name }),
        fields: [{ key: 'name', label: t('teacher.className'), type: 'text', value: cls.name }],
        confirmLabel: t('common.save'),
        onSubmit: async (values) => {
            if (!values.name.trim()) throw new Error(t('teacher.errClassNameRequired'));
            await api(`/api/classes/${cls.id}`, { method: 'PATCH', body: JSON.stringify({ name: values.name.trim() }) });
            showToast(t('teacher.toastClassRenamed'), 'success');
            await Promise.all([loadClasses(), loadStudents()]);
        },
    });
}

async function toggleClassActive(cls) {
    try {
        await api(`/api/classes/${cls.id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: !cls.isActive }),
        });
        showToast(cls.isActive ? t('teacher.toastClassDeactivated') : t('teacher.toastClassReactivated'), 'success');
        await loadClasses();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function confirmDeleteClass(cls) {
    openModal({
        title: t('teacher.deleteClassModalTitle', { name: cls.name }),
        fields: [],
        note: t('teacher.deleteClassNote'),
        confirmLabel: t('common.delete'),
        onSubmit: async () => {
            await api(`/api/classes/${cls.id}`, { method: 'DELETE' });
            showToast(t('teacher.toastClassDeleted'), 'success');
            await loadClasses();
        },
    });
}

// ---------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------
async function loadStudents() {
    const search = document.getElementById('search-input').value.trim();
    const classId = document.getElementById('class-filter').value;
    const status = document.getElementById('status-filter').value;

    const params = new URLSearchParams({ role: 'student', status });
    if (search) params.set('search', search);
    if (classId) params.set('classId', classId);

    const { users } = await api(`/api/users?${params.toString()}`);
    renderStudents(users);
}

function renderStudents(students) {
    const tbody = document.getElementById('students-tbody');
    tbody.innerHTML = '';

    if (students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(t('teacher.noStudentsMatch'))}</td></tr>`;
        return;
    }

    students.forEach((student) => {
        const tr = document.createElement('tr');
        const statusBadge = student.isActive
            ? `<span class="badge badge-active">${escapeHtml(t('common.active'))}</span>`
            : `<span class="badge badge-inactive">${escapeHtml(t('common.inactive'))}</span>`;

        tr.innerHTML = `
            <td>${escapeHtml(student.rank || '—')}</td>
            <td>${escapeHtml(student.lastName || '—')}</td>
            <td>${escapeHtml(student.firstName || '—')}</td>
            <td>${escapeHtml(student.username)}</td>
            <td>${escapeHtml(student.className || t('teacher.noClass'))}</td>
            <td>${statusBadge}</td>
            <td class="col-actions"><div class="row-actions"></div></td>
        `;

        const actions = tr.querySelector('.row-actions');

        actions.appendChild(makeButton(t('common.edit'), 'btn-secondary', () => openEditStudentModal(student), true));
        actions.appendChild(
            makeButton(
                student.isActive ? t('teacher.deactivate') : t('teacher.reactivate'),
                student.isActive ? 'btn-secondary' : 'btn-primary',
                () => toggleStudentActive(student),
                true
            )
        );
        actions.appendChild(makeButton(t('teacher.resetPw'), 'btn-secondary', () => confirmResetPassword(student), true));

        tbody.appendChild(tr);
    });
}

function openNewStudentModal() {
    openModal({
        title: t('teacher.newStudentModalTitle'),
        confirmLabel: t('teacher.create'),
        fields: [
            { key: 'username', label: t('teacher.username'), type: 'text' },
            { key: 'password', label: t('teacher.tempPassword'), type: 'text', placeholder: t('teacher.tempPasswordPlaceholder') },
            { key: 'rank', label: t('auth.rank'), type: 'text' },
            { key: 'firstName', label: t('teacher.firstName'), type: 'text' },
            { key: 'lastName', label: t('teacher.lastName'), type: 'text' },
            {
                key: 'classId',
                label: t('common.class'),
                type: 'select',
                options: [{ value: '', label: t('teacher.noClass') }, ...classesCache.map((c) => ({ value: String(c.id), label: c.name }))],
            },
        ],
        onSubmit: async (values) => {
            if (!values.username.trim()) throw new Error(t('teacher.errUsernameRequired'));
            if (!values.password || values.password.length < 8) throw new Error(t('teacher.errPasswordLength'));

            await api('/api/users', {
                method: 'POST',
                body: JSON.stringify({
                    username: values.username.trim(),
                    password: values.password,
                    role: 'student',
                    rank: values.rank.trim() || null,
                    firstName: values.firstName.trim() || null,
                    lastName: values.lastName.trim() || null,
                    classId: values.classId ? Number(values.classId) : null,
                }),
            });
            showToast(t('teacher.toastStudentCreated'), 'success');
            await Promise.all([loadStudents(), loadClasses()]);
        },
    });
}

function openEditStudentModal(student) {
    openModal({
        title: `${t('common.edit')} ${student.firstName || ''} ${student.lastName || ''}`.trim() || t('teacher.editStudentModalTitle'),
        confirmLabel: t('common.save'),
        fields: [
            { key: 'username', label: t('teacher.username'), type: 'text', value: student.username },
            { key: 'rank', label: t('auth.rank'), type: 'text', value: student.rank || '' },
            { key: 'firstName', label: t('teacher.firstName'), type: 'text', value: student.firstName || '' },
            { key: 'lastName', label: t('teacher.lastName'), type: 'text', value: student.lastName || '' },
            {
                key: 'classId',
                label: t('common.class'),
                type: 'select',
                value: student.classId != null ? String(student.classId) : '',
                options: [{ value: '', label: t('teacher.noClass') }, ...classesCache.map((c) => ({ value: String(c.id), label: c.name }))],
            },
        ],
        onSubmit: async (values) => {
            if (!values.username.trim()) throw new Error(t('teacher.errUsernameRequired'));
            await api(`/api/users/${student.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    username: values.username.trim(),
                    rank: values.rank.trim() || null,
                    firstName: values.firstName.trim() || null,
                    lastName: values.lastName.trim() || null,
                    classId: values.classId ? Number(values.classId) : null,
                }),
            });
            showToast(t('teacher.toastStudentUpdated'), 'success');
            await Promise.all([loadStudents(), loadClasses()]);
        },
    });
}

async function toggleStudentActive(student) {
    try {
        await api(`/api/users/${student.id}/status`, {
            method: 'PATCH',
            body: JSON.stringify({ isActive: !student.isActive }),
        });
        showToast(student.isActive ? t('teacher.toastStudentDeactivated') : t('teacher.toastStudentReactivated'), 'success');
        await loadStudents();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function confirmResetPassword(student) {
    openModal({
        title: t('teacher.resetPasswordTitle', { username: student.username }),
        note: t('teacher.resetPasswordNote'),
        fields: [],
        confirmLabel: t('teacher.generateNewPassword'),
        onSubmit: async () => {
            const result = await api(`/api/users/${student.id}/reset-password`, { method: 'POST', body: JSON.stringify({}) });

            // Show the generated password inline instead of closing the
            // modal immediately, so the teacher can copy it down.
            const box = document.createElement('div');
            box.className = 'generated-password';
            box.textContent = result.temporaryPassword;
            modalBody.appendChild(box);

            const hint = document.createElement('p');
            hint.className = 'modal-note';
            hint.textContent = t('teacher.writeDownPassword');
            modalBody.appendChild(hint);

            modalConfirmBtn.hidden = true;
            showToast(t('teacher.toastPasswordReset'), 'success');

            return { keepOpen: true };
        },
    });
}

// ---------------------------------------------------------------------
// Dashboard: Group Sessions (primary) — reuses GET /api/sessions, already
// scoped server-side to sessions this teacher created.
// ---------------------------------------------------------------------
let dashSessionsCache = [];

async function loadDashboardSessions() {
    const { sessions } = await api('/api/sessions');
    dashSessionsCache = sessions;
    renderDashboardSessions();
}

function renderDashboardSessions() {
    const tbody = document.getElementById('dash-sessions-tbody');
    const search = document.getElementById('dash-sessions-search').value.trim().toLowerCase();
    const status = document.getElementById('dash-sessions-status-filter').value;

    const filtered = dashSessionsCache.filter((s) => {
        if (status && s.status !== status) return false;
        if (search && !(s.className || '').toLowerCase().includes(search)) return false;
        return true;
    });

    tbody.innerHTML = '';
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(t('teacher.noSessionsMatch'))}</td></tr>`;
        return;
    }

    filtered.forEach((s) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(s.className || '—')}</td>
            <td>${escapeHtml(s.type === 'test' ? t('groupSession.formalTest') : t('groupSession.groupPractice'))}</td>
            <td>${escapeHtml(s.difficulty || '—')}</td>
            <td>${s.wpm}</td>
            <td>${s.exerciseCount}</td>
            <td><span class="badge status-${s.status}">${escapeHtml(t('teacher.status' + s.status.charAt(0).toUpperCase() + s.status.slice(1)) || s.status)}</span></td>
            <td class="col-actions"><div class="row-actions"></div></td>
        `;
        const actions = tr.querySelector('.row-actions');
        actions.appendChild(
            makeButton(
                t('teacher.open'),
                'btn-secondary',
                () => {
                    window.location.href = `/sessions.html?open=${s.id}`;
                },
                true
            )
        );
        tbody.appendChild(tr);
    });
}

// ---------------------------------------------------------------------
// Dashboard: Student Grades (primary, new) — built only from GET
// /api/classes (already used for the class filter above) and GET
// /api/stats/classes/:id, merged across classes. No new backend endpoint.
// ---------------------------------------------------------------------
let gradesCache = [];

async function loadGrades() {
    const classId = document.getElementById('grades-class-filter').value;
    const targetClasses = classId ? classesCache.filter((c) => String(c.id) === classId) : classesCache;

    const perClass = await Promise.all(
        targetClasses.map((cls) =>
            api(`/api/stats/classes/${cls.id}`).then((data) => data.students.map((s) => ({ ...s, className: cls.name })))
        )
    );
    gradesCache = perClass.flat();
    renderGrades();
}

function populateGradesClassFilter(classes) {
    const select = document.getElementById('grades-class-filter');
    const previousValue = select.value;
    select.innerHTML = '<option value="">All classes</option>';
    classes.forEach((cls) => {
        const opt = document.createElement('option');
        opt.value = String(cls.id);
        opt.textContent = cls.name;
        select.appendChild(opt);
    });
    select.value = previousValue;
}

/** Renders a stat as "—" only for missing data (null) — a real 0 stays "0", never inflated to "0%" when there's simply no data yet. */
function formatCount(v) {
    return v === null || v === undefined ? '—' : String(v);
}
function formatPercent(v) {
    return v === null || v === undefined ? '—' : `${v}%`;
}

function renderGrades() {
    const tbody = document.getElementById('grades-tbody');
    const search = document.getElementById('grades-search').value.trim().toLowerCase();

    const filtered = gradesCache.filter((s) => {
        if (!search) return true;
        const haystack = `${s.firstName || ''} ${s.lastName || ''} ${s.username}`.toLowerCase();
        return haystack.includes(search);
    });

    tbody.innerHTML = '';
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="muted">${escapeHtml(t('teacher.noStudentsMatch'))}</td></tr>`;
        return;
    }

    filtered.forEach((s) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(s.rank || '—')}</td>
            <td>${escapeHtml(`${s.firstName || ''} ${s.lastName || ''}`.trim() || '—')}</td>
            <td>${escapeHtml(s.username)}</td>
            <td>${escapeHtml(s.className || '—')}</td>
            <td>${formatCount(s.practiceAttemptCount)}</td>
            <td>${formatPercent(s.practiceAvgAccuracy)}</td>
            <td>${formatCount(s.testSessionCount)}</td>
            <td>${formatPercent(s.testAvgScore)}</td>
            <td>${formatPercent(s.testPassRatePercent)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str === undefined || str === null ? '' : String(str);
    return div.innerHTML;
}

function makeButton(label, cls, onClick, small) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `btn ${cls}${small ? ' btn-small' : ''}`;
    btn.addEventListener('click', onClick);
    return btn;
}

// ---------------------------------------------------------------------
// Bootstrapping / auth gate
// ---------------------------------------------------------------------
async function init() {
    try {
        const { user } = await api('/api/auth/me');
        if (user.role !== 'teacher') {
            window.location.href = '/';
            return;
        }
        currentUser = user;
    } catch {
        window.location.href = '/';
        return;
    }

    document.getElementById('auth-gate').hidden = true;
    document.getElementById('dashboard').hidden = false;
    document.getElementById('teacher-name').textContent =
        `${currentUser.firstName || ''} ${currentUser.lastName || ''} (${currentUser.username})`.trim();
    if (window.ScrollReveal) window.ScrollReveal.observe('.reveal-on-scroll');

    document.getElementById('new-class-button').addEventListener('click', openNewClassModal);
    document.getElementById('new-student-button').addEventListener('click', openNewStudentModal);

    document.getElementById('class-filter').addEventListener('change', loadStudents);
    document.getElementById('status-filter').addEventListener('change', loadStudents);

    let searchDebounce;
    document.getElementById('search-input').addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(loadStudents, 300);
    });

    document.getElementById('dash-sessions-search').addEventListener('input', renderDashboardSessions);
    document.getElementById('dash-sessions-status-filter').addEventListener('change', renderDashboardSessions);

    document.getElementById('grades-class-filter').addEventListener('change', loadGrades);
    let gradesSearchDebounce;
    document.getElementById('grades-search').addEventListener('input', () => {
        clearTimeout(gradesSearchDebounce);
        gradesSearchDebounce = setTimeout(renderGrades, 200);
    });

    await loadClasses();
    await loadStudents();
    await loadDashboardSessions();
    await loadGrades();

    // Rows built from fetched data don't retranslate themselves on a
    // same-page language switch — re-render (from already-fetched
    // caches where possible, no need to hit the API again) whichever
    // tables are visible.
    document.addEventListener('morseTrainer:languageChanged', () => {
        renderClasses(classesCache);
        loadStudents();
        renderDashboardSessions();
        renderGrades();
    });
}

init();
