/**
 * Shared helpers for typed copy answers (radiograms, reception, group
 * sessions) — one implementation used by every page, no build step, so
 * each page includes this file with a <script> tag (browser global
 * `AnswerTools`).
 *
 *   limitInput(el, maxChars)  — the answer box never accepts more
 *                               characters than the exercise has (spaces
 *                               between groups don't count).
 *   formatGroups(text, size)  — "ABCDEFGH" -> "ABCD EFGH", whatever
 *                               spacing the student typed.
 *   renderComparison(...)     — colour-coded, group-by-group comparison
 *                               of the reference vs. the student's answer,
 *                               built from the server's alignment ops.
 */
(function (root) {
    function compact(text) {
        return String(text || '')
            .replace(/\s+/g, '')
            .toUpperCase();
    }

    function formatGroups(text, groupSize) {
        const c = compact(text);
        if (!groupSize || groupSize < 1) return c;
        const groups = [];
        for (let i = 0; i < c.length; i += groupSize) groups.push(c.slice(i, i + groupSize));
        return groups.join(' ');
    }

    /** Number of non-whitespace characters in `text`. */
    function countChars(text) {
        return String(text || '').replace(/\s+/g, '').length;
    }

    /**
     * Keeps `input`'s non-space character count at or below `maxChars`
     * (read through `getMax()` on every keystroke, so the limit can change
     * per exercise without re-wiring). Excess characters from typing or
     * pasting are dropped from the end of what was just inserted, so the
     * caret stays where the student was typing. `onChange(count, max)` is
     * called after every input for a live counter.
     */
    function limitInput(input, getMax, onChange) {
        if (!input || input.dataset.answerLimitWired === 'true') return;
        input.dataset.answerLimitWired = 'true';

        input.addEventListener('input', () => {
            const max = getMax();
            if (max > 0) {
                const value = input.value;
                let over = countChars(value) - max;
                if (over > 0) {
                    const caret = input.selectionStart ?? value.length;
                    let before = value.slice(0, caret);
                    const after = value.slice(caret);
                    // Remove the newest non-space characters just before the caret.
                    for (let i = before.length - 1; i >= 0 && over > 0; i -= 1) {
                        if (!/\s/.test(before[i])) {
                            before = before.slice(0, i) + before.slice(i + 1);
                            over -= 1;
                        }
                    }
                    let rest = after;
                    // Still too long (e.g. caret at the start): trim from the end.
                    for (let i = rest.length - 1; i >= 0 && over > 0; i -= 1) {
                        if (!/\s/.test(rest[i])) {
                            rest = rest.slice(0, i) + rest.slice(i + 1);
                            over -= 1;
                        }
                    }
                    input.value = before + rest;
                    try {
                        input.setSelectionRange(before.length, before.length);
                    } catch {
                        // Some input types don't support selection — harmless.
                    }
                }
            }
            if (onChange) onChange(countChars(input.value), max);
        });
    }

    function makeCell(char, cls) {
        const span = document.createElement('span');
        span.className = 'ac-cell ' + cls;
        span.textContent = char;
        return span;
    }

    /**
     * Renders scoreAnswer's alignment `ops` as blocks of `groupSize`
     * reference characters, each block showing the reference on top and
     * the student's answer underneath, so the two rows can never drift
     * apart when the line wraps. Extra (inserted) characters stay inside
     * the group they were typed in. Colours: correct = green, wrong =
     * amber, missing = red, extra = purple.
     *
     * @param {HTMLElement} container
     * @param {Array<{type: string, expectedChar?: string, submittedChar?: string}>} ops
     * @param {number|null} groupSize - characters per group (0/null = blocks of 10)
     * @param {{ referenceLabel?: string, answerLabel?: string }} [labels]
     */
    function renderComparison(container, ops, groupSize, labels = {}) {
        container.innerHTML = '';
        container.classList.add('answer-compare');
        const size = groupSize && groupSize > 0 ? groupSize : 10;

        const legend = document.createElement('div');
        legend.className = 'ac-row-labels';
        legend.innerHTML = '<span></span><span></span>';
        legend.children[0].textContent = labels.referenceLabel || 'Reference';
        legend.children[1].textContent = labels.answerLabel || 'Answer';
        container.appendChild(legend);

        const groupsWrap = document.createElement('div');
        groupsWrap.className = 'ac-groups';
        container.appendChild(groupsWrap);

        let block = null;
        let refRow = null;
        let ansRow = null;
        let expectedInBlock = size; // forces a new block on the first op
        const newBlock = () => {
            block = document.createElement('div');
            block.className = 'ac-group';
            refRow = document.createElement('div');
            refRow.className = 'ac-line ac-ref';
            ansRow = document.createElement('div');
            ansRow.className = 'ac-line ac-ans';
            block.appendChild(refRow);
            block.appendChild(ansRow);
            groupsWrap.appendChild(block);
            expectedInBlock = 0;
        };

        (ops || []).forEach((op) => {
            if (op.type !== 'extra' && expectedInBlock >= size) newBlock();
            if (!block) newBlock();
            if (op.type === 'match') {
                refRow.appendChild(makeCell(op.expectedChar, 'ac-match'));
                ansRow.appendChild(makeCell(op.submittedChar, 'ac-match'));
            } else if (op.type === 'substitution') {
                refRow.appendChild(makeCell(op.expectedChar, 'ac-wrong'));
                ansRow.appendChild(makeCell(op.submittedChar, 'ac-wrong'));
            } else if (op.type === 'missing') {
                refRow.appendChild(makeCell(op.expectedChar, 'ac-missing'));
                ansRow.appendChild(makeCell('_', 'ac-missing'));
            } else if (op.type === 'extra') {
                refRow.appendChild(makeCell('·', 'ac-extra'));
                ansRow.appendChild(makeCell(op.submittedChar, 'ac-extra'));
            }
            if (op.type !== 'extra') expectedInBlock += 1;
        });
    }

    /** The colour legend markup, for pages that don't already have one. */
    function legendHtml(labels) {
        return (
            `<span class="ac-legend"><span class="ac-swatch ac-match"></span>${labels.correct}</span>` +
            `<span class="ac-legend"><span class="ac-swatch ac-wrong"></span>${labels.wrong}</span>` +
            `<span class="ac-legend"><span class="ac-swatch ac-missing"></span>${labels.missing}</span>` +
            `<span class="ac-legend"><span class="ac-swatch ac-extra"></span>${labels.extra}</span>`
        );
    }

    root.AnswerTools = { compact, formatGroups, countChars, limitInput, renderComparison, legendHtml };
})(typeof window !== 'undefined' ? window : globalThis);
