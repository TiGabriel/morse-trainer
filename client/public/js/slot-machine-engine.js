/**
 * Game logic for the hidden "SMMMFN Lucky Slots" easter egg
 * (js/slot-machine.js is the UI). Pure functions + configuration only —
 * no DOM, no storage, no network — so the rules can be read, tuned and
 * tested in one place. Everything here is about fictional Demo Credits
 * with no real-world value.
 *
 * Flow of one spin (see spin()):
 *   generate grid -> evaluate paylines (WILD substitutes) -> evaluate
 *   SCATTER -> evaluate BONUS -> total win + win tier -> result object
 *
 * Grid shape: grid[reel][row], 5 reels x 3 rows, row 0 = top.
 */
(function (root) {
    const REELS = 5;
    const ROWS = 3;

    /**
     * Symbol ids. `pays` = multiplier of the BET PER LINE for 3/4/5 of a
     * kind on an active payline, counted from the leftmost reel.
     * `weight` = relative chance of the symbol landing on any cell.
     *
     * Weights were tuned by simulation (400k spins) to roughly: ~94%
     * return, a win on ~42% of 10-line spins, JACKPOT about once per
     * ~1,250 ten-line spins — i.e. Demo Credits drift down slowly, which
     * keeps the game fun without ever running away in either direction.
     */
    const SYMBOLS = {
        crown: { pays: { 3: 20, 4: 50, 5: 200 }, weight: 1.5 },
        anchor: { pays: { 3: 10, 4: 25, 5: 100 }, weight: 2 },
        ship: { pays: { 3: 8, 4: 20, 5: 75 }, weight: 2.5 },
        radio: { pays: { 3: 5, 4: 15, 5: 50 }, weight: 3 },
        star: { pays: { 3: 4, 4: 10, 5: 30 }, weight: 3.5 },
        diamond: { pays: { 3: 3, 4: 8, 5: 20 }, weight: 4 },
        cherry: { pays: { 3: 2, 4: 5, 5: 10 }, weight: 5 },
        trident: { pays: { 3: 2, 4: 4, 5: 8 }, weight: 5 },
        wild: { special: 'wild', weight: 3.5 },
        scatter: { special: 'scatter', weight: 1.5 },
        bonus: { special: 'bonus', weight: 1.5 },
    };

    // Normal (payline) symbols, highest-paying first.
    const LINE_SYMBOLS = ['crown', 'anchor', 'ship', 'radio', 'star', 'diamond', 'cherry', 'trident'];

    /** WILD substitutes for every LINE_SYMBOL, never for SCATTER/BONUS. A line of only WILDs pays as this symbol. */
    const WILD_PAYS_AS = 'crown';

    /** SCATTER: anywhere on the grid, independent of paylines; multiplier of the TOTAL BET. */
    const SCATTER_PAYS = { 3: 10, 4: 25, 5: 100 };

    /** BONUS: 3+ anywhere triggers the bonus award — a fixed multiple of the TOTAL BET. */
    const BONUS = { minCount: 3, totalBetMultiplier: 15 };

    /** Five of this symbol (WILDs included) on one payline = JACKPOT. */
    const JACKPOT = { symbol: 'crown', count: 5 };

    /** Win tiers by total win as a multiple of the total bet (jackpot overrides). */
    const WIN_TIERS = { medium: 5, big: 20 };

    /** Row index per reel for each payline (0 top, 1 middle, 2 bottom). Order = line number. */
    const PAYLINES = [
        [1, 1, 1, 1, 1],
        [0, 0, 0, 0, 0],
        [2, 2, 2, 2, 2],
        [0, 1, 2, 1, 0],
        [2, 1, 0, 1, 2],
        [0, 0, 1, 0, 0],
        [2, 2, 1, 2, 2],
        [1, 0, 1, 2, 1],
        [1, 2, 1, 0, 1],
        [0, 2, 2, 2, 0],
    ];

    const BET_OPTIONS = [1, 2, 5, 10, 20, 50, 100];
    const MAX_LINES = PAYLINES.length;

    const WEIGHTED = Object.entries(SYMBOLS);
    const TOTAL_WEIGHT = WEIGHTED.reduce((sum, [, s]) => sum + s.weight, 0);

    function randomSymbol(rng) {
        let r = rng() * TOTAL_WEIGHT;
        for (const [id, s] of WEIGHTED) {
            r -= s.weight;
            if (r < 0) return id;
        }
        return WEIGHTED[WEIGHTED.length - 1][0];
    }

    /** A random 5x3 grid. At most one SCATTER and one BONUS per reel (classic reel-strip behaviour). */
    function generateGrid(rng = Math.random) {
        const grid = [];
        for (let reel = 0; reel < REELS; reel++) {
            const column = [];
            for (let row = 0; row < ROWS; row++) {
                let id = randomSymbol(rng);
                while ((id === 'scatter' || id === 'bonus') && column.includes(id)) id = randomSymbol(rng);
                column.push(id);
            }
            grid.push(column);
        }
        return grid;
    }

    /** Best win for one payline, or null. Counts consecutive matches from the leftmost reel. */
    function evaluateLine(grid, lineIndex, betPerLine) {
        const rows = PAYLINES[lineIndex];
        const cells = rows.map((row, reel) => grid[reel][row]);

        // Leading run of WILDs can pay on its own (as WILD_PAYS_AS) …
        let wildRun = 0;
        while (wildRun < REELS && cells[wildRun] === 'wild') wildRun++;

        // … or together with the first real symbol it substitutes for.
        const target = cells[wildRun];
        let targetRun = 0;
        if (target && LINE_SYMBOLS.includes(target)) {
            while (targetRun < REELS && (cells[targetRun] === target || cells[targetRun] === 'wild')) targetRun++;
        }

        const candidates = [];
        if (targetRun >= 3) candidates.push({ symbol: target, count: targetRun });
        if (wildRun >= 3) candidates.push({ symbol: WILD_PAYS_AS, count: wildRun });

        let best = null;
        for (const c of candidates) {
            const amount = SYMBOLS[c.symbol].pays[c.count] * betPerLine;
            if (!best || amount > best.amount) best = { ...c, amount };
        }
        if (!best) return null;

        const positions = rows.slice(0, best.count).map((row, reel) => [reel, row]);
        return {
            line: lineIndex + 1,
            symbol: best.symbol,
            count: best.count,
            amount: best.amount,
            positions,
            withWild: positions.some(([reel, row]) => grid[reel][row] === 'wild'),
        };
    }

    function findAll(grid, id) {
        const positions = [];
        grid.forEach((column, reel) => column.forEach((cell, row) => {
            if (cell === id) positions.push([reel, row]);
        }));
        return positions;
    }

    function totalBetFor(betPerLine, lines) {
        return betPerLine * lines;
    }

    function validateBet(betPerLine, lines) {
        if (!BET_OPTIONS.includes(betPerLine)) throw new RangeError(`Invalid bet per line: ${betPerLine}`);
        if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LINES) throw new RangeError(`Invalid line count: ${lines}`);
    }

    /** Evaluates a finished grid. Pure: same grid + bet always gives the same result. */
    function evaluate(grid, { betPerLine, lines }) {
        validateBet(betPerLine, lines);
        const totalBet = totalBetFor(betPerLine, lines);

        const lineWins = [];
        for (let i = 0; i < lines; i++) {
            const win = evaluateLine(grid, i, betPerLine);
            if (win) lineWins.push(win);
        }

        const scatterPositions = findAll(grid, 'scatter');
        const scatterCount = Math.min(scatterPositions.length, REELS);
        const scatter = {
            count: scatterCount,
            positions: scatterPositions,
            amount: (SCATTER_PAYS[scatterCount] || 0) * totalBet,
        };

        const bonusPositions = findAll(grid, 'bonus');
        const bonusTriggered = bonusPositions.length >= BONUS.minCount;
        const bonus = {
            count: bonusPositions.length,
            positions: bonusPositions,
            triggered: bonusTriggered,
            amount: bonusTriggered ? BONUS.totalBetMultiplier * totalBet : 0,
        };

        const totalWin = lineWins.reduce((sum, w) => sum + w.amount, 0) + scatter.amount + bonus.amount;
        const jackpot = lineWins.some((w) => w.symbol === JACKPOT.symbol && w.count >= JACKPOT.count);

        let tier = 'none';
        if (jackpot) tier = 'jackpot';
        else if (totalWin >= WIN_TIERS.big * totalBet) tier = 'big';
        else if (totalWin >= WIN_TIERS.medium * totalBet) tier = 'medium';
        else if (totalWin > 0) tier = 'small';

        return { grid, betPerLine, lines, totalBet, lineWins, scatter, bonus, totalWin, jackpot, tier };
    }

    function spin(bet, rng = Math.random) {
        return evaluate(generateGrid(rng), bet);
    }

    const api = {
        REELS,
        ROWS,
        SYMBOLS,
        LINE_SYMBOLS,
        WILD_PAYS_AS,
        SCATTER_PAYS,
        BONUS,
        JACKPOT,
        WIN_TIERS,
        PAYLINES,
        BET_OPTIONS,
        MAX_LINES,
        randomSymbol,
        generateGrid,
        evaluate,
        spin,
        totalBetFor,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.SlotMachineEngine = api;
})(typeof window !== 'undefined' ? window : null);
