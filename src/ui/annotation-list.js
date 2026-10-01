import { getAppContext } from '../app/app-context.js';
import { registerEventListeners } from '../app/event-listeners.js';
import { createLogger } from '../core/logger.js';
import { APP_EVENTS } from '../core/event-names.js';
import { modalManager } from './modal-manager.js';
import { t } from '../i18n/index.js';

const logger = createLogger('AnnotationList');

export class AnnotationList {
    constructor(containerId, cardSystem) {
        this.container = document.getElementById(containerId);
        this.cardSystem = cardSystem;
        this.activeCardId = null;
        this.cleanupListeners = null;
        this.filterMode = 'all';
        this.selectedCardIds = new Set();

        this.init();
    }

    init() {
        if (!this.container) return;

        this.handleHighlightClicked = (e) => this.handleHighlightSelection(e.detail.highlightId);
        this.handleRefreshRequested = () => this.refresh();
        this.handleCardSelected = (e) => {
            const cardId = e.detail;
            this.highlightItem(cardId);
        };

        this.cleanupListeners = registerEventListeners([
            { target: window, event: APP_EVENTS.HIGHLIGHT_CLICKED, handler: this.handleHighlightClicked },
            { target: window, event: APP_EVENTS.HIGHLIGHT_UPDATED, handler: (e) => this.handleHighlightUpdate(e.detail) },
            { target: window, event: APP_EVENTS.HIGHLIGHT_REMOVED, handler: (e) => this.removeCard(e.detail) },
            { target: window, event: APP_EVENTS.CARD_ADDED, handler: this.handleRefreshRequested },
            { target: window, event: APP_EVENTS.CARD_UPDATED, handler: this.handleRefreshRequested },
            { target: window, event: APP_EVENTS.CARD_REMOVED, handler: this.handleRefreshRequested },
            { target: window, event: APP_EVENTS.CARD_SOFT_DELETED, handler: this.handleRefreshRequested },
            { target: window, event: APP_EVENTS.CARDS_RESTORED, handler: this.handleRefreshRequested },
            { target: window, event: APP_EVENTS.CARD_SELECTED, handler: this.handleCardSelected }
        ]);
    }

    load(fileId) {
        this.currentFileId = fileId;
        this.refresh();
    }

    refresh() {
        if (!this.currentFileId || !this.cardSystem) {
            logger.debug('Annotation list is waiting for an active document');
            return;
        }

        // Get cards for this file
        // CardSystem uses Map, so we must access values iterator
        const allCards = (this.cardSystem.cards instanceof Map)
            ? Array.from(this.cardSystem.cards.values())
            : Object.values(this.cardSystem.cards || {});

        // Valid cards are those with sourceId matching current file AND not deleted
        const cards = allCards.filter(c => c.sourceId === this.currentFileId && !c.deleted);

        logger.debug('Refreshing annotation list', {
            fileId: this.currentFileId,
            totalCards: allCards.length,
            matchedCards: cards.length
        });

        // Sort by page (we need highlight info for this)
        // We'll trust that card order or card.highlightId can help lookup location
        // Best effort: Join with highlights if possible, or assume card.position is mindmap pos (not useful for page sort)
        // Actually, cardSystem doesn't store page info directly usually, but HighlightManager does.

        const highlightMap = this.getHighlightMap();
        const highlightedCards = cards.map(card => {
            const highlight = highlightMap.get(card.highlightId) ?? null;
            const location = highlight?.location || card.location || null;
            const lineNum = location?.lineStart || 9999;
            return {
                card,
                highlight,
                pageNum: location?.page || location?.rects?.[0]?.page || 9999, // Sort end if unknown
                lineNum,
                y: location?.rects?.[0]?.top || 0
            };
        });

        // Sort: Page ASC, then Top Y ASC
        highlightedCards.sort((a, b) => {
            if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
            if (a.lineNum !== b.lineNum) return a.lineNum - b.lineNum;
            return a.y - b.y;
        });

        this.render(this.applyFilters(highlightedCards));
    }

    getMissingSourceIds() {
        const documents = getAppContext().documentManager?.getMissingDocuments?.() ?? [];
        return new Set(documents.map((document) => document.id));
    }

