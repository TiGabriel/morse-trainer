/**
 * Training Speed Progression — one shared, centrally-defined list of WPM
 * steps for "Quick WPM" preset chips, reused by every settings screen
 * that offers one (Reception, Transmission) rather than each page
 * hardcoding its own copy of the list. Add/remove/reorder speeds here
 * only — nothing else in the app should ever hardcode this sequence.
 *
 * Dual browser-global / CommonJS export, same pattern as the other
 * dependency-free shared client modules (morse-audio-player.js,
 * character-pool.js) — no build step, so every page includes this file
 * with a <script> tag.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else {
        root.SpeedProgression = api;
    }
})(typeof window !== 'undefined' ? window : globalThis, function () {
    // Allow additional speeds later: append/insert here — every consumer
    // (see renderSpeedProgressionChips) rebuilds its chips from this
    // array, so a page never needs its own edit to pick up a change.
    const SPEED_PROGRESSION_WPM = [10, 12, 14, 16, 18];

    /**
     * Builds one "chip" button per progression step inside `containerId`,
     * calling `onSelect(wpm)` when the teacher/student clicks one — the
     * exact same chip-button markup/behavior every other quick-preset
     * row in this app already uses (character pool presets, session
     * length), just generated from SPEED_PROGRESSION_WPM instead of
     * written out per page.
     */
    function renderSpeedProgressionChips(containerId, onSelect) {
        const container = typeof document !== 'undefined' ? document.getElementById(containerId) : null;
        if (!container) return;
        container.innerHTML = '';
        SPEED_PROGRESSION_WPM.forEach((wpm) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chip-button';
            btn.dataset.wpm = String(wpm);
            btn.textContent = `${wpm} WPM`;
            btn.addEventListener('click', () => onSelect(wpm));
            container.appendChild(btn);
        });
    }

    return { SPEED_PROGRESSION_WPM, renderSpeedProgressionChips };
});
