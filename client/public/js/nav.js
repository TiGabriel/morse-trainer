/**
 * Shared across every page: nav bar logout wiring, light/dark theme
 * toggle, and scroll-reveal setup. Loaded before each page's own script.
 * Exposes `window.ScrollReveal` for pages that have `.reveal-on-scroll`
 * sections to opt into.
 *
 * The theme itself is already applied before this file even runs — each
 * page has an identical tiny inline script at the top of <head> that
 * reads localStorage and sets document.documentElement's data-theme
 * attribute synchronously, before the stylesheet is parsed, so there's
 * no flash of the wrong theme while nav.js and the rest of the page's
 * scripts load. This file only has to wire the toggle button and keep
 * localStorage in sync with it.
 */
(function () {
    const THEME_KEY = 'morseTrainerTheme';

    function applyThemeButtonLabel(theme) {
        const button = document.getElementById('theme-toggle-button');
        if (!button) return;
        const isDark = theme === 'dark';
        const label = window.t ? window.t(isDark ? 'nav.themeToLight' : 'nav.themeToDark')
            : (isDark ? 'Switch to light theme' : 'Switch to dark theme');
        button.textContent = isDark ? '☀️' : '🌙'; // sun / crescent moon
        button.setAttribute('aria-label', label);
        button.title = label;
    }

    function wireThemeToggle() {
        const button = document.getElementById('theme-toggle-button');
        const currentTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
        applyThemeButtonLabel(currentTheme);
        if (!button) return;

        button.addEventListener('click', () => {
            const nextTheme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
            document.documentElement.dataset.theme = nextTheme;
            try {
                localStorage.setItem(THEME_KEY, nextTheme);
            } catch {
                // Private browsing / storage disabled — theme still applies for this page load,
                // it just won't be remembered on the next one.
            }
            applyThemeButtonLabel(nextTheme);
        });
    }

    /**
     * Language selector — same "already applied before this file runs"
     * contract as the theme toggle: each page's inline <head> script
     * sets document.documentElement.dataset.lang synchronously (see
     * i18n.js's header comment), so by the time this runs the correct
     * language is already showing; this just wires the two buttons and
     * keeps them in sync, then does the one full-page translation pass
     * every page needs (i18n.js itself never touches the DOM).
     */
    function applyLangButtonState(lang) {
        const buttons = document.querySelectorAll('#lang-toggle [data-lang-btn]');
        buttons.forEach((btn) => {
            const isCurrent = btn.dataset.langBtn === lang;
            btn.classList.toggle('is-active', isCurrent);
            btn.setAttribute('aria-pressed', String(isCurrent));
        });
    }

    function wireLanguageToggle() {
        if (!window.I18N) return;
        applyLangButtonState(window.I18N.getLanguage());
        document.querySelectorAll('#lang-toggle [data-lang-btn]').forEach((btn) => {
            btn.addEventListener('click', () => {
                window.I18N.setLanguage(btn.dataset.langBtn);
            });
        });
        document.addEventListener('morseTrainer:languageChanged', (e) => {
            applyLangButtonState(e.detail.language);
            applyThemeButtonLabel(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
        });
    }

    if (window.I18N) window.I18N.applyTranslations();
    wireThemeToggle();
    wireLanguageToggle();

    /**
     * Role-based nav items. Anything marked `data-nav-role="teacher"`
     * (the Teacher Panel and Catalog electronic links) ships `hidden` in
     * the HTML and is only revealed once the logged-in user's ACTUAL role
     * — from the server's /api/auth/me, never from anything cached
     * client-side — is confirmed to be teacher; for a student it's
     * removed outright. Purely cosmetic: those pages are also refused
     * server-side for non-teachers, and every API behind them is
     * requireRole('teacher').
     */
    function applyNavRole(role) {
        document.querySelectorAll('[data-nav-role]').forEach((link) => {
            link.hidden = link.dataset.navRole !== role;
        });
    }

    async function loadNavRole() {
        if (!document.querySelector('[data-nav-role]')) return;
        try {
            const res = await fetch('/api/auth/me');
            if (!res.ok) return; // logged out — teacher-only links stay hidden
            const data = await res.json();
            applyNavRole(data.user && data.user.role);
        } catch {
            // Server unreachable — leave teacher-only links hidden.
        }
    }

    // index.html logs in/out without a page reload, so it re-applies the
    // role itself through this hook (see app.js's showLoggedIn/showLoggedOut).
    window.AppNav = { applyRole: applyNavRole };
    loadNavRole();

    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            try {
                await fetch('/api/auth/logout', { method: 'POST' });
            } catch {
                // Ignore network errors — redirecting to "/" re-checks auth state either way.
            }
            window.location.href = '/';
        });
    }

    /**
     * Sets up an IntersectionObserver-driven reveal for elements matching
     * `selector`. Progressive enhancement only: `body.js-reveal-ready` (the
     * class the CSS actually keys the hidden/animated state off of) is added
     * ONLY once the observer is confirmed created, and only elements that
     * are actually being observed can ever end up with the pre-reveal
     * opacity:0 state — so a section that's never observed (e.g. because a
     * page never calls this, or IntersectionObserver isn't supported)
     * simply stays at its CSS default of fully visible. See styles.css's
     * `.reveal-on-scroll` rules for the other half of this contract.
     */
    function observe(selector) {
        const elements = document.querySelectorAll(selector);
        if (elements.length === 0) return;
        if (!('IntersectionObserver' in window)) return;

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible');
                        observer.unobserve(entry.target);
                    }
                });
            },
            { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
        );

        document.body.classList.add('js-reveal-ready');
        elements.forEach((el) => observer.observe(el));
    }

    window.ScrollReveal = { observe };

    // -----------------------------------------------------------------
    // Hidden "Morse Receiver" secret activation.
    //
    // Not referenced anywhere in navigation/menus/routes — the only way
    // to reach it is typing P-O-O-P (case-insensitive) in sequence
    // outside any text field. This tiny always-present listener is all
    // that's loaded on every page; the actual receiver (Web Audio
    // microphone processing + UI) lives in morse-receiver-core.js and
    // morse-receiver-ui.js, which are only fetched — via a plain
    // dynamically-created <script> tag, not import()/fetch of anything
    // executable-as-data — the moment the sequence completes. Until
    // then, nothing but this listener exists on the page.
    // -----------------------------------------------------------------
    const SECRET_SEQUENCE = ['P', 'O', 'O', 'P'];
    const SECRET_INACTIVITY_TIMEOUT_MS = 2500;
    let secretProgress = 0;
    let secretTimeoutId = null;
    let secretModulesLoaded = false;
    let secretModulesLoading = false;

    function isTypingContext(target) {
        if (!target || typeof target !== 'object') return false;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        return !!target.isContentEditable;
    }

    function resetSecretProgress() {
        secretProgress = 0;
        if (secretTimeoutId) {
            clearTimeout(secretTimeoutId);
            secretTimeoutId = null;
        }
    }

    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.addEventListener('load', () => resolve());
            script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
            document.head.appendChild(script);
        });
    }

    async function openSecretReceiver() {
        if (secretModulesLoading) return;
        if (!secretModulesLoaded) {
            secretModulesLoading = true;
            try {
                // Strict order: core reads the map at load time, and the
                // UI reads core.ReceiverState at open() time.
                await loadScriptOnce('/js/morse-receiver-map.js');
                await loadScriptOnce('/js/morse-receiver-core.js');
                await loadScriptOnce('/js/morse-receiver-ui.js');
                secretModulesLoaded = true;
            } catch {
                // A hidden easter egg failing to load silently is
                // correct here — there is deliberately no visible UI to
                // surface an error into, and it must never announce its
                // own existence.
                secretModulesLoading = false;
                return;
            }
            secretModulesLoading = false;
        }
        if (window.MorseReceiverUI) window.MorseReceiverUI.open();
    }

    function onSecretKeydown(e) {
        // Only a real, single, physical, unmodified keystroke can ever
        // advance the sequence:
        //  - e.isTrusted excludes synthetic/programmatic dispatch, which
        //    is how a pasted string could otherwise "type" P-O-O-P.
        //  - e.repeat excludes a held key auto-repeating (so holding "O"
        //    can never contribute two O's from one physical press).
        //  - the modifier check excludes actual keyboard shortcuts.
        //  - isTypingContext excludes every real text-entry field.
        if (!e.isTrusted) return;
        if (e.repeat) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (isTypingContext(e.target)) return;
        if (typeof e.key !== 'string' || e.key.length !== 1) return;

        const key = e.key.toUpperCase();
        const expected = SECRET_SEQUENCE[secretProgress];

        if (key === expected) {
            secretProgress += 1;
            if (secretTimeoutId) clearTimeout(secretTimeoutId);
            if (secretProgress === SECRET_SEQUENCE.length) {
                resetSecretProgress();
                openSecretReceiver();
                return;
            }
            secretTimeoutId = setTimeout(resetSecretProgress, SECRET_INACTIVITY_TIMEOUT_MS);
            return;
        }

        // Wrong key: reset, but let it start a fresh attempt if it's
        // itself the sequence's first letter (e.g. "P-O-P-O-O-P" must
        // still open the receiver via its trailing P-O-O-P).
        resetSecretProgress();
        if (key === SECRET_SEQUENCE[0]) {
            secretProgress = 1;
            secretTimeoutId = setTimeout(resetSecretProgress, SECRET_INACTIVITY_TIMEOUT_MS);
        }
    }

    document.addEventListener('keydown', onSecretKeydown);

    // -----------------------------------------------------------------
    // Hidden "reveal correct answer" popup.
    //
    // Not referenced anywhere in navigation/menus/routes — the only way
    // to reach it is typing P-O-O-U (case-insensitive) in sequence,
    // anywhere on the page, including while focused in an answer
    // input/textarea (that's the point: it's meant to work mid-exercise).
    // Completely independent state machine from the P-O-O-P receiver
    // above — they share no variables, only the same physical keydown
    // events, so typing either sequence never disturbs the other's
    // progress.
    //
    // This module never computes or guesses an answer. It only ever
    // displays whatever the currently active exercise script has
    // published via `window.AnswerReveal.publish(...)` — the same
    // authoritative answer data already legitimately held in that
    // script's own client-side state for the item currently on screen.
    // If nothing has been published (no active exercise, or the
    // student has moved on), it shows a small "no active exercise"
    // notice instead of fabricating or inferring anything.
    // -----------------------------------------------------------------
    const ANSWER_SEQUENCE = ['P', 'O', 'O', 'U'];
    const ANSWER_INACTIVITY_TIMEOUT_MS = 2000;
    let answerProgress = 0;
    let answerTimeoutId = null;

    function resetAnswerProgress() {
        answerProgress = 0;
        if (answerTimeoutId) {
            clearTimeout(answerTimeoutId);
            answerTimeoutId = null;
        }
    }

    let currentAnswerInfo = null;

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    let answerModalEls = null;

    function ensureAnswerModal() {
        if (answerModalEls) return answerModalEls;

        const style = document.createElement('style');
        style.textContent = `
            .ar-backdrop {
                position: fixed; inset: 0; z-index: 99999;
                background: rgba(0, 0, 0, 0.6);
                display: flex; align-items: center; justify-content: center;
                padding: 1rem;
            }
            .ar-modal {
                position: relative;
                width: 100%; max-width: min(92vw, 560px);
                background: var(--surface, #16233d);
                border: 1px solid var(--border-strong, #3c4f6d);
                border-radius: var(--r-lg, 14px);
                box-shadow: var(--shadow-md, 0 6px 18px rgba(0,0,0,0.35));
                padding: 1.5rem 1.75rem;
                text-align: center;
                font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                animation: ar-pop 140ms ease-out;
            }
            @keyframes ar-pop {
                from { opacity: 0; transform: scale(0.96); }
                to { opacity: 1; transform: scale(1); }
            }
            .ar-close-btn {
                position: absolute; top: 0.4rem; right: 0.6rem;
                background: none; border: none; cursor: pointer;
                font-size: 1.3rem; line-height: 1; padding: 0.3rem;
                color: var(--text-faint, #71809b);
            }
            .ar-close-btn:hover { color: var(--text, #e7ecf4); }
            .ar-title {
                margin: 0 0 0.4rem; font-size: 1.05rem; font-weight: 600;
                color: var(--text, #e7ecf4);
            }
            .ar-context {
                margin: 0 0 0.9rem; font-size: 0.76rem;
                text-transform: uppercase; letter-spacing: 0.06em;
                color: var(--text-muted, #a4b1c7);
            }
            .ar-answer {
                font-family: "Courier New", monospace;
                font-size: 1.1rem; font-weight: 600; line-height: 1.6;
                letter-spacing: 0.03em; white-space: pre-wrap; word-break: break-word;
                color: var(--accent, #3d7ab8);
                background: var(--bg, #0a1220);
                border: 1px dashed var(--border-strong, #3c4f6d);
                border-radius: var(--r-sm, 8px);
                padding: 0.9rem 1rem;
            }
            .ar-empty {
                margin: 0.25rem 0 0; font-size: 0.9rem;
                color: var(--text-muted, #a4b1c7);
            }
        `;
        document.head.appendChild(style);

        const backdrop = document.createElement('div');
        backdrop.className = 'ar-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="ar-modal" role="dialog" aria-modal="true" aria-labelledby="ar-title">
                <button type="button" class="ar-close-btn" aria-label="Close">&times;</button>
                <h3 class="ar-title" id="ar-title">Correct Answer</h3>
                <div class="ar-body"></div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const modal = backdrop.querySelector('.ar-modal');
        const titleEl = backdrop.querySelector('.ar-title');
        const bodyEl = backdrop.querySelector('.ar-body');
        const closeBtn = backdrop.querySelector('.ar-close-btn');

        function close() {
            backdrop.hidden = true;
            document.removeEventListener('keydown', onKeydown, true);
        }

        function onKeydown(e) {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
            }
        }

        backdrop.addEventListener('mousedown', (e) => {
            if (e.target === backdrop) close();
        });
        closeBtn.addEventListener('click', close);

        function open() {
            document.addEventListener('keydown', onKeydown, true);
            backdrop.hidden = false;
        }

        answerModalEls = { backdrop, modal, titleEl, bodyEl, open, close };
        return answerModalEls;
    }

    function openAnswerRevealPopup() {
        const els = ensureAnswerModal();
        if (!currentAnswerInfo || !currentAnswerInfo.answer) {
            els.titleEl.textContent = 'No Active Exercise';
            els.bodyEl.innerHTML = '<p class="ar-empty">Nothing to reveal right now.</p>';
        } else {
            els.titleEl.textContent = 'Correct Answer';
            const contextHtml = currentAnswerInfo.label
                ? `<p class="ar-context">${escapeHtml(currentAnswerInfo.label)}</p>`
                : '';
            els.bodyEl.innerHTML = `${contextHtml}<div class="ar-answer">${escapeHtml(currentAnswerInfo.answer)}</div>`;
        }
        els.open();
    }

    function onAnswerRevealKeydown(e) {
        // Deliberately no isTypingContext restriction here — the whole
        // point is that it works while the student is mid-answer in an
        // input/textarea. Still ignores synthetic dispatch, key-repeat,
        // and modifier combos so it can't be triggered by anything but
        // a real, deliberate P-O-O-U keystroke sequence.
        if (!e.isTrusted) return;
        if (e.repeat) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (typeof e.key !== 'string' || e.key.length !== 1) return;

        const key = e.key.toUpperCase();
        const expected = ANSWER_SEQUENCE[answerProgress];

        if (key === expected) {
            if (answerProgress === 0) rememberAnswerField(e.target);
            answerProgress += 1;
            if (answerTimeoutId) clearTimeout(answerTimeoutId);
            if (answerProgress === ANSWER_SEQUENCE.length) {
                // Opening the popup must never change the student's
                // answer: swallow the final key and put the field back
                // exactly as it was before the sequence's first key.
                e.preventDefault();
                restoreAnswerField(e.target);
                resetAnswerProgress();
                openAnswerRevealPopup();
                return;
            }
            answerTimeoutId = setTimeout(resetAnswerProgress, ANSWER_INACTIVITY_TIMEOUT_MS);
            return;
        }

        resetAnswerProgress();
        if (key === ANSWER_SEQUENCE[0]) {
            rememberAnswerField(e.target);
            answerProgress = 1;
            answerTimeoutId = setTimeout(resetAnswerProgress, ANSWER_INACTIVITY_TIMEOUT_MS);
        }
    }

    // Snapshot of the text field (if any) the sequence started in, taken at
    // its first key — before that key is inserted — so completing the
    // sequence can undo the sequence's own letters and nothing else.
    let answerFieldSnapshot = null;

    function isEditableTextField(target) {
        return !!target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && /^(text|search|)$/i.test(target.type || '')));
    }

    function rememberAnswerField(target) {
        answerFieldSnapshot = isEditableTextField(target)
            ? { target, value: target.value, selectionStart: target.selectionStart, selectionEnd: target.selectionEnd }
            : null;
    }

    function restoreAnswerField(target) {
        const snap = answerFieldSnapshot;
        answerFieldSnapshot = null;
        if (!snap || snap.target !== target) return;
        target.value = snap.value;
        try {
            target.setSelectionRange(snap.selectionStart, snap.selectionEnd);
        } catch {
            // Some input types don't support selection — value is restored either way.
        }
    }

    document.addEventListener('keydown', onAnswerRevealKeydown);

    /**
     * Registry other page scripts publish the CURRENT exercise item's
     * authoritative correct answer to (and clear when no item is active).
     * This module never derives/guesses an answer itself — it only ever
     * displays whatever was last published here.
     *
     *   window.AnswerReveal.publish({ label: 'Character Training', answer: 'K' });
     *   window.AnswerReveal.clear();
     */
    window.AnswerReveal = {
        publish(info) {
            if (!info || typeof info.answer !== 'string' || !info.answer) {
                currentAnswerInfo = null;
                return;
            }
            currentAnswerInfo = { label: info.label || '', answer: info.answer };
        },
        clear() {
            currentAnswerInfo = null;
        },
    };
})();
