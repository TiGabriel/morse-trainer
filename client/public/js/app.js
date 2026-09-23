// Header status ("Morse SMMMFN - Server ONLINE") — always reflects the
// real /api/health result, re-checked periodically so it flips to OFFLINE
// if the server stops responding, and back to ONLINE when it returns.
const HEALTH_POLL_MS = 15000;
let lastServerOnline = null;

function renderServerStatus() {
    const statusEl = document.getElementById('server-status-header');
    if (!statusEl) return;
    if (lastServerOnline === null) {
        statusEl.className = 'home-status';
        statusEl.textContent = t('auth.serverChecking');
        return;
    }
    statusEl.className = 'home-status ' + (lastServerOnline ? 'ok' : 'err');
    statusEl.textContent = t(lastServerOnline ? 'auth.serverOnlineUpper' : 'auth.serverOfflineUpper');
}

async function checkHealth() {
    const statusEl = document.getElementById('server-status-header');
    const shareBox = document.getElementById('share-box');
    const shareUrl = document.getElementById('share-url');

    try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        lastServerOnline = data.server_status === 'ONLINE';
        statusEl.title = `uptime ${data.uptime_seconds}s`;

        if (data.lan_url) {
            shareUrl.textContent = data.lan_url;
            shareBox.hidden = false;
        } else {
            shareUrl.textContent = t('auth.noLan');
            shareBox.hidden = false;
        }
    } catch (err) {
        lastServerOnline = false;
        statusEl.title = t('auth.couldNotReachServer') + ': ' + err.message;
    }
    renderServerStatus();
}

function showLoggedIn(user) {
    if (window.AppNav) window.AppNav.applyRole(user.role);
    document.getElementById('app-nav-links').hidden = false;
    document.getElementById('app-nav-right').hidden = false;
    document.getElementById('logged-out-view').hidden = true;
    document.getElementById('logged-in-view').hidden = false;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username;
    document.getElementById('current-user-name').textContent = `${name} (${user.username})`;
    document.getElementById('current-user-role').textContent = user.role === 'teacher' ? t('auth.roleTeacher') : t('auth.roleStudent');

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
        document.getElementById('profile-class').textContent = user.className || t('auth.noClassAssigned');
        document.getElementById('profile-status').textContent = user.isActive ? t('common.active') : t('common.inactive');
    }
}

function showLoggedOut() {
    if (window.AppNav) window.AppNav.applyRole(null);
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

// The server's error strings are fixed English literals (auth is out of
// scope for this localization pass per the task's constraints) — this
// maps the handful actually returned by /api/auth/login to translation
// keys so the login screen is still fully localized without touching
// server code. Anything not in this map falls back to the raw server
// message, same as before.
const SERVER_ERROR_KEYS = {
    'Username and password are required.': 'auth.errUsernamePasswordRequired',
    'Too many failed login attempts. Please try again in a few minutes.': 'auth.errTooManyAttempts',
    'Invalid username or password.': 'auth.invalidCredentials',
    'This account has been deactivated. Contact your teacher.': 'auth.errAccountDeactivated',
};

function localizeServerError(message) {
    const key = SERVER_ERROR_KEYS[message];
    return key ? t(key) : message;
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
                errorEl.textContent = data.error ? localizeServerError(data.error) : t('auth.loginFailed');
                errorEl.hidden = false;
                return;
            }

            document.getElementById('login-form').reset();
            showLoggedIn(data.user);
        } catch (err) {
            errorEl.textContent = t('auth.couldNotReachServer') + ': ' + err.message;
            errorEl.hidden = false;
        }
    });
}

checkHealth();
setInterval(checkHealth, HEALTH_POLL_MS);
wireLoginForm();
refreshAuthState();

// Re-render the handful of strings this page computes with t() itself
// (role label, "no class assigned", etc.) rather than via data-i18n,
// since a same-page language switch doesn't re-run this script's own
// rendering logic otherwise — everything declared with data-i18n is
// already handled by nav.js's applyTranslations() on this event.
document.addEventListener('morseTrainer:languageChanged', () => {
    refreshAuthState();
    renderServerStatus();
});