    applyFilters(items) {
        const missingSourceIds = this.getMissingSourceIds();
        return items.filter(({ card }) => {
            if (this.filterMode === 'all') {
                return true;
            }

            if (this.filterMode === 'needs-map') {
                return card.isOnBoard === false;
            }

            if (this.filterMode === 'on-map') {
                return card.isOnBoard !== false;
            }

            if (this.filterMode === 'missing-links') {
                return missingSourceIds.has(card.sourceId);
            }

            return true;
        });
    }

    render(items) {
        const controls = this.createControlsElement(items);

        this.container.innerHTML = '';
        this.container.appendChild(controls);

        // 当前文件处于未加载状态时，逐条的 link_off 图标不够醒目，
        // 顶部给出明确的恢复引导
        if (this.currentFileId && this.getMissingSourceIds().has(this.currentFileId)) {
            const banner = document.createElement('div');
            banner.className = 'annotation-missing-banner';
            banner.innerHTML = `
                <span class="material-icons-round">link_off</span>
                <span data-i18n="annotation.sourceMissing">${t('annotation.sourceMissing')}</span>
            `;
            this.container.appendChild(banner);
        }

        if (items.length === 0) {
            this.container.insertAdjacentHTML('beforeend', `
                <div class="empty-state annotation-empty-state">
                    <span class="material-icons-round">edit_note</span>
                    <p>${t('app.noAnnotations')}</p>
                    <span class="annotation-empty-hint">${t('app.annotationEmptyHint')}</span>
                </div>`);
            return;
        }

        const fragment = document.createDocumentFragment();

        items.forEach(item => {
            const el = this.createItemElement(item);
            fragment.appendChild(el);
        });

        this.container.appendChild(fragment);

        // Restore active selection if still present
        if (this.activeCardId) {
            this.highlightItem(this.activeCardId);
        }
    }

