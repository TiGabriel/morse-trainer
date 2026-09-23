/**
 * Morse Alphabet reference page — for every logged-in user (teacher and
 * student). Rendered entirely from GET /api/morse/alphabet, which is
 * generated from the server's canonical morseMap.js (the same table every
 * exercise, test and decoder uses), so this page can never show a
 * character/code the application doesn't actually support, and there is
 * no second hand-written Morse table here to drift out of sync.
 *
 * Clicking a character plays it through the existing shared
 * MorseAudioPlayer using the server-built playback plan for that
 * character — no audio files, no network, no second audio engine.
 */
function el(id) {
    return document.getElementById(id);
}

let alphabetData = null;
let player = null;
let playingButton = null;

function ensurePlayer() {
    if (!player) {
        player = new MorseAudioPlayer({
            toneFrequencyHz: alphabetData ? alphabetData.toneFrequencyHz : 600,
            volume: 0.6,
            onEnd: () => clearPlaying(),
            onStop: () => clearPlaying(),
        });
    }
    return player;
}

function clearPlaying() {
    if (playingButton) playingButton.classList.remove('is-playing');
    playingButton = null;
}

/** Shows the pattern with typographic dot/dash glyphs for readability — the underlying data (and the aria-label) stay the canonical ".-" string. */
function prettyMorse(morse) {
    return morse.replace(/\./g, '·').replace(/-/g, '−');
}

function renderGroup(key, list) {
    const grid = el(`alphabet-${key}`);
    grid.innerHTML = '';
    list.forEach((entry) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'alphabet-card';
        btn.dataset.char = entry.char;
        btn.setAttribute('aria-label', `${t('alphabet.playChar', { char: entry.char })}: ${entry.morse}`);
        btn.title = t('alphabet.playChar', { char: entry.char });

        const charEl = document.createElement('span');
        charEl.className = 'alphabet-char';
        charEl.textContent = entry.char;
        const codeEl = document.createElement('span');
        codeEl.className = 'alphabet-code';
        codeEl.textContent = prettyMorse(entry.morse);

        btn.append(charEl, codeEl);
        btn.addEventListener('click', () => playEntry(entry, btn));
        grid.appendChild(btn);
    });
    const counter = document.querySelector(`[data-count-for="${key}"]`);
    if (counter) counter.textContent = t('alphabet.countChars', { count: list.length });
}

function renderAll() {
    if (!alphabetData) return;
    el('alphabet-play-hint').textContent = t('alphabet.playHint', { wpm: alphabetData.wpm, hz: alphabetData.toneFrequencyHz });
    renderGroup('letters', alphabetData.letters);
    renderGroup('numbers', alphabetData.numbers);
    renderGroup('punctuation', alphabetData.punctuation);
}

async function playEntry(entry, button) {
    const p = ensurePlayer();
    p.stop();
    p.loadPlan(entry.plan, { durationMs: entry.durationMs });
    clearPlaying();
    playingButton = button;
    button.classList.add('is-playing');
    try {
        await p.play();
    } catch {
        clearPlaying(); // no Web Audio support — the page still works as a reference
    }
}

async function init() {
    let user;
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) throw new Error('unauthenticated');
        ({ user } = await res.json());
    } catch {
        window.location.href = '/';
        return;
    }

    el('auth-gate').hidden = true;
    el('dashboard').hidden = false;
    el('user-name').textContent = `${user.firstName || ''} ${user.lastName || ''} (${user.username})`.trim();
    // Students join sessions from group-session.html; teachers run them from sessions.html.
    if (user.role === 'student') el('nav-group-sessions').href = '/group-session.html';

    try {
        const res = await fetch('/api/morse/alphabet');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        alphabetData = data;
        renderAll();
    } catch (err) {
        const box = el('alphabet-error');
        box.textContent = t('alphabet.loadError', { message: err.message });
        box.hidden = false;
    }

    document.addEventListener('morseTrainer:languageChanged', renderAll);
}

init();
