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
function openModal({ title, fields, note, confirmLabel = 'Save', onSubmit }) {
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
            modalError.textContent = err.message || 'Something went wrong.';
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
    return classes;
}

function renderClasses(classes) {
    const tbody = document.getElementById('classes-tbody');
    tbody.innerHTML = '';

    if (classes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No classes yet. Create one to get started.</td></tr>';
        return;
    }

    classes.forEach((cls) => {
        const tr = document.createElement('tr');

        const statusBadge = cls.isActive
            ? '<span class="badge badge-active">Active</span>'
            : '<span class="badge badge-inactive">Inactive</span>';

        tr.innerHTML = `
            <td>${escapeHtml(cls.name)}</td>
            <td>${statusBadge}</td>
            <td>${cls.studentCount}</td>
            <td class="col-actions"><div class="row-actions"></div></td>
        `;

        const actions = tr.querySelector('.row-actions');

        actions.appendChild(makeButton('Rename', 'btn-secondary', () => openRenameClassModal(cls), true));
        actions.appendChild(
            makeButton(
                cls.isActive ? 'Deactivate' : 'Reactivate',
                cls.isActive ? 'btn-secondary' : 'btn-primary',
                () => toggleClassActive(cls),
                true
            )
        );

        const deleteBtn = makeButton('Delete', 'btn-danger', () => confirmDeleteClass(cls), true);
        deleteBtn.disabled = cls.studentCount > 0;
        if (cls.studentCount > 0) deleteBtn.title = 'Reassign or remove students before deleting.';
        actions.appendChild(deleteBtn);

        tbody.appendChild(tr);
    });
}

function populateClassFilter(classes) {
    const select = document.getElementById('class-filter');
    const previousValue = select.value;
    select.innerHTML = '<option value="">All classes</option><option value="none">No class</option>';
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
        title: 'New Class',
        fields: [{ key: 'name', label: 'Class name', type: 'text', placeholder: 'e.g. Radio Comms 101' }],
        confirmLabel: 'Create',
        onSubmit: async (values) => {
            if (!values.name.trim()) throw new Error('Class name is required.');
            await api('/api/classes', { method: 'POST', body: JSON.stringify({ name: values.name.trim() }) });
            showToast('Class created.', 'success');
            await Promise.all([loadClasses(), loadStudents()]);
        },
    });
}

