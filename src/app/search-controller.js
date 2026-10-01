import { t } from '../i18n/index.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function groupResults(results) {
    return {
        document: results.filter((result) => result.type === 'document'),
        card: results.filter((result) => result.type === 'card'),
        highlight: results.filter((result) => result.type === 'highlight')
    };
}

function renderResultGroup(title, results) {
    if (!results.length) {
        return '';
    }

    return `
        <section class="workspace-search-group" aria-label="${escapeHtml(title)}">
          <div class="workspace-search-group-title">${escapeHtml(title)}</div>
          <div class="workspace-search-group-results">
            ${results.map((result) => `
              <button type="button" class="workspace-search-result" data-search-result-id="${escapeHtml(result.id)}" data-search-result-type="${escapeHtml(result.type)}">
                <span class="workspace-search-result-icon material-icons-round">${result.type === 'document' ? 'description' : result.type === 'card' ? 'sticky_note_2' : 'format_quote'}</span>
                <span class="workspace-search-result-title text-two-line">${escapeHtml(result.title)}</span>
                <span class="workspace-search-result-meta">${escapeHtml(t(`search.type.${result.type}`))}</span>
                <span class="workspace-search-result-excerpt text-three-line">${escapeHtml(result.excerpt || t('search.noPreview'))}</span>
              </button>
            `).join('')}
          </div>
        </section>
    `;
}

export function createSearchController({
    elements,
    buildIndex,
    queryIndex,
    getFiles,
    onResultSelected,
    debounceMs = 120
}) {
    let debounceId = null;
    let open = false;
    let currentResults = [];

    function close() {
        open = false;
        elements.searchPanel?.classList.remove('visible');
        elements.toolbarSearchBtn?.classList.remove('active');
    }

    function openPanel() {
        open = true;
        elements.searchPanel?.classList.add('visible');
        elements.toolbarSearchBtn?.classList.add('active');
        elements.workspaceSearchInput?.focus();
        elements.workspaceSearchInput?.select();
    }

    function toggle() {
        if (open) {
            close();
            return;
        }
        openPanel();
        refreshResults(elements.workspaceSearchInput?.value || '');
    }

    function renderResults(results) {
        currentResults = results;
        if (!elements.workspaceSearchResults || !elements.workspaceSearchEmpty) {
            return;
        }

        if (!results.length) {
            elements.workspaceSearchResults.innerHTML = '';
            elements.workspaceSearchEmpty.hidden = false;
            return;
        }

        const grouped = groupResults(results);
        elements.workspaceSearchEmpty.hidden = true;
        elements.workspaceSearchResults.innerHTML = [
            renderResultGroup(t('search.documents'), grouped.document),
            renderResultGroup(t('search.cards'), grouped.card),
            renderResultGroup(t('search.highlights'), grouped.highlight)
        ].join('');
    }

    function refreshResults(query) {
        const index = buildIndex(getFiles());
        const results = queryIndex(index, query).slice(0, 12);
        renderResults(results);
    }

    function scheduleRefresh(query) {
        if (debounceId) {
            clearTimeout(debounceId);
        }

        debounceId = window.setTimeout(() => {
            refreshResults(query);
        }, debounceMs);
    }

    function bind() {
        elements.toolbarSearchBtn?.addEventListener('click', toggle);
        elements.workspaceSearchInput?.addEventListener('input', (event) => {
            scheduleRefresh(event.target.value);
        });
        elements.workspaceSearchInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                close();
            }
        });
        elements.searchPanel?.addEventListener('click', (event) => {
            const resultButton = event.target.closest('[data-search-result-id]');
            if (!resultButton) {
                return;
            }

            const selected = currentResults.find((result) =>
                result.id === resultButton.dataset.searchResultId &&
                result.type === resultButton.dataset.searchResultType
            );

            if (!selected) {
                return;
            }

            onResultSelected?.(selected);
            close();
        });

        window.addEventListener('keydown', (event) => {
            if (event.key === '/' && !open) {
                const tagName = document.activeElement?.tagName;
                if (tagName === 'INPUT' || tagName === 'TEXTAREA') {
                    return;
                }
                event.preventDefault();
                openPanel();
            }
            if (event.key === 'Escape' && open) {
                close();
            }
        });

        document.addEventListener('click', (event) => {
            if (!open) {
                return;
            }

            const insidePanel = elements.searchPanel?.contains(event.target);
            const insideToggle = elements.toolbarSearchBtn?.contains(event.target);
            if (!insidePanel && !insideToggle) {
                close();
            }
        });
    }

    return {
        bind,
        close,
        open: openPanel,
        refreshResults: () => refreshResults(elements.workspaceSearchInput?.value || '')
    };
}
