/**
 * Hidden "SMMMFN Lucky Slots" easter egg — UI. A purely fictional demo
 * mini-game played with virtual Demo Credits that have no value of any
 * kind. No payments, no server calls, no network requests.
 *
 * 5 reels x 3 rows, 10 paylines, adjustable bet per line / active lines,
 * WILD / SCATTER / BONUS, tiered win presentation (small / medium / BIG
 * WIN / JACKPOT with a contained money-rain). All rules, payouts and
 * paylines live in js/slot-machine-engine.js (window.SlotMachineEngine);
 * this file only presents results the engine returns.
 *
 * Not referenced anywhere in navigation/menus/routes — the only way in
 * is typing S-L-O-T (case-insensitive) outside any text field. Nothing
 * but the key listener below exists on the page until then; the modal's
 * DOM is built on first activation.
 *
 * Fully isolated from the training app: it never reads or writes any
 * exercise, session, grade or statistics state. While the modal is open
 * it swallows keydown events at the window capture phase so its own
 * Space/Enter/letter presses can never reach a page's exercise handlers
 * (Character Training answers, Transmission keying, other hidden
 * sequences). Keyup is deliberately left alone — every page's keyup
 * handler is gated on its own keydown state, and letting releases
 * through means a key held while the modal opened can never get stuck.
 *
 * Every timer and animation frame goes through later()/frame() so
 * closing the modal (or starting the next spin) cancels all of them and
 * removes every particle — nothing keeps running in the background.
 */
