/**
 * Static digest viewer. Renders one week+category JSON document per URL state.
 * All external text is inserted via textContent (no innerHTML), and links are
 * whitelisted to arxiv.org / papers.cool exactly like the Markdown renderer.
 */

/** @typedef {{ version: 1, updatedAt: string, weeks: Array<{week: string, from: string, to: string}> }} SiteIndex */
/** @typedef {{ id: string, name: string, count: number, groupId?: string, groupName?: string }} WeekCategory */
/** @typedef {{ version: 1, week: string, from: string, to: string, categories: Array<WeekCategory> }} WeekIndex */
/** @typedef {{ version: 1, week: string, from: string, to: string, categoryId: string, categoryName: string, groupId?: string, groupName?: string, generatedAt: string, configHash: string, candidateCount: number, papers: Array<object> }} WebDocument */

const state = {
    /** @type {SiteIndex | undefined} */
    siteIndex: undefined,
    /** @type {string | undefined} */
    week: undefined,
    /** Derived from the selected category; not part of the URL state. */
    group: undefined,
    /** @type {string | undefined} */
    category: undefined,
    /** @type {WeekCategory[]} */
    weekCategories: [],
    /** @type {WebDocument | undefined} */
    document: undefined,
};

let searchPattern = (() => {
    const params = new URLSearchParams(location.search);
    const value = params.get('q');
    return value ? value.toLowerCase() : '';
})();

const el = {
    weekSelect: document.getElementById('week-select'),
    groupSelect: document.getElementById('group-select'),
    categorySelect: document.getElementById('category-select'),
    countBadge: document.getElementById('count-badge'),
    searchInput: document.getElementById('search-input'),
    themeToggle: document.getElementById('theme-toggle'),
    iconSun: document.getElementById('icon-sun'),
    iconMoon: document.getElementById('icon-moon'),
    metaLine: document.getElementById('meta-line'),
    paperList: document.getElementById('paper-list'),
    stateEmpty: document.getElementById('state-empty'),
    stateError: document.getElementById('state-error'),
    footerMeta: document.getElementById('footer-meta'),
};

if (searchPattern && el.searchInput) el.searchInput.value = searchPattern;

// ---------------------------------------------------------------------------
// Link whitelisting (mirrors src/renderer.ts)
// ---------------------------------------------------------------------------