function openRenameClassModal(cls) {
    openModal({
        title: `Rename "${cls.name}"`,
        fields: [{ key: 'name', label: 'Class name', type: 'text', value: cls.name }],
        confirmLabel: 'Save',
        onSubmit: async (values) => {
            if (!values.name.trim()) throw new Error('Class name is required.');
            await api(`/api/classes/${cls.id}`, { method: 'PATCH', body: JSON.stringify({ name: values.name.trim() }) });
            showToast('Class renamed.', 'success');
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
        showToast(cls.isActive ? 'Class deactivated.' : 'Class reactivated.', 'success');
        await loadClasses();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function confirmDeleteClass(cls) {
    openModal({
        title: `Delete "${cls.name}"?`,
        fields: [],
        note: 'This permanently removes the class. This cannot be undone.',
        confirmLabel: 'Delete',
        onSubmit: async () => {
            await api(`/api/classes/${cls.id}`, { method: 'DELETE' });
            showToast('Class deleted.', 'success');
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
        tbody.innerHTML = '<tr><td colspan="7" class="muted">No students match the current filters.</td></tr>';
        return;
    }

    students.forEach((student) => {
        const tr = document.createElement('tr');
        const statusBadge = student.isActive
            ? '<span class="badge badge-active">Active</span>'
            : '<span class="badge badge-inactive">Inactive</span>';

        tr.innerHTML = `
            <td>${escapeHtml(student.rank || '—')}</td>
            <td>${escapeHtml(student.lastName || '—')}</td>
            <td>${escapeHtml(student.firstName || '—')}</td>
            <td>${escapeHtml(student.username)}</td>
            <td>${escapeHtml(student.className || '— none —')}</td>
            <td>${statusBadge}</td>
            <td class="col-actions"><div class="row-actions"></div></td>
        `;

        const actions = tr.querySelector('.row-actions');

        actions.appendChild(makeButton('Edit', 'btn-secondary', () => openEditStudentModal(student), true));
        actions.appendChild(
            makeButton(
                student.isActive ? 'Deactivate' : 'Reactivate',
                student.isActive ? 'btn-secondary' : 'btn-primary',
                () => toggleStudentActive(student),
                true
            )
        );
        actions.appendChild(makeButton('Reset PW', 'btn-secondary', () => confirmResetPassword(student), true));

        tbody.appendChild(tr);
    });
}

function openNewStudentModal() {
    openModal({
        title: 'New Student',
        confirmLabel: 'Create',
        fields: [
            { key: 'username', label: 'Username', type: 'text' },
            { key: 'password', label: 'Temporary password', type: 'text', placeholder: 'At least 8 characters' },
            { key: 'rank', label: 'Rank', type: 'text' },
            { key: 'firstName', label: 'First name', type: 'text' },
            { key: 'lastName', label: 'Last name', type: 'text' },
            {
                key: 'classId',
                label: 'Class',
                type: 'select',
                options: [{ value: '', label: '— No class —' }, ...classesCache.map((c) => ({ value: String(c.id), label: c.name }))],
            },
        ],
        onSubmit: async (values) => {
            if (!values.username.trim()) throw new Error('Username is required.');
            if (!values.password || values.password.length < 8) throw new Error('Password must be at least 8 characters.');

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
            showToast('Student created.', 'success');
            await Promise.all([loadStudents(), loadClasses()]);
        },
    });
}

function openEditStudentModal(student) {
    openModal({
        title: `Edit ${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Edit Student',
        confirmLabel: 'Save',
        fields: [
            { key: 'username', label: 'Username', type: 'text', value: student.username },
            { key: 'rank', label: 'Rank', type: 'text', value: student.rank || '' },
            { key: 'firstName', label: 'First name', type: 'text', value: student.firstName || '' },
            { key: 'lastName', label: 'Last name', type: 'text', value: student.lastName || '' },
            {
                key: 'classId',
                label: 'Class',
                type: 'select',
                value: student.classId != null ? String(student.classId) : '',
                options: [{ value: '', label: '— No class —' }, ...classesCache.map((c) => ({ value: String(c.id), label: c.name }))],
            },
        ],
        onSubmit: async (values) => {
            if (!values.username.trim()) throw new Error('Username is required.');
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
            showToast('Student updated.', 'success');
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
        showToast(student.isActive ? 'Student deactivated.' : 'Student reactivated.', 'success');
        await loadStudents();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function confirmResetPassword(student) {
    openModal({
        title: `Reset password for ${student.username}`,
        note: 'A new random password will be generated and shown once below. Any sessions this student has open will be signed out.',
        fields: [],
        confirmLabel: 'Generate new password',
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
            hint.textContent = 'Write this down now — it will not be shown again. Click Cancel to close.';
            modalBody.appendChild(hint);

            modalConfirmBtn.hidden = true;
            showToast('Password reset.', 'success');

            return { keepOpen: true };
        },
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

    document.getElementById('logout-button').addEventListener('click', async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        window.location.href = '/';
    });

    document.getElementById('new-class-button').addEventListener('click', openNewClassModal);
    document.getElementById('new-student-button').addEventListener('click', openNewStudentModal);

    document.getElementById('class-filter').addEventListener('change', loadStudents);
    document.getElementById('status-filter').addEventListener('change', loadStudents);

    let searchDebounce;
    document.getElementById('search-input').addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(loadStudents, 300);
    });

    await loadClasses();
    await loadStudents();
}

init();
