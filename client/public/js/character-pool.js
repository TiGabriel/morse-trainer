/**
 * Character pool picker — shared by Individual Training (Radiograms +
 * Character Training) and Group Session creation, so there is exactly
 * one checkbox/preset/selection implementation in the app, not one per
 * page. `idPrefix` namespaces the DOM ids each instance reads/writes
 * (e.g. "char-grid-letters" vs "ct-char-grid-letters" vs
 * "gs-char-grid-letters").
 *
 * Depends on a page-level `el(id)` helper already being defined (every
 * page's own script defines one identically) and on each page providing
 * matching markup: a `#{prefix-}char-grid-{category}` container per
 * category in CATEGORIES, a `#{prefix-}category-select-all-{category}`
 * checkbox, a `#{prefix-}pool-summary` element, and a quick-actions
 * container of `.chip-button[data-preset]` buttons.
 */
const CATEGORIES = ['letters', 'numbers', 'punctuation'];

const PRESET_CATEGORIES = {
    letters: ['letters'],
    numbers: ['numbers'],
    punctuation: ['punctuation'],
    alphanumeric: ['letters', 'numbers'],
    all: ['letters', 'numbers', 'punctuation'],
};

function createPoolPicker(idPrefix) {
    const selected = new Set();
    const domId = (id) => (idPrefix ? `${idPrefix}-${id}` : id);

    function categoryCheckboxes(category) {
        return Array.from(el(domId(`char-grid-${category}`)).querySelectorAll('input[type="checkbox"]'));
    }

    function toggleChar(ch, isSelected) {
        if (isSelected) selected.add(ch);
        else selected.delete(ch);
    }

    function syncCategorySelectAll(category) {
        const boxes = categoryCheckboxes(category);
        const checkedCount = boxes.filter((b) => b.checked).length;
        const selectAll = el(domId(`category-select-all-${category}`));
        selectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
        selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
    }

    function setCategoryChecked(category, checked) {
        categoryCheckboxes(category).forEach((box) => {
            box.checked = checked;
            toggleChar(box.value, checked);
        });
        syncCategorySelectAll(category);
    }

    function updateSummary() {
        const summary = el(domId('pool-summary'));
        const count = selected.size;
        if (count === 0) {
            summary.textContent = 'No characters selected yet.';
            return;
        }
        const sorted = [...selected].sort();
        summary.textContent = `${count} character${count === 1 ? '' : 's'} selected: ${sorted.join(' ')}`;
    }

    function buildGrid(category, chars) {
        const grid = el(domId(`char-grid-${category}`));
        grid.innerHTML = '';
        chars.forEach((ch) => {
            const label = document.createElement('label');
            label.className = 'char-chip';

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = ch;
            input.addEventListener('change', () => {
                toggleChar(ch, input.checked);
                syncCategorySelectAll(category);
                updateSummary();
            });

            const span = document.createElement('span');
            span.textContent = ch;

            label.appendChild(input);
            label.appendChild(span);
            grid.appendChild(label);
        });
    }

    function buildAllGrids(sets) {
        CATEGORIES.forEach((cat) => buildGrid(cat, sets[cat] || []));
    }

    function applyPreset(preset) {
        selected.clear();
        if (preset === 'clear') {
            CATEGORIES.forEach((cat) => setCategoryChecked(cat, false));
            updateSummary();
            return;
        }
        const categoriesToSelect = PRESET_CATEGORIES[preset] || [];
        CATEGORIES.forEach((cat) => setCategoryChecked(cat, categoriesToSelect.includes(cat)));
        updateSummary();
    }

    function wireEvents(quickActionsContainerId) {
        CATEGORIES.forEach((cat) => {
            el(domId(`category-select-all-${cat}`)).addEventListener('change', (e) => {
                setCategoryChecked(cat, e.target.checked);
                updateSummary();
            });
        });
        document.querySelectorAll(`#${quickActionsContainerId} .chip-button`).forEach((btn) => {
            btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
        });
    }

    function getSelected() {
        return [...selected];
    }

    /** Replaces the current selection with exactly the given characters (e.g. "Practice Weak Characters"). */
    function setSelected(chars) {
        const want = new Set(chars.map((c) => String(c).toUpperCase()));
        selected.clear();
        CATEGORIES.forEach((cat) => {
            categoryCheckboxes(cat).forEach((box) => {
                const checked = want.has(box.value);
                box.checked = checked;
                toggleChar(box.value, checked);
            });
            syncCategorySelectAll(cat);
        });
        updateSummary();
    }

    return { buildAllGrids, wireEvents, applyPreset, getSelected, setSelected, updateSummary };
}
