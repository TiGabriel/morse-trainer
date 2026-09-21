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
        button.textContent = isDark ? '☀️' : '🌙'; // sun / crescent moon
        button.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
        button.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
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

    wireThemeToggle();

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
})();
