/**
 * Shared across every page: nav bar logout wiring + scroll-reveal setup.
 * Loaded before each page's own script. Exposes `window.ScrollReveal` for
 * pages that have `.reveal-on-scroll` sections to opt into.
 */
(function () {
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
