async function checkHealth() {
    const statusEl = document.getElementById('status');
    const shareBox = document.getElementById('share-box');
    const shareUrl = document.getElementById('share-url');

    try {
        const res = await fetch('/api/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        statusEl.className = 'ok';
        statusEl.textContent = `SERVER STATUS: ${data.server_status} — uptime ${data.uptime_seconds}s`;

        if (data.lan_url) {
            shareUrl.textContent = data.lan_url;
            shareBox.hidden = false;
        } else {
            shareUrl.textContent = 'No LAN address detected — check the network connection.';
            shareBox.hidden = false;
        }
    } catch (err) {
        statusEl.className = 'err';
        statusEl.textContent = 'Could not reach server: ' + err.message;
    }
}

function showLoggedIn(user) {
    document.getElementById('app-nav-links').hidden = false;
    document.getElementById('app-nav-right').hidden = false;
    document.getElementById('logged-out-view').hidden = true;
    document.getElementById('logged-in-view').hidden = false;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    document.getElementById('current-user-name').textContent = `${name} (${user.username})`;
    document.getElementById('current-user-role').textContent = user.role;

    const teacherLinkBox = document.getElementById('teacher-link-box');
    const profileBox = document.getElementById('student-profile-box');
    const trainingLinkBox = document.getElementById('student-training-link-box');

    if (user.role === 'teacher') {
        teacherLinkBox.hidden = false;
        profileBox.hidden = true;
        trainingLinkBox.hidden = true;
    } else {
        teacherLinkBox.hidden = true;
        profileBox.hidden = false;
        trainingLinkBox.hidden = false;
        document.getElementById('profile-rank').textContent = user.rank || '—';
        document.getElementById('profile-name').textContent = name;
        document.getElementById('profile-class').textContent = user.className || '— none assigned —';
        document.getElementById('profile-status').textContent = user.isActive ? 'Active' : 'Inactive';
    }
}

function showLoggedOut() {
    document.getElementById('app-nav-links').hidden = true;
    document.getElementById('app-nav-right').hidden = true;
    document.getElementById('logged-out-view').hidden = false;
    document.getElementById('logged-in-view').hidden = true;
    document.getElementById('login-error').hidden = true;
}

async function refreshAuthState() {
    try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
            const data = await res.json();
            showLoggedIn(data.user);
            return;
        }
    } catch {
        // ignore, fall through to logged-out view
    }
    showLoggedOut();
}

function wireLoginForm() {
    const form = document.getElementById('login-form');
    const errorEl = document.getElementById('login-error');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorEl.hidden = true;

        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            const data = await res.json();

            if (!res.ok) {
                errorEl.textContent = data.error || 'Login failed.';
                errorEl.hidden = false;
                return;
            }

            document.getElementById('login-form').reset();
            showLoggedIn(data.user);
        } catch (err) {
            errorEl.textContent = 'Could not reach server: ' + err.message;
            errorEl.hidden = false;
        }
    });
}

checkHealth();
wireLoginForm();
refreshAuthState();