/** @param {string} url */
function normalizeUrl(url) {
    return url.replace(/^https:\/\/export\.arxiv\.org\//, 'https://arxiv.org/');
}

/**
 * Only arxiv.org and papers.cool links may become anchors; everything else
 * degrades to plain text so untrusted fields can never inject a link.
 * @param {string} url
 */
function safeHref(url) {
    const normalized = normalizeUrl(url);
    return /^https:\/\/(?:www\.)?arxiv\.org\//.test(normalized) ||
        /^https:\/\/papers\.cool\//.test(normalized)
        ? normalized
        : undefined;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Create an element with classes and textContent children (never innerHTML).
 * @param {string} tag
 * @param {string[]} classes
 * @param {Array<string | Node>} children
 */
function element(tag, classes, children) {
    const node = document.createElement(tag);
    if (classes.length) node.className = classes.join(' ');
    for (const child of children ?? []) {
        node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
}

/**
 * Build a whitelisted anchor or a plain span fallback.
 * @param {string} text
 * @param {string | undefined} href
 */
function linkOrText(text, href) {
    if (!href) return element('span', ['text-slate-400'], [text]);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.className = 'text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:text-indigo-500 dark:text-indigo-400 dark:decoration-indigo-600';
    anchor.textContent = text;
    return anchor;
}

/** @param {string} arxivId */
function papersCoolHref(arxivId) {
    // Constructed from the validated id, never taken from data fields.
    return safeHref(`https://papers.cool/arxiv/${arxivId}`);
}

/** @param {string} text */
function matchesSearch(text) {
    return !searchPattern || text.toLowerCase().includes(searchPattern);
}

/**
 * One paper card. Field order and content match the Markdown digest.
 * @param {object} paper weekly JSON paper entry
 */
function renderCard(paper) {
    const arxivHref = safeHref(`https://arxiv.org/abs/${paper.arxivId}`);

    const title = element(
        'h3',
        ['text-base', 'font-semibold', 'leading-snug', 'tracking-tight'],
        [paper.title],
    );

    const tags = paper.classification.tags.map((tag) =>
        element(
            'span',
            ['rounded', 'bg-slate-100', 'px-1.5', 'py-0.5', 'font-mono', 'text-[11px]', 'text-slate-600', 'dark:bg-slate-800', 'dark:text-slate-300'],
            [tag],
        ),
    );

    const header = element('div', ['mb-2', 'space-y-1.5'], [
        title,
        ...(tags.length ? [element('div', ['flex', 'flex-wrap', 'gap-1'], tags)] : []),
    ]);

    const abstract = element(
        'p',
        ['abstract-clamp', 'text-sm', 'leading-relaxed', 'text-slate-600', 'dark:text-slate-300'],
        [paper.abstractEn],
    );

    const toggleButton = element(
        'button',
        ['mt-1', 'text-xs', 'font-medium', 'text-indigo-600', 'hover:underline', 'dark:text-indigo-400'],
        ['Show more'],
    );
    toggleButton.type = 'button';
    const card = element('article', [
        'group',
        'rounded-2xl',
        'border',
        'border-slate-200',
        'bg-white',
        'p-5',
        'shadow-sm',
        'transition',
        'hover:border-indigo-300',
        'hover:shadow-md',
        'dark:border-slate-800',
        'dark:bg-slate-900',
        'dark:hover:border-indigo-800',
    ]);
    toggleButton.addEventListener('click', () => {
        card.classList.toggle('abstract-open');
        toggleButton.textContent = card.classList.contains('abstract-open') ? 'Show less' : 'Show more';
    });

    const meta = element('div', ['mt-3', 'space-y-1', 'text-xs', 'text-slate-500', 'dark:text-slate-400'], [
        element('div', [], [
            element('span', ['font-semibold', 'text-slate-600', 'dark:text-slate-300'], ['Category: ']),
            document.createTextNode(paper.classification.categories.join(', ') || paper.categories.join(', ')),
        ]),
        paper.authors.length
            ? element('div', [], [element('span', ['font-semibold', 'text-slate-600', 'dark:text-slate-300'], ['Authors: ']), document.createTextNode(paper.authors.join(', '))])
            : element('div', [], ['Authors: Unknown']),
        element('div', [], [
            element('span', ['font-semibold', 'text-slate-600', 'dark:text-slate-300'], ['arXiv: ']),
            linkOrText(paper.arxivId, arxivHref),
            document.createTextNode(' · '),
            element('span', ['font-semibold', 'text-slate-600', 'dark:text-slate-300'], ['papers.cool: ']),
            linkOrText(paper.arxivId, papersCoolHref(paper.arxivId)),
        ]),
        element('div', [], [element('span', ['font-semibold', 'text-slate-600', 'dark:text-slate-300'], ['Published: ']), document.createTextNode(String(paper.publishedAt).slice(0, 10))]),
    ]);

    card.append(header, meta, element('div', ['mt-3', 'border-t', 'border-slate-100', 'pt-3', 'dark:border-slate-800'], [abstract, toggleButton]));
    return card;
}

/** Skeleton card shown while a document is loading. */
function skeletonCard() {
    return element('article', [
        'animate-pulse',
        'rounded-2xl',
        'border',
        'border-slate-200',
        'bg-white',
        'p-5',
        'dark:border-slate-800',
        'dark:bg-slate-900',
    ], [
        element('div', ['mb-3', 'h-4', 'w-3/4', 'rounded', 'bg-slate-200', 'dark:bg-slate-800'], []),
        element('div', ['h-3', 'w-1/2', 'rounded', 'bg-slate-100', 'dark:bg-slate-800/70'], []),
        element('div', ['mt-3', 'h-24', 'rounded', 'bg-slate-100', 'dark:bg-slate-800/70'], []),
    ]);
}

function showEmpty(message) {
    el.stateEmpty.textContent = message;
    el.stateEmpty.classList.remove('hidden');
}

function showError(message) {
    el.stateError.textContent = message;
    el.stateError.classList.remove('hidden');
}

function resetPanels() {
    el.stateEmpty.classList.add('hidden');
    el.stateError.classList.add('hidden');
    el.paperList.replaceChildren();
}

/**
 * Render the loaded document (already filtered by search pattern).
 * @param {WebDocument} webDocument
 */
function renderDocument(webDocument) {
    resetPanels();
    const papers = (webDocument.papers ?? []).filter((paper) =>
        matchesSearch(`${paper.title} ${paper.authors.join(' ')} ${paper.abstractEn}`),
    );
    if (!papers.length) {
        showEmpty(searchPattern ? 'No papers match the filter.' : 'No papers in this category.');
        return;
    }
    const fragment = document.createDocumentFragment();
    for (const paper of papers) fragment.append(renderCard(paper));
    el.paperList.append(fragment);
}

function renderMeta() {
    const webDocument = state.document;
    if (!webDocument) {
        el.metaLine.textContent = '';
        el.footerMeta.textContent = '';
        return;
    }
    el.metaLine.textContent = `Window: ${webDocument.from} to ${webDocument.to} (UTC) · Candidates: ${webDocument.candidateCount} · Papers: ${state.document.papers?.length ?? 0}`;
    el.footerMeta.textContent = `generated ${webDocument.generatedAt} · config ${String(webDocument.configHash).slice(0, 12)} · doc v${webDocument.version}`;
    el.countBadge.textContent = `${state.document.papers?.length ?? 0} papers`;
    el.countBadge.classList.remove('hidden');
    // Document title keeps the Chinese category name (from the week index)
    // while the selects show English ids.
    const selected = (state.weekCategories ?? []).find((entry) => entry.id === webDocument.categoryId);
    document.title = `${webDocument.week} · ${selected?.name ?? webDocument.categoryName} — Weekly arXiv Digest`;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * @param {string} week YYYY-Www
 * @returns {Promise<WeekIndex>}
 */
async function loadWeekIndex(week) {
    const response = await fetch(`./digests/${encodeURIComponent(week)}/index.json`);
    if (!response.ok) throw new Error(`Week index unavailable (${response.status})`);
    return response.json();
}

/**
 * @param {string} week
 * @param {string} category
 * @returns {Promise<WebDocument>}
 */
async function loadDocument(week, category) {
    const response = await fetch(`./digests/${encodeURIComponent(week)}/weekly-${encodeURIComponent(week)}-${encodeURIComponent(category)}.json`);
    if (!response.ok) throw new Error(`Document unavailable (${response.status})`);
    return response.json();
}

// ---------------------------------------------------------------------------
// URL state (pushState routing via query params)
// ---------------------------------------------------------------------------

/** Push or replace the query-string state for the current selection. */
function syncUrl(method) {
    const params = new URLSearchParams();
    if (state.week) params.set('week', state.week);
    if (state.category) params.set('category', state.category);
    if (searchPattern) params.set('q', searchPattern);
    const query = params.toString();
    const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`;
    history[method](method === 'pushState' ? { week: state.week, category: state.category } : null, '', url);
}

/** Read week/category from the URL, falling back to the manifest defaults. */
function stateFromUrl() {
    const params = new URLSearchParams(location.search);
    const weeks = state.siteIndex?.weeks ?? [];
    const validWeek = (value) => (weeks.some((entry) => entry.week === value) ? value : undefined);
    return {
        week: validWeek(params.get('week') ?? '') ?? weeks[0]?.week,
        category: params.get('category') ?? undefined,
    };
}

// ---------------------------------------------------------------------------
// Selects and event wiring
// ---------------------------------------------------------------------------

/**
 * Fill a select. Option labels show the English id (taxonomy identifier); the
 * optional `hint` (Chinese name) is attached as a native hover tooltip.
 * @param {HTMLSelectElement} select
 * @param {Array<{value: string, label: string, hint?: string}>} options
 * @param {string | undefined} selected
 */
function fillSelect(select, options, selected) {
    select.replaceChildren(
        ...options.map((option) => {
            const node = document.createElement('option');
            node.value = option.value;
            node.textContent = option.label;
            if (option.hint) node.title = option.hint;
            node.selected = option.value === selected;
            return node;
        }),
    );
    select.value = selected ?? options[0]?.value ?? '';
}

const UNGROUPED = '__ungrouped__';

/** Categories of the active group; legacy indexes without groups all land here. */
function categoriesOfGroup(group) {
    const all = state.weekCategories ?? [];
    if (group === UNGROUPED) return all.filter((category) => !category.groupId);
    return all.filter((category) => category.groupId === group);
}

/** Distinct groups in file order, preserving the taxonomy ordering. */
function groupsOfCategories() {
    const all = state.weekCategories ?? [];
    const groups = [];
    const seen = new Set();
    for (const category of all) {
        const id = category.groupId ?? UNGROUPED;
        if (seen.has(id)) continue;
        seen.add(id);
        groups.push({ id, name: category.groupName ?? id });
    }
    return groups;
}

/**
 * Rebuild the group + category selects for the current week.
 * @param {string | undefined} preferredCategory category to keep selected when present
 */
function renderPickers(preferredCategory) {
    const groups = groupsOfCategories();
    // Prefer the group of the requested category, else keep the current one.
    const requested = (state.weekCategories ?? []).find((entry) => entry.id === preferredCategory);
    const group = requested?.groupId ?? state.group ?? groups[0]?.id;
    state.group = group;
    const categories = categoriesOfGroup(group);
    const category = categories.some((entry) => entry.id === preferredCategory)
        ? preferredCategory
        : categories[0]?.id;
    state.category = category;
    fillSelect(
        el.groupSelect,
        groups.map((entry) => ({
            value: entry.id,
            label: entry.id === UNGROUPED ? 'ungrouped' : entry.id,
            hint: entry.id === UNGROUPED ? '' : entry.name,
        })),
        group,
    );
    fillSelect(
        el.categorySelect,
        categories.map((entry) => ({ value: entry.id, label: entry.id, hint: entry.name })),
        category,
    );
}

/** Load the category list for the selected week and rebuild the pickers. */
async function loadWeekCategories() {
    try {
        const weekIndex = await loadWeekIndex(state.week);
        state.weekCategories = weekIndex.categories ?? [];
        if (!state.weekCategories.length) throw new Error('empty week index');
        renderPickers(state.category);
    } catch {
        state.category = undefined;
        state.weekCategories = [];
        el.groupSelect.replaceChildren();
        el.categorySelect.replaceChildren();
        throw new Error('This week has no digest data (is the manifest deployed?).');
    }
}

/** Full refresh for the current week+category selection. */
async function refresh() {
    resetPanels();
    for (let index = 0; index < 4; index += 1) el.paperList.append(skeletonCard());
    try {
        const document = await loadDocument(state.week, state.category);
        state.document = document;
        renderDocument(document);
        renderMeta();
    } catch (error) {
        resetPanels();
        showError(`Failed to load the digest: ${error instanceof Error ? error.message : error}`);
    }
}

// Theme ----------------------------------------------------------------------

const THEME_KEY = 'digest-theme';

function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    el.iconSun.classList.toggle('hidden', !dark);
    el.iconMoon.classList.toggle('hidden', dark);
    try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch {
        /* storage unavailable: theme still applies for the session */
    }
}

el.themeToggle.addEventListener('click', () => {
    applyTheme(!document.documentElement.classList.contains('dark'));
});

const savedTheme = (() => {
    try {
        return localStorage.getItem(THEME_KEY);
    } catch {
        return undefined;
    }
})();
applyTheme(savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);

// Events ---------------------------------------------------------------------

el.weekSelect.addEventListener('change', () => {
    state.week = el.weekSelect.value;
    syncUrl('pushState');
    loadWeekCategories()
        .then(() => {
            syncUrl('replaceState');
            return refresh();
        })
        .catch((error) => {
            resetPanels();
            showError(error instanceof Error ? error.message : String(error));
        });
});

el.groupSelect.addEventListener('change', () => {
    // Switching group re-derives the category list and selects its first entry.
    state.group = el.groupSelect.value;
    renderPickers(undefined);
    syncUrl('pushState');
    refresh();
});

el.categorySelect.addEventListener('change', () => {
    state.category = el.categorySelect.value;
    const requested = (state.weekCategories ?? []).find((entry) => entry.id === state.category);
    if (requested) state.group = requested.groupId ?? UNGROUPED;
    syncUrl('pushState');
    refresh();
});

let searchTimer;
el.searchInput.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        searchPattern = el.searchInput.value.trim().toLowerCase();
        if (state.document) renderDocument(state.document);
    }, 150);
});

window.addEventListener('popstate', () => {
    const next = stateFromUrl();
    if (next.week === state.week && next.category === state.category) return;
    state.week = next.week;
    state.category = next.category;
    el.weekSelect.value = state.week ?? '';
    loadWeekCategories()
        .then(() => refresh())
        .catch((error) => {
            resetPanels();
            showError(error instanceof Error ? error.message : String(error));
        });
});

// Boot -----------------------------------------------------------------------

(async function init() {
    el.paperList.replaceChildren();
    for (let index = 0; index < 4; index += 1) el.paperList.append(skeletonCard());
    try {
        const response = await fetch('./digests/index.json');
        if (!response.ok) throw new Error(`Site manifest unavailable (${response.status})`);
        state.siteIndex = await response.json();
    } catch (error) {
        resetPanels();
        showError(`No digest data found: ${error instanceof Error ? error.message : error}`);
        return;
    }
    const initial = stateFromUrl();
    state.week = initial.week;
    state.category = initial.category;
    fillSelect(
        el.weekSelect,
        (state.siteIndex.weeks ?? []).map((entry) => ({ value: entry.week, label: entry.week })),
        state.week,
    );
    if (!state.week) {
        resetPanels();
        showEmpty('No weeks have been published yet.');
        return;
    }
    try {
        await loadWeekCategories();
        syncUrl('replaceState');
        await refresh();
    } catch (error) {
        resetPanels();
        showError(error instanceof Error ? error.message : String(error));
    }
})();