    createControlsElement(items) {
        const controls = document.createElement('div');
        controls.className = 'annotation-controls';

        const toolbarMain = document.createElement('div');
        toolbarMain.className = 'annotation-toolbar-main';

        const filterGroup = document.createElement('div');
        filterGroup.className = 'annotation-filter-group';
        [
            ['all', 'apps', 'annotation.all'],
            ['needs-map', 'playlist_add_check_circle', 'annotation.needsMap'],
            ['on-map', 'account_tree', 'annotation.onMap'],
            ['missing-links', 'link_off', 'annotation.missingLinks']
        ].forEach(([value, icon, labelKey]) => {
            const label = t(labelKey);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'annotation-filter-btn';
            button.dataset.filter = value;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.setAttribute('aria-pressed', String(value === this.filterMode));
            if (value === this.filterMode) {
                button.classList.add('active');
            }
            button.innerHTML = `<span class="material-icons-round">${icon}</span>`;
            button.addEventListener('click', () => {
                this.filterMode = value;
                this.refresh();
            });
            filterGroup.appendChild(button);
        });
        toolbarMain.appendChild(filterGroup);

        const basketMeta = document.createElement('div');
        basketMeta.className = 'annotation-basket-meta';
        basketMeta.innerHTML = `
            <span class="material-icons-round">done_all</span>
            <span>${t('annotation.selected', { count: this.selectedCardIds.size })}</span>
        `;

        const toolbarSide = document.createElement('div');
        toolbarSide.className = 'annotation-toolbar-side';

        const addSelectedBtn = document.createElement('button');
        addSelectedBtn.type = 'button';
        addSelectedBtn.className = 'annotation-basket-btn';
        addSelectedBtn.title = t('annotation.addSelected');
        addSelectedBtn.setAttribute('aria-label', t('annotation.addSelected'));
        addSelectedBtn.innerHTML = '<span class="material-icons-round">account_tree</span>';
        addSelectedBtn.disabled = this.selectedCardIds.size === 0;
        addSelectedBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.addSelectedCardsToMindMap();
        });

        const clearSelectedBtn = document.createElement('button');
        clearSelectedBtn.type = 'button';
        clearSelectedBtn.className = 'annotation-basket-btn secondary';
        clearSelectedBtn.title = t('annotation.clearSelected');
        clearSelectedBtn.setAttribute('aria-label', t('annotation.clearSelected'));
        clearSelectedBtn.innerHTML = '<span class="material-icons-round">clear_all</span>';
        clearSelectedBtn.disabled = this.selectedCardIds.size === 0;
        clearSelectedBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.selectedCardIds.clear();
            this.refresh();
        });

        toolbarSide.appendChild(basketMeta);
        toolbarSide.appendChild(addSelectedBtn);
        toolbarSide.appendChild(clearSelectedBtn);

        controls.appendChild(toolbarMain);
        controls.appendChild(toolbarSide);

        return controls;
    }

    getHighlightMap() {
        const highlights = getAppContext().highlightManager?.highlights;
        if (!Array.isArray(highlights)) {
            return new Map();
        }

        return new Map(highlights.map((highlight) => [highlight.id, highlight]));
    }

    buildTransferData(card, highlight) {
        const dragData = {
            id: card.id,
            highlightId: card.highlightId,
            text: card.content || highlight?.text || '',
            type: 'text',
            color: highlight?.color || card.color,
            sourceId: card.sourceId,
            sourceName: card.sourceName
        };

        if (card.imageData) {
            dragData.type = 'image';
            dragData.imageData = card.imageData;
        }

        return dragData;
    }

    addCardToMindMap(card, highlight) {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.ADD_CARD_TO_BOARD, {
            detail: this.buildTransferData(card, highlight)
        }));
        this.cardSystem.updateCard(card.id, { isOnBoard: true });
    }

    addSelectedCardsToMindMap() {
        const highlightMap = this.getHighlightMap();
        const cards = (this.cardSystem.cards instanceof Map)
            ? Array.from(this.cardSystem.cards.values())
            : Object.values(this.cardSystem.cards || {});
        const selectedCards = cards.filter((card) => this.selectedCardIds.has(card.id) && !card.deleted);

        selectedCards.forEach((card) => {
            this.addCardToMindMap(card, highlightMap.get(card.highlightId) ?? null);
        });

        this.selectedCardIds.clear();
        this.refresh();
    }

    createItemElement({ card, highlight, pageNum }) {
        const div = document.createElement('div');
        div.className = 'annotation-item';
        div.dataset.cardId = card.id;
        div.dataset.highlightId = card.highlightId;
        div.draggable = true; // Enable Drag
        div.classList.toggle('selected', this.selectedCardIds.has(card.id));

        // Drag Start Handler
        div.addEventListener('dragstart', (e) => {
            // Transfer JSON data for MindMap to consume
            const dragData = this.buildTransferData(card, highlight);

            e.dataTransfer.setData('application/json', JSON.stringify(dragData));
            e.dataTransfer.setData('text/plain', dragData.text);
            e.dataTransfer.effectAllowed = 'copy';
            div.classList.add('dragging');
        });

        div.addEventListener('dragend', () => {
            div.classList.remove('dragging');
        });

        // Double-click opens the graph tree view rooted at this annotation
        div.addEventListener('dblclick', () => {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.OPEN_GRAPH_VIEW, {
                detail: { cardId: card.id }
            }));
        });

        // Header
        const header = document.createElement('div');
        header.className = 'annotation-header';

        const headerMeta = document.createElement('div');
        headerMeta.className = 'annotation-header-meta';

        const pageSpan = document.createElement('span');
        pageSpan.className = 'page-tag';
        const location = highlight?.location || card.location || null;
        let locationLabel = pageNum === 9999 ? t('annotation.pageUnknown') : t('annotation.page', { page: pageNum });
        if (Number.isFinite(location?.lineStart)) {
            locationLabel = Number.isFinite(location?.lineEnd) && location.lineEnd > location.lineStart
                ? t('annotation.lines', { start: location.lineStart, end: location.lineEnd })
                : t('annotation.line', { line: location.lineStart });
        }
        const pageIcon = document.createElement('span');
        pageIcon.className = 'material-icons-round';
        pageIcon.textContent = 'article';
        const pageText = document.createElement('span');
        pageText.textContent = locationLabel;
        pageSpan.append(pageIcon, pageText);

        if (highlight?.color) {
            const dot = document.createElement('span');
            dot.className = 'annotation-color-dot';
            dot.style.width = '8px';
            dot.style.height = '8px';
            dot.style.borderRadius = '50%';
            dot.style.backgroundColor = highlight.color;
            dot.style.display = 'inline-block';
            pageSpan.prepend(dot);
        }

        headerMeta.appendChild(pageSpan);

        const statusTag = document.createElement('span');
        statusTag.className = 'annotation-status-tag';
        // Icon-only status: the meaning travels via title/aria-label.
        const statusIcon = document.createElement('span');
        statusIcon.className = 'material-icons-round';
        if (this.getMissingSourceIds().has(card.sourceId)) {
            statusIcon.textContent = 'link_off';
            statusTag.title = t('annotation.missingLink');
        } else if (card.isOnBoard === false) {
            statusIcon.textContent = 'account_tree';
            statusTag.title = t('annotation.notOnMap');
        } else {
            statusIcon.textContent = 'check_circle';
            statusTag.title = t('annotation.onMap');
        }
        statusTag.appendChild(statusIcon);
        statusTag.setAttribute('role', 'img');
        statusTag.setAttribute('aria-label', statusTag.title);
        headerMeta.appendChild(statusTag);
        header.appendChild(headerMeta);

        const headerActions = document.createElement('div');
        headerActions.className = 'annotation-header-actions';

        const sourceToggleBtn = document.createElement('button');
        sourceToggleBtn.className = 'action-btn annotation-source-toggle';
        sourceToggleBtn.innerHTML = '<span class="material-icons-round">description</span>';
        sourceToggleBtn.title = t('annotation.showSource');
        sourceToggleBtn.setAttribute('aria-label', t('annotation.showSource'));
        sourceToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const shown = div.classList.toggle('show-source');
            sourceToggleBtn.classList.toggle('active', shown);
            sourceToggleBtn.title = shown ? t('annotation.hideSource') : t('annotation.showSource');
        });
        headerActions.appendChild(sourceToggleBtn);

        const selectBtn = document.createElement('button');
        selectBtn.className = 'action-btn basket-btn annotation-select-btn';
        if (this.selectedCardIds.has(card.id)) {
            selectBtn.classList.add('active');
        }
        selectBtn.innerHTML = '<span class="material-icons-round">check_circle</span>';
        selectBtn.title = t('annotation.selectBatch');
        selectBtn.setAttribute('aria-label', t('annotation.selectBatch'));
        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.selectedCardIds.has(card.id)) {
                this.selectedCardIds.delete(card.id);
            } else {
                this.selectedCardIds.add(card.id);
            }
            this.refresh();
        });
        headerActions.appendChild(selectBtn);
        header.appendChild(headerActions);

        div.appendChild(header);

        const sourceMeta = document.createElement('div');
        sourceMeta.className = 'annotation-source-meta text-two-line';
        const sourceIcon = document.createElement('span');
        sourceIcon.className = 'material-icons-round annotation-source-icon';
        sourceIcon.textContent = 'description';
        const sourceName = document.createElement('span');
        sourceName.textContent = card.sourceName || t('annotation.unknownSource');
        sourceMeta.append(sourceIcon, sourceName);
        // Hidden by default; the header source button reveals it so the card
        // stays compact — most of the time the name is redundant context.
        div.appendChild(sourceMeta);

        // Quote (Content)
        const quote = document.createElement('div');
        quote.className = 'annotation-quote text-three-line';
        if (card.imageData) {
            const img = document.createElement('img');
            img.src = card.imageData;
            img.className = 'annotation-image';
            img.style.maxWidth = '100%';
            img.style.borderRadius = '4px';
            img.style.marginTop = '4px';
            quote.appendChild(img);
        } else {
            quote.textContent = card.content || highlight?.text || t('annotation.image');
        }

        if (highlight?.color) {
            quote.style.borderLeftColor = highlight.color;
        }
        div.appendChild(quote);

        // Note area: cards without a note stay compact — a slim "add note"
        // icon button sits in the action row and swaps in the textarea on
        // demand, so empty notes never cost vertical space.
        const buildNoteInput = () => {
            const input = document.createElement('textarea');
            input.className = 'annotation-note-input';
            input.placeholder = t('annotation.notePlaceholder');
            input.value = card.note || '';
            input.rows = 1;

            const autoResize = () => {
                input.style.height = 'auto';
                input.style.height = input.scrollHeight + 'px';
            };
            setTimeout(autoResize, 0);

            input.addEventListener('click', (e) => e.stopPropagation());
            input.addEventListener('input', autoResize);
            input.addEventListener('change', (e) => {
                this.cardSystem.updateCard(card.id, { note: e.target.value });
            });
            return input;
        };

        let noteWrap = null;
        if (card.note) {
            noteWrap = document.createElement('div');
            noteWrap.className = 'annotation-note-wrap';
            noteWrap.appendChild(buildNoteInput());
            div.appendChild(noteWrap);
        }

        // Actions (Delete)
        const actions = document.createElement('div');
        actions.className = 'item-actions annotation-actions';

        const actionMain = document.createElement('div');
        actionMain.className = 'annotation-actions-main';

        if (!card.note) {
            const addNoteBtn = document.createElement('button');
            addNoteBtn.className = 'action-btn add-note-btn';
            addNoteBtn.innerHTML = '<span class="material-icons-round">note_add</span>';
            addNoteBtn.title = t('annotation.addNote');
            addNoteBtn.setAttribute('aria-label', t('annotation.addNote'));
            addNoteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = buildNoteInput();
                noteWrap = document.createElement('div');
                noteWrap.className = 'annotation-note-wrap expanded';
                noteWrap.appendChild(input);
                div.insertBefore(noteWrap, div.querySelector('.annotation-actions'));
                addNoteBtn.remove();
                input.focus();
            });
            actionMain.appendChild(addNoteBtn);
        }

        const actionDanger = document.createElement('div');
        actionDanger.className = 'annotation-actions-danger';

        const delBtn = document.createElement('button');
        delBtn.className = 'action-btn danger';
        delBtn.innerHTML = '<span class="material-icons-round">delete</span>';
        delBtn.title = t('common.delete');
        delBtn.setAttribute('aria-label', t('annotation.deleteTitle'));
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void modalManager.confirm({
                title: t('annotation.deleteTitle'),
                message: t('annotation.deleteMessage'),
                confirmLabel: t('common.delete'),
                danger: true
            }).then((confirmed) => {
                if (!confirmed) return;
                if (typeof this.cardSystem.deleteCard === 'function') {
                    this.cardSystem.deleteCard(card.id);
                } else {
                    this.cardSystem.removeCard(card.id);
                }
            });
        });
        actionDanger.appendChild(delBtn);

        const addToMapBtn = document.createElement('button');
        addToMapBtn.className = 'action-btn add-to-map-btn';
        if (card.isOnBoard !== false) {
            addToMapBtn.classList.add('active');
        }
        addToMapBtn.innerHTML = '<span class="material-icons-round">account_tree</span>';
        addToMapBtn.title = t('annotation.addToMap');
        addToMapBtn.setAttribute('aria-label', t('annotation.addToMap'));
        addToMapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addCardToMindMap(card, highlight);
        });
        actionMain.appendChild(addToMapBtn);

        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'action-btn annotation-jump-btn';
        jumpBtn.innerHTML = '<span class="material-icons-round">north_east</span>';
        jumpBtn.title = t('annotation.openReader');
        jumpBtn.setAttribute('aria-label', t('annotation.openReader'));
        jumpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleItemClick(card.id, card.highlightId);
        });
        actionMain.appendChild(jumpBtn);

        actions.appendChild(actionMain);
        actions.appendChild(actionDanger);
        div.appendChild(actions);

        // Click to jump
        div.addEventListener('click', () => {
            this.handleItemClick(card.id, card.highlightId);
        });

        return div;
    }

    handleItemClick(cardId, highlightId) {
        this.activeCardId = cardId;
        this.highlightItem(cardId);

        // Dispatch event for sync (handled in main.js)
        window.dispatchEvent(new CustomEvent(APP_EVENTS.ANNOTATION_SELECTED, {
            detail: { cardId, highlightId }
        }));
    }

    handleHighlightSelection(highlightId) {
        // Find card for this highlight
        const item = this.container.querySelector(`[data-highlight-id="${highlightId}"]`);
        if (item) {
            const cardId = item.dataset.cardId;
            this.activeCardId = cardId;
            this.highlightItem(cardId);

            // Scroll list to item
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    highlightItem(cardId) {
        const all = this.container.querySelectorAll('.annotation-item');
        all.forEach(el => el.classList.remove('active'));

        const target = this.container.querySelector(`[data-card-id="${cardId}"]`);
        if (target) {
            target.classList.add('active');
            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            // Add temporary flash
            target.classList.add('flash-highlight');
            setTimeout(() => target.classList.remove('flash-highlight'), 1500);
        }
    }

    handleHighlightUpdate(detail) {
        // detail: { id, color }
        // We might just refresh, or update specific DOM for perf
        this.refresh();
    }

    removeCard(highlightId) {
        // Called when standard highlight removal event fires
        // Visual removal only? No, wait for card-removed event to refresh data
        // But we can optimistically remove from DOM
        const item = this.container.querySelector(`[data-highlight-id="${highlightId}"]`);
        if (item) item.remove();
    }

    destroy() {
        this.cleanupListeners?.();
        this.cleanupListeners = null;
    }
}