(function () {
    // -----------------------------------------------------------------
    // Configuration — presentation only (game rules: slot-machine-engine.js).
    // -----------------------------------------------------------------
    const SECRET_SEQUENCE = ['S', 'L', 'O', 'T'];
    const SECRET_INACTIVITY_TIMEOUT_MS = 1500;

    const CREDITS_KEY = 'morseTrainerSlotsDemoCredits';
    const SETTINGS_KEY = 'morseTrainerSlotsDemoSettings';
    const STARTING_CREDITS = 1000;

    const GLYPHS = {
        crown: '👑',
        anchor: '⚓',
        ship: '🚢',
        radio: '📡',
        star: '⭐',
        diamond: '💎',
        cherry: '🍒',
        trident: '🔱',
        wild: '🃏',
        scatter: '💫',
        bonus: '🎁',
    };
    const SPECIAL_SYMBOLS = ['wild', 'scatter', 'bonus'];

    // One colour per payline (line n uses LINE_COLORS[n - 1]).
    const LINE_COLORS = ['#f2c14e', '#ef6f6c', '#4cc9a0', '#5aa9e6', '#c77dff', '#ff9f43', '#2ec4b6', '#f15bb5', '#a3d65c', '#b5838d'];

    // Reel stop times (ms after SPIN) — staggered so reels land 1 → 5.
    const REEL_STOP_MS = [800, 1050, 1300, 1550, 1800];
    const REEL_STOP_MS_REDUCED = [120, 200, 280, 360, 440];
    // Extra suspense per remaining reel once 2 SCATTERs/BONUSes have landed.
    const ANTICIPATION_MS = 450;

    const WIN_FX = {
        small: { countMs: 500, confetti: 0, money: 0 },
        medium: { countMs: 1000, confetti: 16, money: 0 },
        bonus: { countMs: 1400, confetti: 18, money: 0, overlayMs: 2400 },
        big: { countMs: 1800, confetti: 26, money: 10, overlayMs: 2900 },
        jackpot: { countMs: 2800, confetti: 24, money: 34, overlayMs: 4400 },
    };
    const PARTICLE_LIFETIME_MS = 4600;

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------
    function loadCredits() {
        try {
            const raw = localStorage.getItem(CREDITS_KEY);
            if (raw === null) return STARTING_CREDITS;
            const value = Number(raw);
            return Number.isSafeInteger(value) && value >= 0 ? value : STARTING_CREDITS;
        } catch {
            return STARTING_CREDITS;
        }
    }

    function saveCredits(value) {
        try {
            localStorage.setItem(CREDITS_KEY, String(value));
        } catch {
            // Storage disabled — the balance still works for this page load.
        }
    }

    function loadSettings(engine) {
        const fallback = { betPerLine: engine.BET_OPTIONS[0], lines: engine.MAX_LINES };
        try {
            const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (!parsed) return fallback;
            const betPerLine = engine.BET_OPTIONS.includes(parsed.betPerLine) ? parsed.betPerLine : fallback.betPerLine;
            const lines = Number.isInteger(parsed.lines) && parsed.lines >= 1 && parsed.lines <= engine.MAX_LINES ? parsed.lines : fallback.lines;
            return { betPerLine, lines };
        } catch {
            return fallback;
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(bet));
        } catch {
            // Storage disabled — settings still apply for this page load.
        }
    }

    const tr = (key, params) => (window.t ? window.t(key, params) : key);
    const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const engine = () => window.SlotMachineEngine;
    const symbolName = (id) => tr(`slots.symbols.${id}`);

    // -----------------------------------------------------------------
    // Modal state
    // -----------------------------------------------------------------
    let els = null;
    let isOpen = false;
    let credits = loadCredits();
    let bet = null; // { betPerLine, lines } — set on first build
    let grid = null; // grid[reel][row] currently showing
    let spinning = false;
    let celebrating = false;
    let pendingSpin = null; // engine result while reels are moving
    let timers = [];
    let frames = [];
    let previousFocus = null;
    // What the message area currently shows — a plain i18n key or a spin
    // result — so a language switch can re-render it in the new language.
    let shown = { key: 'slots.ready' };

    function later(fn, ms) {
        const id = setTimeout(() => {
            timers = timers.filter((t) => t !== id);
            fn();
        }, ms);
        timers.push(id);
    }

    function frame(fn) {
        const id = requestAnimationFrame((ts) => {
            frames = frames.filter((f) => f !== id);
            fn(ts);
        });
        frames.push(id);
    }

    function clearTimers() {
        timers.forEach(clearTimeout);
        timers = [];
        frames.forEach(cancelAnimationFrame);
        frames = [];
    }

    function cellHtml(id) {
        const caption = SPECIAL_SYMBOLS.includes(id) ? `<span class="slots-cap">${id.toUpperCase()}</span>` : '';
        return `<span class="slots-cell" data-sym="${id}"><span class="slots-glyph">${GLYPHS[id]}</span>${caption}</span>`;
    }

    /** Idle strip: exactly the 3 visible cells, at rest. */
    function setIdleStrip(reel, column) {
        const strip = els.strips[reel];
        strip.style.transition = 'none';
        strip.style.transform = 'translateY(0)';
        strip.innerHTML = column.map(cellHtml).join('');
        strip.classList.remove('is-blurred');
        labelReel(reel, column);
    }

    function labelReel(reel, column) {
        els.reels[reel].setAttribute('aria-label', tr('slots.reelLabel', {
            n: reel + 1,
            symbols: column.map(symbolName).join(', '),
        }));
    }

    function cellAt(reel, row) {
        return els.strips[reel].children[row];
    }

    // -----------------------------------------------------------------
    // DOM
    // -----------------------------------------------------------------
    function stepperHtml(name) {
        return `
            <div class="slots-stepper">
                <span class="slots-stepper-label" data-slots="${name}-label"></span>
                <div class="slots-stepper-row">
                    <button type="button" class="slots-step" data-slots="${name}-down">&minus;</button>
                    <output class="slots-stepper-value" data-slots="${name}-value"></output>
                    <button type="button" class="slots-step" data-slots="${name}-up">+</button>
                </div>
            </div>`;
    }

    function buildDom() {
        const E = engine();
        const backdrop = document.createElement('div');
        backdrop.className = 'slots-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="slots-frame">
                <div class="slots-modal" role="dialog" aria-modal="true" aria-labelledby="slots-title" aria-describedby="slots-note">
                    <button type="button" class="slots-close" data-slots="close">&times;</button>
                    <h2 class="slots-title" id="slots-title"></h2>
                    <p class="slots-note" id="slots-note"></p>
                    <dl class="slots-stats">
                        <div class="slots-stat slots-stat-credits"><dt data-slots="credits-label"></dt><dd class="slots-credits-value" data-slots="credits-value"></dd></div>
                        <div class="slots-stat"><dt data-slots="bpl-label"></dt><dd data-slots="bpl-value"></dd></div>
                        <div class="slots-stat"><dt data-slots="lines-stat-label"></dt><dd data-slots="lines-stat-value"></dd></div>
                        <div class="slots-stat"><dt data-slots="total-label"></dt><dd data-slots="total-value"></dd></div>
                    </dl>
                    <div class="slots-machine" data-slots="machine">
                        <div class="slots-reels" role="group" data-slots="reels">
                            ${Array.from({ length: E.REELS }, () => '<div class="slots-reel" role="img"><div class="slots-strip"></div></div>').join('')}
                        </div>
                        <svg class="slots-lines" viewBox="0 0 ${E.REELS * 100} ${E.ROWS * 100}" preserveAspectRatio="none" aria-hidden="true" data-slots="lines-svg">
                            ${E.PAYLINES.map((rows, i) => `<polyline data-line="${i + 1}" stroke="${LINE_COLORS[i]}" points="${rows.map((row, reel) => `${reel * 100 + 50},${row * 100 + 50}`).join(' ')}" />`).join('')}
                        </svg>
                    </div>
                    <div class="slots-result">
                        <p class="slots-message" data-slots="message"></p>
                        <p class="slots-win" data-slots="win"></p>
                        <ul class="slots-line-list" data-slots="line-list"></ul>
                    </div>
                    <p class="slots-sr-only" role="status" aria-live="polite" data-slots="announce"></p>
                    <div class="slots-controls">
                        ${stepperHtml('bet')}
                        <button type="button" class="btn btn-primary slots-spin" data-slots="spin"></button>
                        ${stepperHtml('lines')}
                    </div>
                    <p class="slots-warning" data-slots="warning" hidden></p>
                    <div class="slots-empty" data-slots="empty" hidden>
                        <p class="slots-empty-text" data-slots="empty-text"></p>
                        <button type="button" class="btn btn-secondary" data-slots="reset"></button>
                    </div>
                    <details class="slots-payouts">
                        <summary data-slots="payouts-title"></summary>
                        <div class="slots-paytable" data-slots="paytable"></div>
                    </details>
                </div>
                <div class="slots-fx" aria-hidden="true" data-slots="fx"></div>
                <div class="slots-celebration" aria-hidden="true" data-slots="celebration" hidden>
                    <div class="slots-celebration-inner">
                        <p class="slots-celebration-title" data-slots="celebration-title"></p>
                        <p class="slots-celebration-amount" data-slots="celebration-amount"></p>
                        <p class="slots-celebration-hint" data-slots="celebration-hint"></p>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);

        const q = (name) => backdrop.querySelector(`[data-slots="${name}"]`);
        els = {
            backdrop,
            frame: backdrop.querySelector('.slots-frame'),
            modal: backdrop.querySelector('.slots-modal'),
            title: backdrop.querySelector('.slots-title'),
            note: backdrop.querySelector('.slots-note'),
            close: q('close'),
            creditsLabel: q('credits-label'),
            creditsValue: q('credits-value'),
            bplLabel: q('bpl-label'),
            bplValue: q('bpl-value'),
            linesStatLabel: q('lines-stat-label'),
            linesStatValue: q('lines-stat-value'),
            totalLabel: q('total-label'),
            totalValue: q('total-value'),
            machine: q('machine'),
            reelsGroup: q('reels'),
            reels: Array.from(backdrop.querySelectorAll('.slots-reel')),
            strips: Array.from(backdrop.querySelectorAll('.slots-strip')),
            linesSvg: q('lines-svg'),
            linePaths: Array.from(backdrop.querySelectorAll('.slots-lines polyline')),
            message: q('message'),
            win: q('win'),
            lineList: q('line-list'),
            announce: q('announce'),
            spin: q('spin'),
            betLabel: q('bet-label'),
            betValue: q('bet-value'),
            betDown: q('bet-down'),
            betUp: q('bet-up'),
            linesLabel: q('lines-label'),
            linesValue: q('lines-value'),
            linesDown: q('lines-down'),
            linesUp: q('lines-up'),
            warning: q('warning'),
            empty: q('empty'),
            emptyText: q('empty-text'),
            reset: q('reset'),
            payoutsTitle: q('payouts-title'),
            paytable: q('paytable'),
            fx: q('fx'),
            celebration: q('celebration'),
            celebrationTitle: q('celebration-title'),
            celebrationAmount: q('celebration-amount'),
            celebrationHint: q('celebration-hint'),
        };

        els.close.addEventListener('click', close);
        els.spin.addEventListener('click', spin);
        els.reset.addEventListener('click', resetCredits);
        els.betDown.addEventListener('click', () => changeBet(-1));
        els.betUp.addEventListener('click', () => changeBet(1));
        els.linesDown.addEventListener('click', () => changeLines(-1));
        els.linesUp.addEventListener('click', () => changeLines(1));
        els.celebration.addEventListener('click', endCelebration);
        // Same outside-click behaviour as the app's other overlay popups:
        // only a press that starts on the backdrop itself closes it.
        backdrop.addEventListener('mousedown', (e) => {
            if (e.target === backdrop) close();
        });

        bet = loadSettings(E);
        grid = E.generateGrid();
        grid.forEach((column, reel) => setIdleStrip(reel, column));
        applyTexts();
    }

    /** Shows a plain status message (i18n key) in the result area. */
    function showMessage(key, params) {
        shown = { key, params };
        els.message.textContent = tr(key, params);
    }

    /** Re-renders the message area's text in the current language (no animation). */
    function renderShownText() {
        if (shown.result) {
            const r = shown.result;
            els.message.textContent = messageFor(r);
            if (r.totalWin > 0) {
                els.win.textContent = tr('slots.won', { amount: r.totalWin });
                if (!shown.quiet) renderLineList(r);
            }
            if (!els.celebration.hidden) els.celebrationTitle.textContent = celebrationTitle(els.celebration.dataset.kind);
        } else {
            els.message.textContent = tr(shown.key, shown.params);
        }
    }

    /** All static (language-dependent) labels. Safe to call any time, e.g. on a language switch. */
    function applyTexts() {
        els.title.textContent = tr('slots.title');
        els.note.textContent = tr('slots.demoNote');
        els.close.setAttribute('aria-label', tr('slots.close'));
        els.close.title = tr('slots.close');
        els.creditsLabel.textContent = tr('slots.credits');
        els.bplLabel.textContent = tr('slots.betPerLine');
        els.linesStatLabel.textContent = tr('slots.lines');
        els.totalLabel.textContent = tr('slots.totalBet');
        els.reelsGroup.setAttribute('aria-label', tr('slots.reels'));
        els.spin.textContent = tr('slots.spin');
        els.betLabel.textContent = tr('slots.betPerLine');
        els.linesLabel.textContent = tr('slots.lines');
        els.betDown.setAttribute('aria-label', tr('slots.betDown'));
        els.betUp.setAttribute('aria-label', tr('slots.betUp'));
        els.linesDown.setAttribute('aria-label', tr('slots.linesDown'));
        els.linesUp.setAttribute('aria-label', tr('slots.linesUp'));
        els.emptyText.textContent = tr('slots.empty');
        els.reset.textContent = tr('slots.reset');
        els.payoutsTitle.textContent = tr('slots.payouts');
        els.celebrationHint.textContent = tr('slots.skip');
        els.paytable.innerHTML = paytableHtml();
        if (!spinning) grid.forEach((column, reel) => labelReel(reel, column));
        renderShownText();
        renderStatus();
    }

    function paytableHtml() {
        const E = engine();
        const rows = E.LINE_SYMBOLS.map((id) => {
            const pays = E.SYMBOLS[id].pays;
            return `<tr><th scope="row"><span class="slots-pt-glyph">${GLYPHS[id]}</span> ${symbolName(id)}</th>`
                + `<td>${pays[3]}×</td><td>${pays[4]}×</td><td>${pays[5]}×</td></tr>`;
        }).join('');
        const scatterPays = E.SCATTER_PAYS;
        const special = [
            ['wild', tr('slots.wildRule', { symbol: GLYPHS[E.WILD_PAYS_AS] })],
            ['scatter', tr('slots.scatterRule', { three: scatterPays[3], four: scatterPays[4], five: scatterPays[5] })],
            ['bonus', tr('slots.bonusRule', { count: E.BONUS.minCount, mult: E.BONUS.totalBetMultiplier })],
        ].map(([id, text]) => `<li><span class="slots-cell slots-pt-special" data-sym="${id}"><span class="slots-glyph">${GLYPHS[id]}</span><span class="slots-cap">${id.toUpperCase()}</span></span><span>${text}</span></li>`).join('');
        const lines = E.PAYLINES.map((rowsForLine, i) => {
            const dots = [];
            for (let row = 0; row < E.ROWS; row++) {
                for (let reel = 0; reel < E.REELS; reel++) {
                    dots.push(`<i${rowsForLine[reel] === row ? ` class="on" style="background:${LINE_COLORS[i]}"` : ''}></i>`);
                }
            }
            return `<li><span class="slots-pl-num" style="color:${LINE_COLORS[i]}">${i + 1}</span><span class="slots-pl-grid">${dots.join('')}</span></li>`;
        }).join('');

        return `
            <p class="slots-pt-note">${tr('slots.payNote')}</p>
            <table class="slots-pt-table">
                <thead><tr><th scope="col">${tr('slots.payHeadSymbol')}</th><th scope="col">×3</th><th scope="col">×4</th><th scope="col">×5</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <ul class="slots-pt-specials">${special}</ul>
            <p class="slots-pt-jackpot">${tr('slots.jackpotRule', { count: E.JACKPOT.count, symbol: GLYPHS[E.JACKPOT.symbol] })}</p>
            <h3 class="slots-pt-heading">${tr('slots.paylinesTitle')}</h3>
            <ul class="slots-pt-lines">${lines}</ul>
        `;
    }

    // -----------------------------------------------------------------
    // Bet / status
    // -----------------------------------------------------------------
    const totalBet = () => engine().totalBetFor(bet.betPerLine, bet.lines);
    const minTotalBet = () => engine().BET_OPTIONS[0];

    /** aria-disabled rather than `disabled`, so a focused control never drops keyboard focus to <body>. */
    function setBlocked(button, blocked) {
        button.setAttribute('aria-disabled', String(blocked));
    }
    const isBlocked = (button) => button.getAttribute('aria-disabled') === 'true';

    function renderStatus() {
        if (!els) return;
        const E = engine();
        const busy = spinning || celebrating;
        const total = totalBet();
        const betIndex = E.BET_OPTIONS.indexOf(bet.betPerLine);

        els.creditsValue.textContent = String(credits);
        els.bplValue.textContent = String(bet.betPerLine);
        els.linesStatValue.textContent = String(bet.lines);
        els.totalValue.textContent = String(total);
        els.betValue.textContent = String(bet.betPerLine);
        els.linesValue.textContent = String(bet.lines);

        setBlocked(els.betDown, busy || betIndex <= 0);
        setBlocked(els.betUp, busy || betIndex >= E.BET_OPTIONS.length - 1);
        setBlocked(els.linesDown, busy || bet.lines <= 1);
        setBlocked(els.linesUp, busy || bet.lines >= E.MAX_LINES);

        const outOfCredits = credits < minTotalBet();
        const cantAfford = !outOfCredits && credits < total;
        setBlocked(els.spin, busy || outOfCredits || cantAfford);
        els.warning.hidden = spinning || !cantAfford;
        els.warning.textContent = cantAfford ? tr('slots.cantAfford') : '';
        els.empty.hidden = spinning || !outOfCredits;
    }

    function changeBet(direction) {
        if (spinning || celebrating) return;
        const options = engine().BET_OPTIONS;
        const next = options.indexOf(bet.betPerLine) + direction;
        if (next < 0 || next >= options.length) return;
        bet.betPerLine = options[next];
        saveSettings();
        renderStatus();
    }

    function changeLines(direction) {
        if (spinning || celebrating) return;
        const next = bet.lines + direction;
        if (next < 1 || next > engine().MAX_LINES) return;
        bet.lines = next;
        saveSettings();
        clearWinEffects();
        showMessage('slots.ready');
        previewActiveLines();
        renderStatus();
    }

    /** Briefly traces every active payline so the player sees what they're betting on. */
    function previewActiveLines() {
        els.linePaths.forEach((path, i) => {
            path.classList.remove('is-win');
            path.classList.toggle('is-preview', i < bet.lines);
        });
        later(() => els.linePaths.forEach((path) => path.classList.remove('is-preview')), 1200);
    }

    function restartAnimation(node, className) {
        node.classList.remove(className);
        void node.offsetWidth; // force reflow so the same animation can replay
        node.classList.add(className);
    }

    /** Removes every win highlight, particle, overlay and pending timer/frame. */
    function clearWinEffects() {
        clearTimers();
        celebrating = false;
        els.machine.classList.remove('has-win');
        els.frame.removeAttribute('data-win-tier');
        els.frame.classList.remove('is-jackpot-glow');
        els.reels.forEach((reel) => reel.classList.remove('is-landed', 'is-anticipating'));
        els.modal.querySelectorAll('.slots-cell.is-win').forEach((cell) => cell.classList.remove('is-win'));
        els.linePaths.forEach((path) => path.classList.remove('is-win', 'is-preview'));
        els.message.className = 'slots-message';
        els.win.textContent = '';
        els.win.className = 'slots-win';
        els.lineList.innerHTML = '';
        els.fx.innerHTML = '';
        els.celebration.hidden = true;
        els.celebration.className = 'slots-celebration';
    }

    // -----------------------------------------------------------------
    // Spin
    // -----------------------------------------------------------------
    function spin() {
        // Enter/click on SPIN while a celebration is showing skips it.
        if (celebrating) {
            endCelebration();
            return;
        }
        if (spinning || credits < totalBet() || !engine()) return;

        const E = engine();
        const result = E.spin({ betPerLine: bet.betPerLine, lines: bet.lines });
        credits -= result.totalBet;
        saveCredits(credits);

        clearWinEffects();
        pendingSpin = result;
        spinning = true;
        showMessage('slots.spinning');
        els.announce.textContent = '';
        els.modal.setAttribute('aria-busy', 'true');
        renderStatus();

        const reduced = prefersReducedMotion();
        const baseStops = reduced ? REEL_STOP_MS_REDUCED : REEL_STOP_MS;

        // Anticipation: once two SCATTERs or two BONUSes are already on
        // the landed reels, each remaining reel spins a little longer.
        const stops = [];
        let extra = 0;
        let scattersSoFar = 0;
        let bonusesSoFar = 0;
        result.grid.forEach((column, reel) => {
            const anticipating = !reduced && reel >= 2 && (scattersSoFar >= 2 || bonusesSoFar >= 2);
            if (anticipating) extra += ANTICIPATION_MS;
            stops.push({ at: baseStops[reel] + extra, anticipating });
            scattersSoFar += column.filter((id) => id === 'scatter').length;
            bonusesSoFar += column.filter((id) => id === 'bonus').length;
        });

        els.strips.forEach((strip, reel) => {
            // Strip = what's showing now, a run of random symbols, then the
            // landing column. Longer runs for later reels keep the apparent
            // speed constant while they spin for longer.
            const current = Array.from(strip.children).map((cell) => cell.dataset.sym);
            const stop = stops[reel];
            const fillerCount = reduced ? 3 : Math.round(12 + stop.at / 60);
            const cells = current.slice(0, E.ROWS);
            for (let n = 0; n < fillerCount; n++) cells.push(E.randomSymbol(Math.random));
            cells.push(...result.grid[reel]);
            strip.innerHTML = cells.map(cellHtml).join('');

            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0)';
            void strip.offsetWidth;

            strip.style.transition = `transform ${stop.at}ms cubic-bezier(0.18, 0.72, 0.24, 1.04)`;
            strip.style.transform = `translateY(calc(var(--slots-cell) * -${cells.length - E.ROWS}))`;
            if (!reduced) {
                strip.classList.add('is-blurred');
                later(() => strip.classList.remove('is-blurred'), Math.round(stop.at * 0.7));
            }
            if (stop.anticipating) later(() => els.reels[reel].classList.add('is-anticipating'), baseStops[reel - 1] || 0);
            later(() => landReel(reel), stop.at);
        });

        later(settleSpin, stops[stops.length - 1].at + 140);
    }

    function landReel(reel) {
        if (!pendingSpin) return;
        grid[reel] = pendingSpin.grid[reel];
        setIdleStrip(reel, grid[reel]);
        els.reels[reel].classList.remove('is-anticipating');
        restartAnimation(els.reels[reel], 'is-landed');
    }

    /**
     * Credits the result and presents it. `quiet` settles instantly with no
     * effects — used when the modal is closed mid-spin, so the Demo Credits
     * already staked on that spin are never lost.
     */
    function settleSpin(quiet) {
        if (!pendingSpin) return;
        const result = pendingSpin;
        pendingSpin = null;

        if (quiet) clearTimers();
        grid = result.grid.map((column) => column.slice());
        grid.forEach((column, reel) => setIdleStrip(reel, column));

        spinning = false;
        credits += result.totalWin;
        saveCredits(credits);
        els.modal.removeAttribute('aria-busy');

        const message = messageFor(result);
        shown = { result, quiet: !!quiet };
        els.message.textContent = message;
        els.announce.textContent = tr('slots.resultAnnounce', { message, amount: result.totalWin });

        const spinHadFocus = document.activeElement === els.spin;
        if (quiet) {
            if (result.totalWin > 0) els.win.textContent = tr('slots.won', { amount: result.totalWin });
            renderStatus();
            return;
        }
        presentWin(result);
        renderStatus();

        // Out of credits entirely — send keyboard focus to the reset button.
        if (spinHadFocus && credits < minTotalBet()) els.reset.focus();
    }

    function messageFor(result) {
        if (result.tier === 'jackpot') return tr('slots.jackpot');
        if (result.tier === 'big') return tr('slots.bigWin');
        if (result.bonus.triggered) return tr('slots.bonus');
        if (result.tier === 'medium') return tr('slots.mediumWin');
        if (result.tier === 'small') return tr('slots.smallWin');
        return tr('slots.tryAgain');
    }

    // -----------------------------------------------------------------
    // Win presentation
    // -----------------------------------------------------------------
    function presentWin(result) {
        if (result.totalWin <= 0) {
            els.message.classList.add('is-none');
            return;
        }

        const reduced = prefersReducedMotion();
        // A bonus trigger gets its own overlay unless a bigger celebration already covers it.
        const fxKey = result.tier === 'jackpot' || result.tier === 'big' ? result.tier
            : result.bonus.triggered ? 'bonus' : result.tier;
        const fx = WIN_FX[fxKey];

        els.frame.dataset.winTier = fxKey;
        els.message.classList.add(`is-${fxKey}`);
        els.machine.classList.add('has-win');
        highlightWinners(result);
        renderLineList(result);
        restartAnimation(els.creditsValue, 'is-bumped');

        countUp(els.win, result.totalWin, reduced ? 0 : fx.countMs, (n) => tr('slots.won', { amount: n }));
        restartAnimation(els.win, 'is-counting');

        if (fxKey === 'small' || fxKey === 'medium') floatAmount(result.totalWin);
        if (!reduced) {
            launchConfetti(fx.confetti);
            launchMoney(fx.money, fxKey === 'jackpot');
        }
        if (fxKey === 'jackpot') els.frame.classList.add('is-jackpot-glow');
        if (fx.overlayMs) {
            showCelebration(fxKey, fxKey === 'bonus' ? result.bonus.amount : result.totalWin, reduced ? 0 : fx.countMs, fx.overlayMs);
        }
    }

    function highlightWinners(result) {
        const positions = [];
        result.lineWins.forEach((w) => positions.push(...w.positions));
        if (result.scatter.amount > 0) positions.push(...result.scatter.positions);
        if (result.bonus.triggered) positions.push(...result.bonus.positions);
        positions.forEach(([reel, row]) => {
            const cell = cellAt(reel, row);
            if (cell) cell.classList.add('is-win');
        });
        result.lineWins.forEach((w) => els.linePaths[w.line - 1].classList.add('is-win'));
    }

    function renderLineList(result) {
        const items = result.lineWins.map((w) => {
            const glyphs = GLYPHS[w.symbol].repeat(w.count);
            return `<li><i style="background:${LINE_COLORS[w.line - 1]}"></i>${tr('slots.lineWin', { line: w.line, symbols: glyphs, amount: w.amount })}</li>`;
        });
        if (result.scatter.amount > 0) {
            items.push(`<li><i class="is-special"></i>${tr('slots.scatterWin', { symbols: GLYPHS.scatter.repeat(result.scatter.count), amount: result.scatter.amount })}</li>`);
        }
        if (result.bonus.triggered) {
            items.push(`<li><i class="is-special"></i>${tr('slots.bonusWin', { symbols: GLYPHS.bonus.repeat(result.bonus.count), amount: result.bonus.amount })}</li>`);
        }
        els.lineList.innerHTML = items.join('');
    }

    /** Animates `node`'s text from 0 to `to` over `ms` (instant when ms is 0). */
    function countUp(node, to, ms, format) {
        if (!ms) {
            node.textContent = format(to);
            return;
        }
        let start = null;
        const step = (ts) => {
            if (start === null) start = ts;
            const p = Math.min(1, (ts - start) / ms);
            const eased = 1 - Math.pow(1 - p, 3);
            node.textContent = format(Math.round(to * eased));
            if (p < 1) frame(step);
        };
        node.textContent = format(0);
        frame(step);
    }

    function floatAmount(amount) {
        if (prefersReducedMotion()) return;
        const machineBox = els.machine.getBoundingClientRect();
        const frameBox = els.frame.getBoundingClientRect();
        const float = document.createElement('span');
        float.className = 'slots-float';
        float.textContent = `+${amount}`;
        float.style.top = `${machineBox.top - frameBox.top + machineBox.height * 0.35}px`;
        els.fx.appendChild(float);
        later(() => float.remove(), 1400);
    }

    function showCelebration(kind, amount, countMs, overlayMs) {
        celebrating = true;
        els.celebration.className = `slots-celebration is-${kind}`;
        els.celebration.dataset.kind = kind;
        els.celebrationTitle.textContent = celebrationTitle(kind);
        els.celebration.hidden = false;
        countUp(els.celebrationAmount, amount, countMs, (n) => `+${n}`);
        later(endCelebration, overlayMs);
    }

    function celebrationTitle(kind) {
        const key = { jackpot: 'slots.jackpot', big: 'slots.bigWin', bonus: 'slots.bonus' }[kind];
        return (kind === 'bonus' ? `${GLYPHS.bonus} ` : '') + tr(key);
    }

    function endCelebration() {
        if (!celebrating) return;
        celebrating = false;
        els.celebration.hidden = true;
        renderStatus();
    }

    // -----------------------------------------------------------------
    // Particles — all inside .slots-fx (clipped to the modal), all removed
    // after PARTICLE_LIFETIME_MS or on the next spin / close.
    // -----------------------------------------------------------------
    function fxHeight() {
        return els.fx.clientHeight || 500;
    }

    function launchConfetti(count) {
        if (!count) return;
        const colors = ['var(--slots-gold)', 'var(--accent)', 'var(--success)', 'var(--error)', 'var(--info)'];
        const fall = fxHeight();
        const pieces = [];
        for (let i = 0; i < count; i++) {
            const piece = document.createElement('span');
            piece.className = 'slots-confetti-piece';
            piece.style.left = `${Math.random() * 100}%`;
            piece.style.background = colors[i % colors.length];
            piece.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 140)}px`);
            piece.style.setProperty('--rot', `${Math.round(360 + Math.random() * 540)}deg`);
            piece.style.setProperty('--fall', `${fall}px`);
            piece.style.animationDelay = `${Math.round(Math.random() * 400)}ms`;
            pieces.push(piece);
        }
        els.fx.append(...pieces);
        later(() => pieces.forEach((p) => p.remove()), PARTICLE_LIFETIME_MS);
    }

    /** Coins/banknotes dropping from the top of the slot, spinning, bouncing near the bottom, then fading. Purely visual. */
    function launchMoney(count, heavy) {
        if (!count) return;
        const glyphs = heavy ? ['🪙', '🪙', '💵', '💰'] : ['🪙', '🪙', '💵'];
        const fall = fxHeight() - 34;
        const pieces = [];
        for (let i = 0; i < count; i++) {
            const piece = document.createElement('span');
            piece.className = 'slots-money';
            piece.textContent = glyphs[i % glyphs.length];
            piece.style.left = `${4 + Math.random() * 88}%`;
            piece.style.fontSize = `${1.1 + Math.random() * 0.9}rem`;
            piece.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
            piece.style.setProperty('--rot', `${Math.round((Math.random() < 0.5 ? -1 : 1) * (240 + Math.random() * 480))}deg`);
            piece.style.setProperty('--fall', `${fall - Math.round(Math.random() * 40)}px`);
            piece.style.animationDuration = `${1700 + Math.round(Math.random() * 900)}ms`;
            piece.style.animationDelay = `${Math.round(Math.random() * (heavy ? 1500 : 600))}ms`;
            pieces.push(piece);
        }
        els.fx.append(...pieces);
        later(() => pieces.forEach((p) => p.remove()), PARTICLE_LIFETIME_MS);
    }

    function resetCredits() {
        if (spinning) return;
        clearWinEffects();
        credits = STARTING_CREDITS;
        saveCredits(credits);
        showMessage('slots.resetDone', { amount: STARTING_CREDITS });
        els.announce.textContent = els.message.textContent;
        renderStatus();
        els.spin.focus();
    }

    // -----------------------------------------------------------------
    // Open / close + keyboard handling while open
    // -----------------------------------------------------------------
    function focusableElements() {
        return Array.from(els.modal.querySelectorAll('button, summary, [href], [tabindex]:not([tabindex="-1"])'))
            .filter((node) => !node.disabled && !node.closest('[hidden]'));
    }

    function onModalKeydown(e) {
        // Every keydown stops here while the modal is open, so nothing
        // typed into the mini-game can reach the page underneath. Default
        // actions (Enter/Space activating a focused button) still happen.
        e.stopPropagation();

        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }
        if (e.key === 'Tab') {
            const focusables = focusableElements();
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            const active = document.activeElement;
            if (!els.modal.contains(active)) {
                e.preventDefault();
                first.focus();
            } else if (e.shiftKey && active === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
            return;
        }
        // Space/Enter on the modal's own buttons must still activate them,
        // but must never scroll the page behind it.
        if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && e.target.tagName !== 'SUMMARY') {
            e.preventDefault();
        }
    }

    function open() {
        if (isOpen || !engine()) return;
        if (!els) buildDom();
        isOpen = true;
        previousFocus = document.activeElement;
        credits = loadCredits(); // pick up a balance changed in another tab
        renderStatus();
        els.backdrop.hidden = false;
        window.addEventListener('keydown', onModalKeydown, true);
        window.addEventListener('keypress', stopWhileOpen, true);
        (credits < minTotalBet() ? els.reset : els.spin).focus();
    }

    function stopWhileOpen(e) {
        e.stopPropagation();
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        if (spinning) settleSpin(true);
        clearWinEffects();
        showMessage('slots.ready');
        els.announce.textContent = '';
        renderStatus();
        els.backdrop.hidden = true;
        window.removeEventListener('keydown', onModalKeydown, true);
        window.removeEventListener('keypress', stopWhileOpen, true);
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        if (els.modal.contains(document.activeElement)) document.activeElement.blur();
        previousFocus = null;
    }

    document.addEventListener('morseTrainer:languageChanged', () => {
        if (els) applyTexts();
    });

    // -----------------------------------------------------------------
    // Secret S-L-O-T activation
    // -----------------------------------------------------------------
    let secretProgress = 0;
    let secretTimeoutId = null;

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

    function advanceSecret() {
        secretProgress += 1;
        if (secretTimeoutId) clearTimeout(secretTimeoutId);
        secretTimeoutId = setTimeout(resetSecretProgress, SECRET_INACTIVITY_TIMEOUT_MS);
    }

    function onSecretKeydown(e) {
        // Only real, unmodified, single keystrokes outside text fields.
        // `defaultPrevented` means a page handler already consumed this key
        // (e.g. a Character Training answer) — it's exercise input, not
        // ours, so it must neither advance nor open anything.
        if (isOpen) return;
        if (!e.isTrusted || e.repeat) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (typeof e.key !== 'string' || e.key.length !== 1) return;
        if (isTypingContext(e.target) || e.defaultPrevented) {
            resetSecretProgress();
            return;
        }

        const key = e.key.toUpperCase();
        if (key === SECRET_SEQUENCE[secretProgress]) {
            advanceSecret();
            if (secretProgress === SECRET_SEQUENCE.length) {
                resetSecretProgress();
                open();
            }
            return;
        }

        // Wrong key: start over (counting it as a fresh first key if it is one).
        resetSecretProgress();
        if (key === SECRET_SEQUENCE[0]) advanceSecret();
    }

    // Bubble phase on window, i.e. after every document-level page handler
    // has had its chance to claim (preventDefault) the key.
    window.addEventListener('keydown', onSecretKeydown);
})();
