// styles.css / themes.css / workspace-ui.css 由 index.html 的 <link> 按顺序加载。
// 不要在这里重复 import —— dev 模式下 Vite 会把 JS 导入的 CSS 注入到 <link> 之后，
// 导致 styles.css 的旧规则覆盖 workspace-ui.css 的新设计（如批注控制区被压回三列布局）。
import { highlightManager } from './core/highlight-manager.js';
import { emitAppNotification } from './ui/app-notifications.js';
import { suppressResizeObserverLoop } from './drawnix/react-board/src/utils/resizeObserverFix.js';
import { documentHistoryManager } from './core/document-history-manager.js'; // Import History Manager
import { getAppContext, initAppContext, setAppService } from './app/app-context.js';
import { initAppBootstrap, setupAppEventListeners } from './app/app-bootstrap.js';
import { createReaderLoader } from './app/reader-loader.js';
import { registerEventListeners } from './app/event-listeners.js';
import { createFileLibraryRenderer, getCardsCollection, getDocumentReferenceDetails } from './app/file-library.js';
import { createWorkspaceDocumentsController } from './app/workspace-documents.js';
import { createProjectWorkspaceController } from './app/project-workspace.js';
import { navigateToLinkedSource } from './app/source-navigation.js';
import { createRecoveryWorkbenchController } from './app/recovery-workbench.js';
import { reconcileDocumentRegistrationState } from './app/document-relink.js';
import { buildWorkspaceSearchIndex, queryWorkspaceSearch } from './app/search-index.js';
import { createSearchController } from './app/search-controller.js';
import { createLogger } from './core/logger.js';
import { buildProjectHomeModel, renderProjectHome as renderProjectHomeMarkup } from './app/project-home.js';
import { createReaderAiController } from './app/reader-ai-controller.js';
import { createLazyInitializer } from './app/lazy-initializer.js';
import { initializeI18n, LOCALE_CHANGED_EVENT, t } from './i18n/index.js';
import { aiConfigManager } from './core/ai-config-manager.js';
import { chatComplete } from './core/ai-client.js';
import { modalManager } from './ui/modal-manager.js';

const logger = createLogger('Main');

suppressResizeObserverLoop();

initializeI18n();

initAppContext();

// Import cardSystem (it's already imported by other modules, but we need it here)
import { cardSystem } from './core/card-system.js';
import { documentManager } from './core/document-manager.js';
import { APP_EVENTS } from './core/event-names.js';
setAppService('cardSystem', cardSystem);
setAppService('highlightManager', highlightManager);
setAppService('documentManager', documentManager);

const readerAiController = createReaderAiController({
    getPassage: () => {
        const context = getAppContext();
        const sourceId = context.currentBook?.id;
        if (!sourceId) {
            return null;
        }

        const highlights = context.highlightManager?.getHighlightsBySource(sourceId) ?? [];
        return [...highlights]
            .filter((highlight) => highlight.text?.trim())
            .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
            .at(-1) ?? null;
    },
    aiConfigManager,
    chatComplete,
    confirmSend: ({ provider, endpoint, model, passage }) => modalManager.confirm({
        title: t('readerAI.reviewTitle'),
        message: `${t('readerAI.reviewDetails', { provider, endpoint, model })}\n${passage}`,
        confirmLabel: t('readerAI.send'),
        cancelLabel: t('common.cancel')
    }),
    showResult: ({ action, answer }) => modalManager.showText(
        `${t('readerAI.resultTitle', { action: t(`readerAI.${action}`) })}\n\n${answer}`
    ),
    notify: emitAppNotification
});

// State
const state = {
    currentFile: null,
    files: [],
    zoom: 1.0,
    currentPage: 1,
    totalPages: 0,
    workspaceMode: 'reading'
};

// DOM Elements
const elements = {
    appLayout: document.getElementById('app-layout'),
    readerContainer: document.getElementById('reader-container'),
    readerContentWrapper: document.getElementById('reader-content-wrapper'),
    fileInput: document.getElementById('file-input'),
    fileList: document.getElementById('file-list'),
    viewer: document.getElementById('viewer'),
    docTitle: document.getElementById('doc-title'),
    prevBtn: document.getElementById('prev-page'),
    nextBtn: document.getElementById('next-page'),
    mobilePrevBtn: document.getElementById('mobile-prev-page'),
    mobileNextBtn: document.getElementById('mobile-next-page'),
    mobileImportDocumentsBtn: document.getElementById('mobile-import-documents'),
    mobileOpenProjectBtn: document.getElementById('mobile-open-project'),
    mobileSaveProjectBtn: document.getElementById('mobile-save-project'),
    mobileExportOutlineBtn: document.getElementById('mobile-export-outline'),
    mobileExportCitationsBtn: document.getElementById('mobile-export-citations'),
    mobileExportNotesBtn: document.getElementById('mobile-export-notes'),
    pageInfo: document.getElementById('page-info'),
    mobileContextPageInfo: document.getElementById('mobile-context-page-info'),
    mobileDocSummary: document.getElementById('mobile-doc-summary'),
    mobilePageInfo: document.getElementById('mobile-page-info'),
    toolbarImportDocumentsBtn: document.getElementById('toolbar-import-documents'),
    toolbarOpenProjectBtn: document.getElementById('toolbar-open-project'),
    toolbarSaveProjectBtn: document.getElementById('toolbar-save-project'),
    toolbarExportOutlineBtn: document.getElementById('toolbar-export-outline'),
    toolbarExportCitationsBtn: document.getElementById('toolbar-export-citations'),
    toolbarExportNotesBtn: document.getElementById('toolbar-export-notes'),
    toolbarSearchBtn: document.getElementById('toolbar-search'),
    toggleSidebarBtn: document.getElementById('toggle-sidebar'),
    toggleNotesBtn: document.getElementById('toggle-notes'),
    toggleOutlineBtn: document.getElementById('toggle-outline'),
    toggleMobileToolsBtn: document.getElementById('toggle-mobile-tools'),
    workspaceModeReadingBtn: document.getElementById('workspace-mode-reading'),
    workspaceModeCaptureBtn: document.getElementById('workspace-mode-capture'),
    workspaceModeMapBtn: document.getElementById('workspace-mode-map'),
    mobileWorkspaceModeReadingBtn: document.getElementById('mobile-workspace-mode-reading'),
    mobileWorkspaceModeCaptureBtn: document.getElementById('mobile-workspace-mode-capture'),
    mobileWorkspaceModeMapBtn: document.getElementById('mobile-workspace-mode-map'),
    toolbarSidebarWidthPresetBtn: document.getElementById('toolbar-sidebar-width-preset'),
    toolbarNotesWidthPresetBtn: document.getElementById('toolbar-notes-width-preset'),
    sidebarWidthPresetBtn: document.getElementById('sidebar-width-preset'),
    closeSidebarPanelBtn: document.getElementById('close-sidebar-panel'),
    notesWidthPresetBtn: document.getElementById('notes-width-preset'),
    closeNotesPanelBtn: document.getElementById('close-notes-panel'),
    closeOutlinePanelBtn: document.getElementById('close-outline-panel'),
    readerToolbar: document.getElementById('reader-toolbar'),
    panelBackdrop: document.getElementById('panel-backdrop'),
    selectionModeFloating: document.getElementById('selection-mode-floating'),
    selectionModeDragHandle: document.getElementById('selection-mode-drag-handle'),
    saveStatusIndicator: document.getElementById('save-status-indicator'),
    appNotifications: document.getElementById('app-notifications'),
    emptyImportDocumentBtn: document.getElementById('empty-import-document'),
    emptyOpenProjectBtn: document.getElementById('empty-open-project'),
    searchPanel: document.getElementById('workspace-search-panel'),
    workspaceSearchInput: document.getElementById('workspace-search-input'),
    workspaceSearchResults: document.getElementById('workspace-search-results'),
    workspaceSearchEmpty: document.getElementById('workspace-search-empty'),
    annotationList: document.getElementById('annotation-list'),
    mindmapContainer: document.getElementById('mindmap-container'),
    notesInnerResizer: document.getElementById('notes-inner-resizer')
};

let currentReader = null;
let splitView = null;
let outlineSidebar = null;
let annotationList = null;
let currentToolMode = 'pan';
let readerLoader = null;
let setMobileNotesView = () => {};
const CAPTURE_NOTES_FOCUS_WIDTH = 356;
const getMapNotesFocusWidth = () => Math.round(window.innerWidth * 0.58);
let readerLayoutSyncTimeout = null;
const selectionToolbarPositions = {
    desktop: null,
    mobile: null
};
let draggedFileId = null;
let renderFileList = () => {};
let workspaceDocuments = null;
let searchController = null;
let workspaceModeTransitionTimeout = null;
const NOTES_SPLIT_WIDTH_KEY = 'inksight:notes-split-width';
const projectWorkspace = createProjectWorkspaceController({
    localStorage,
    sessionStorage,
    ensureBoardReady: () => ensureDrawnixBoard(),
    saveStatusIndicator: elements.saveStatusIndicator,
    renderFileList: () => renderFileList(),
    renderProjectHome: () => renderProjectHome()
});

renderFileList = createFileLibraryRenderer({
    fileListElement: elements.fileList,
    getFiles: () => state.files,
    getCurrentFileId: () => state.currentFile?.id ?? null,
    getProjectStatus: () => projectWorkspace.getProjectStatus(state.files)
});

function renderProjectHome() {
    if (state.currentFile) {
        return;
    }

    elements.viewer.innerHTML = renderProjectHomeMarkup(buildProjectHomeModel(
        getAppContext(),
        projectWorkspace.getProjectStatus(state.files)
    ));
}

window.addEventListener(LOCALE_CHANGED_EVENT, () => {
    updateToolbarSummary();
    renderFileList();
    renderProjectHome();
    annotationList?.refresh?.();
    updateToolAvailability(state.currentFile?.type);
});

workspaceDocuments = createWorkspaceDocumentsController({
    logger,
    projectWorkspace,
    getDocumentReferenceDetails,
    workspace: {
        state,
        elements
    },
    readers: {
        readerLoader: {
            loadReaderForFile: async (...args) => readerLoader.loadReaderForFile(...args)
        },
        documentHistoryManager,
        getCurrentReader: () => currentReader,
        setCurrentReader: (reader) => {
            currentReader = reader;
        }
    },
    ui: {
        renderFileList: () => renderFileList(),
        renderProjectHome,
        updateToolbarSummary,
        updateToolAvailability,
        setWorkspaceMode: (...args) => setWorkspaceMode(...args),
        updatePageInfo
    }
});

const recoveryWorkbench = createRecoveryWorkbenchController({
    renderFileList: () => renderFileList(),
    refreshAnnotations: () => getAppContext().annotationList?.refresh?.(),
    notify: emitAppNotification,
    promptBulkRelink,
    showValidation: () => recoveryWorkbench.showRecoveryValidation()
});

let drawnixViewInstance = null;

async function createDrawnixView(container) {
    if (drawnixViewInstance) {
        return drawnixViewInstance;
    }
    const { DrawnixView } = await import('./mindmap/drawnix-view.js');
    drawnixViewInstance = new DrawnixView(container);
    return drawnixViewInstance;
}

const ensureDrawnixBoard = createLazyInitializer(async () => {
    await createDrawnixView(elements.mindmapContainer);
    if (getAppContext().board) {
        return getAppContext().board;
    }

    return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
            window.removeEventListener(APP_EVENTS.BOARD_READY, handleBoardReady);
            reject(new Error('The canvas did not become ready in time.'));
        }, 15000);
        const handleBoardReady = () => {
            window.clearTimeout(timeout);
            window.removeEventListener(APP_EVENTS.BOARD_READY, handleBoardReady);
            resolve(getAppContext().board);
        };
        window.addEventListener(APP_EVENTS.BOARD_READY, handleBoardReady, { once: true });
        if (getAppContext().board) {
            handleBoardReady();
        }
    });
});

function registerCleanup(cleanup) {
    return cleanup;
}

function setupNotesInnerResizer() {
    const annotationListEl = elements.annotationList;
    const mindmapContainerEl = elements.mindmapContainer;
    const resizerEl = elements.notesInnerResizer;
    const notesPanelEl = document.getElementById('notes-panel');

    if (!annotationListEl || !mindmapContainerEl || !resizerEl || !notesPanelEl) {
        return;
    }

    const minWidth = 180;
    const minMindmapWidth = 220;
    let activePointerId = null;
    let dragging = false;
    let pendingClientX = null;
    let resizeFrame = null;
    let dragBounds = null;
    let lastAppliedWidth = null;

    const isResizableLayout = () => !document.body.classList.contains('compact-layout') && !document.body.classList.contains('mobile-layout');

    const clampWidth = (width, bounds) => Math.max(bounds.minWidth, Math.min(width, bounds.maxWidth));

    const measureBounds = () => {
        const panelContent = notesPanelEl.querySelector('.panel-content');
        if (!panelContent) {
            return null;
        }

        const rect = panelContent.getBoundingClientRect();
        return {
            left: rect.left,
            minWidth,
            maxWidth: Math.max(
                minWidth + 40,
                Math.floor(rect.width - minMindmapWidth - resizerEl.getBoundingClientRect().width)
            )
        };
    };

    const applyStoredWidth = () => {
        if (!isResizableLayout()) {
            annotationListEl.style.width = '';
            return;
        }

        const storedWidth = Number.parseFloat(localStorage.getItem(NOTES_SPLIT_WIDTH_KEY) || '');
        if (!Number.isFinite(storedWidth)) {
            return;
        }

        const bounds = measureBounds();
        if (!bounds) {
            return;
        }

        const clampedWidth = clampWidth(storedWidth, bounds);
        annotationListEl.style.width = `${clampedWidth}px`;
        lastAppliedWidth = clampedWidth;
    };

    const flushResize = () => {
        resizeFrame = null;
        if (!dragging || pendingClientX == null || !dragBounds) {
            return;
        }

        const nextWidth = pendingClientX - dragBounds.left;
        const clampedWidth = clampWidth(nextWidth, dragBounds);
        if (clampedWidth === lastAppliedWidth) {
            return;
        }

        annotationListEl.style.width = `${clampedWidth}px`;
        lastAppliedWidth = clampedWidth;
    };

    const scheduleResize = () => {
        if (resizeFrame !== null) {
            return;
        }

        resizeFrame = window.requestAnimationFrame(flushResize);
    };

    const stopDragging = () => {
        if (!dragging) {
            return;
        }

        dragging = false;
        pendingClientX = null;
        dragBounds = null;
        activePointerId = null;
        document.body.classList.remove('notes-split-resizing');
        if (resizeFrame !== null) {
            window.cancelAnimationFrame(resizeFrame);
            resizeFrame = null;
        }
        if (Number.isFinite(lastAppliedWidth)) {
            localStorage.setItem(NOTES_SPLIT_WIDTH_KEY, String(lastAppliedWidth));
        }
    };

    const handlePointerMove = (event) => {
        if (!dragging || event.pointerId !== activePointerId) {
            return;
        }

        pendingClientX = event.clientX;
        scheduleResize();
    };

    const handlePointerUp = (event) => {
        if (event.pointerId !== activePointerId) {
            return;
        }

        stopDragging();
    };

    resizerEl.addEventListener('pointerdown', (event) => {
        if (!isResizableLayout()) {
            return;
        }

        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        dragging = true;
        activePointerId = event.pointerId;
        dragBounds = measureBounds();
        if (!dragBounds) {
            dragging = false;
            activePointerId = null;
            return;
        }
        lastAppliedWidth = annotationListEl.getBoundingClientRect().width;
        pendingClientX = event.clientX;
        document.body.classList.add('notes-split-resizing');
        resizerEl.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        scheduleResize();
    });

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('resize', applyStoredWidth);
    window.addEventListener(APP_EVENTS.LAYOUT_PANEL_TOGGLED, applyStoredWidth);

    applyStoredWidth();
}

function promptRelinkDocument(documentId) {
    const targetDocument = getAppContext().documentManager?.getDocumentInfo?.(documentId);
    if (!targetDocument || targetDocument.loaded) {
        return;
    }

    setAppService('pendingDocumentImport', {
        id: targetDocument.id,
        name: targetDocument.name,
        type: targetDocument.type
    });
    elements.fileInput.value = '';
    elements.fileInput.click();
}

function promptBulkRelink() {
    setAppService('pendingDocumentImport', {
        mode: 'bulk'
    });
    elements.fileInput.value = '';
    elements.fileInput.click();
}

function promptImportDocument() {
    setAppService('pendingDocumentImport', null);
    elements.fileInput.value = '';
    elements.fileInput.click();
}

function attemptAutoRelinkRecoveredDocuments(options) {
    return recoveryWorkbench.attemptAutoRelinkRecoveredDocuments(options);
}

function reconcileDocumentRegistrations() {
    return reconcileDocumentRegistrationState({ files: state.files, documentManager });
}

function showRecoveryValidation() {
    return recoveryWorkbench.showRecoveryValidation();
}

function matchRecoveredDocument(documentId) {
    return recoveryWorkbench.matchRecoveredDocument(documentId);
}

function findCardByHighlightId(highlightId) {
    if (!highlightId) return null;
    return getCardsCollection().find((card) => card.highlightId === highlightId) ?? null;
}

function findCardById(cardId) {
    if (!cardId) return null;

    const cards = getAppContext().cardSystem?.cards;
    if (cards instanceof Map) {
        return cards.get(cardId) ?? null;
    }

    return cards?.[cardId] ?? null;
}

function findHighlightById(highlightId) {
    if (!highlightId) return null;
    return getAppContext().highlightManager?.highlights?.find((highlight) => highlight.id === highlightId) ?? null;
}

function updateToolbarSummary() {
    const title = state.currentFile?.name || t('app.noDoc');
    const hasDocument = Boolean(state.currentFile);
    elements.readerContainer?.classList.toggle('no-document-open', !hasDocument);
    elements.readerToolbar?.classList.toggle('toolbar-home', !hasDocument);
    elements.mobileDocSummary && (elements.mobileDocSummary.textContent = title);
    if (elements.mobileDocSummary) {
        elements.mobileDocSummary.title = title;
    }
    if (elements.docTitle) {
        elements.docTitle.textContent = title;
        elements.docTitle.title = title;
    }
}

function setMobileToolbarExpanded(expanded) {
    elements.readerToolbar?.classList.toggle('mobile-tools-open', expanded);
    elements.readerContainer?.classList.toggle('mobile-tools-open', expanded);
    elements.toggleMobileToolsBtn?.classList.toggle('active', expanded);
    elements.toggleMobileToolsBtn?.setAttribute('aria-expanded', String(expanded));
}

function syncWorkspaceModeButtons(mode) {
    const modeMap = {
        reading: elements.workspaceModeReadingBtn,
        capture: elements.workspaceModeCaptureBtn,
        map: elements.workspaceModeMapBtn,
        mobileReading: elements.mobileWorkspaceModeReadingBtn,
        mobileCapture: elements.mobileWorkspaceModeCaptureBtn,
        mobileMap: elements.mobileWorkspaceModeMapBtn
    };

    Object.entries(modeMap).forEach(([key, button]) => {
        if (!button) return;
        const normalizedKey = key.replace(/^mobile/, '').toLowerCase();
        const active = normalizedKey === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    });
}

function syncReaderLayoutAfterModeChange() {
    if (!currentReader) {
        return;
    }

    const relayout = () => {
        currentReader?.onLayoutChange?.({
            page: state.currentPage,
            totalPages: state.totalPages,
            workspaceMode: state.workspaceMode
        });
    };

    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(relayout);
    });

    if (readerLayoutSyncTimeout) {
        clearTimeout(readerLayoutSyncTimeout);
    }

    readerLayoutSyncTimeout = window.setTimeout(() => {
        relayout();
    }, 260);
}

function beginWorkspaceModeTransition(nextMode) {
    const root = elements.readerContainer;
    if (!root) {
        document.body.dataset.workspaceMode = nextMode;
        return;
    }

    const previousMode = document.body.dataset.workspaceMode || state.workspaceMode || 'reading';
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

    if (workspaceModeTransitionTimeout) {
        clearTimeout(workspaceModeTransitionTimeout);
    }

    root.classList.remove('mode-transitioning');
    document.body.classList.remove('workspace-mode-transitioning');

    if (reducedMotion) {
        document.body.dataset.workspaceMode = nextMode;
        root.dataset.workspaceMode = nextMode;
        delete root.dataset.modeTransition;
        return;
    }

    root.dataset.modeTransition = `${previousMode}-${nextMode}`;
    root.dataset.workspaceMode = nextMode;
    document.body.dataset.workspaceMode = nextMode;
    root.classList.add('mode-transitioning');
    document.body.classList.add('workspace-mode-transitioning');

    workspaceModeTransitionTimeout = window.setTimeout(() => {
        root.classList.remove('mode-transitioning');
        document.body.classList.remove('workspace-mode-transitioning');
        delete root.dataset.modeTransition;
    }, 260);
}

function setupFloatingSelectionToolbar() {
    const toolbar = elements.selectionModeFloating;
    const dragHandle = elements.selectionModeDragHandle;
    const wrapper = elements.readerContentWrapper;

    if (!toolbar || !dragHandle || !wrapper) {
        return;
    }

    const getLayoutKey = () => (document.body.classList.contains('mobile-layout') ? 'mobile' : 'desktop');

    const clearToolbarInlinePosition = () => {
        toolbar.style.left = '';
        toolbar.style.top = '';
        toolbar.style.right = '';
        toolbar.style.bottom = '';
        toolbar.style.transform = '';
    };

    const clampToolbarPosition = (x, y) => {
        const wrapperRect = wrapper.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const maxX = Math.max(12, wrapperRect.width - toolbarRect.width - 12);
        const maxY = Math.max(12, wrapperRect.height - toolbarRect.height - 12);

        return {
            x: Math.min(Math.max(12, x), maxX),
            y: Math.min(Math.max(12, y), maxY)
        };
    };

    const applyStoredToolbarPosition = () => {
        const layoutKey = getLayoutKey();
        const storedPosition = selectionToolbarPositions[layoutKey];

        if (!storedPosition) {
            clearToolbarInlinePosition();
            return;
        }

        const nextPosition = clampToolbarPosition(storedPosition.x, storedPosition.y);
        toolbar.style.left = `${nextPosition.x}px`;
        toolbar.style.top = `${nextPosition.y}px`;
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'none';
        selectionToolbarPositions[layoutKey] = nextPosition;
    };

    let dragSession = null;

    const stopDrag = () => {
        if (!dragSession) {
            return;
        }

        toolbar.classList.remove('dragging');
        dragSession = null;
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', stopDrag);
        window.removeEventListener('pointercancel', stopDrag);
    };

    function handlePointerMove(event) {
        if (!dragSession) {
            return;
        }

        const proposedX = event.clientX - dragSession.wrapperLeft - dragSession.offsetX;
        const proposedY = event.clientY - dragSession.wrapperTop - dragSession.offsetY;
        const nextPosition = clampToolbarPosition(proposedX, proposedY);

        toolbar.style.left = `${nextPosition.x}px`;
        toolbar.style.top = `${nextPosition.y}px`;
        toolbar.style.right = 'auto';
        toolbar.style.bottom = 'auto';
        toolbar.style.transform = 'none';
        selectionToolbarPositions[dragSession.layoutKey] = nextPosition;
    }

    const startDrag = (event) => {
        event.preventDefault();

        const wrapperRect = wrapper.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        dragSession = {
            layoutKey: getLayoutKey(),
            offsetX: event.clientX - toolbarRect.left,
            offsetY: event.clientY - toolbarRect.top,
            wrapperLeft: wrapperRect.left,
            wrapperTop: wrapperRect.top
        };

        toolbar.classList.add('dragging');
        dragHandle.setPointerCapture?.(event.pointerId);
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', stopDrag);
        window.addEventListener('pointercancel', stopDrag);
    };

    dragHandle.addEventListener('pointerdown', startDrag);

    const handleReaderAiAction = (event) => {
        const actionButton = event.target.closest?.('[data-reader-ai-action]');
        if (!actionButton) {
            return;
        }
        toolbar.querySelector('#reader-ai-menu')?.removeAttribute('open');
        void readerAiController.run(actionButton.dataset.readerAiAction);
    };
    toolbar.addEventListener('click', handleReaderAiAction);

    registerCleanup(() => {
        dragHandle.removeEventListener('pointerdown', startDrag);
        toolbar.removeEventListener('click', handleReaderAiAction);
        stopDrag();
    });

    registerCleanup(registerEventListeners([
        {
            target: window,
            event: 'resize',
            handler: () => window.requestAnimationFrame(applyStoredToolbarPosition)
        }
    ]));

    window.requestAnimationFrame(applyStoredToolbarPosition);
    setAppService('refreshFloatingToolbarPosition', () => window.requestAnimationFrame(applyStoredToolbarPosition));
}

function applyWorkspaceLayout(mode, { notesView } = {}) {
    beginWorkspaceModeTransition(mode);
    state.workspaceMode = mode;
    syncWorkspaceModeButtons(mode);

    if (!splitView) {
        return;
    }

    const isMobile = document.body.classList.contains('mobile-layout');
    const isCompact = splitView.isCompactLayout();

    if (mode === 'reading') {
        outlineSidebar?.close();
        if (isMobile || isCompact) {
            splitView.closeAll();
        } else {
            splitView.setLeftCollapsed(false);
            splitView.setRightCollapsed(true);
            splitView.setPanelWidth('left', 292);
        }
        setMobileNotesView('split');
    }

    // Capture and Map share one panel arrangement — document focus with the
    // notes panel open. Capture focuses the annotation list; Map keeps both
    // panes visible side by side. On touch layouts the panel is a fixed-size
    // overlay, so preset widths do not apply there.
    if (mode === 'capture' || mode === 'map') {
        splitView.setLeftCollapsed(true);
        splitView.setRightCollapsed(false);
        if (!isMobile && !isCompact) {
            splitView.setPanelWidth('right', mode === 'capture' ? CAPTURE_NOTES_FOCUS_WIDTH : getMapNotesFocusWidth());
        }
        setMobileNotesView(notesView || (mode === 'capture' ? 'annotations' : 'split'));
    }

    updatePanelControls();
    syncReaderLayoutAfterModeChange();
    getAppContext().refreshFloatingToolbarPosition?.();
}

function setWorkspaceMode(mode, options = {}) {
    const nextMode = ['reading', 'capture', 'map'].includes(mode) ? mode : 'reading';
    if (nextMode === 'map') {
        void ensureDrawnixBoard().catch((error) => {
            logger.error('Failed to initialize the mind map canvas', error);
            emitAppNotification({
                message: t('mindmap.loadFailed', { message: error.message }),
                level: 'error'
            });
        });
    }

    if (state.workspaceMode === nextMode && !options.force) {
        return;
    }

    applyWorkspaceLayout(nextMode, options);
}

function isCompactLayout() {
    return splitView?.isCompactLayout() ?? window.innerWidth <= 820;
}

function updatePanelControls() {
    const sidebarOpen = splitView ? !splitView.isLeftCollapsed() : false;
    const notesOpen = splitView ? !splitView.isRightCollapsed() : false;
    const outlineOpen = outlineSidebar?.isOpen() ?? false;
    const isTablet = document.body.classList.contains('tablet-layout');

    elements.toggleSidebarBtn?.classList.toggle('active', sidebarOpen);
    elements.toggleNotesBtn?.classList.toggle('active', notesOpen);
    elements.toggleOutlineBtn?.classList.toggle('active', outlineOpen);
    elements.sidebarWidthPresetBtn?.classList.toggle('hidden', !isTablet);
    elements.notesWidthPresetBtn?.classList.toggle('hidden', !isTablet);
    elements.toolbarSidebarWidthPresetBtn?.classList.toggle('hidden', !isTablet);
    elements.toolbarNotesWidthPresetBtn?.classList.toggle('hidden', !isTablet);

    const backdropVisible = isCompactLayout() && (sidebarOpen || notesOpen);
    elements.panelBackdrop?.classList.toggle('visible', backdropVisible);
    document.body.classList.toggle('has-overlay-panel', backdropVisible);
}

function closeCompactPanels() {
    if (!isCompactLayout()) return;
    splitView?.closeAll();
    outlineSidebar?.close();
    updatePanelControls();
}

function resetAuxiliaryPanels() {
    outlineSidebar?.reset();
    document.getElementById('highlighter-panel')?.classList.remove('visible');
}

function setupResponsiveLayout() {
    registerCleanup(registerEventListeners([
        {
            target: elements.panelBackdrop,
            event: 'click',
            handler: () => {
                closeCompactPanels();
            }
        },
        { target: window, event: APP_EVENTS.LAYOUT_PANEL_TOGGLED, handler: updatePanelControls },
        { target: window, event: APP_EVENTS.OUTLINE_VISIBILITY_CHANGED, handler: updatePanelControls },
        {
            target: window,
            event: 'resize',
            handler: () => {
                if (!document.body.classList.contains('mobile-layout')) {
                    setMobileToolbarExpanded(false);
                }
                updatePanelControls();
            }
        }
    ].filter(({ target }) => target)));

    updatePanelControls();
}

function setupMainEventListeners() {
    setupAppEventListeners({
        registerCleanup,
        elements,
        projectWorkspace,
        workspaceDocuments,
        ui: {
            promptImportDocument,
            promptBulkRelink,
            matchRecoveredDocument,
            setWorkspaceMode,
            attemptAutoRelinkRecoveredDocuments,
            reconcileDocumentRegistrations,
            renderFileList,
            showRecoveryValidation,
            promptRelinkDocument
        },
        navigation: {
            getCurrentReader: () => currentReader,
            handleJumpToSource,
            closeCompactPanels
        },
        dragState: {
            getDraggedFileId: () => draggedFileId,
            setDraggedFileId: (id) => {
                draggedFileId = id;
            },
            getFiles: () => state.files
        },
        selectionSync: {
            findCardById,
            findCardByHighlightId,
            getCurrentReader: () => currentReader,
            isCompactLayout,
            collapseNotesPanel: () => {
                splitView?.setRightCollapsed(true);
                updatePanelControls();
            }
        },
        toolbar: {
            getCurrentReader: () => currentReader,
            getCurrentToolMode: () => currentToolMode,
            setCurrentToolMode: (mode) => {
                currentToolMode = mode;
            },
            setMobileToolbarExpanded,
            setWorkspaceMode,
            logger
        }
    });
}

function setupSearch() {
    searchController = createSearchController({
        elements,
        buildIndex: (files) => buildWorkspaceSearchIndex(getAppContext(), files),
        queryIndex: queryWorkspaceSearch,
        getFiles: () => state.files,
        onResultSelected: (result) => {
            if (result.type === 'document') {
                workspaceDocuments.openFileById(result.actionPayload.documentId, {
                    onMissingDocument: (documentId) => promptRelinkDocument(documentId)
                });
                return;
            }

            if (result.type === 'card') {
                window.dispatchEvent(new CustomEvent(APP_EVENTS.CARD_SELECTED, {
                    detail: result.actionPayload.cardId
                }));
            }

            void handleJumpToSource(result.actionPayload.sourceId, result.actionPayload.highlightId || null);
            closeCompactPanels();
        }
    });
    searchController.bind();
}

async function init() {
    const initialized = await initAppBootstrap({
        elements,
        registerCleanup,
        services: {
            logger,
            projectWorkspace
        },
        hooks: {
            updateToolbarSummary,
            workspaceModeReadingInit: () => setWorkspaceMode('reading', { force: true }),
            setupEventListeners: ({ splitView: nextSplitView, outlineSidebar: nextOutlineSidebar, annotationList: nextAnnotationList }) => {
                splitView = nextSplitView;
                outlineSidebar = nextOutlineSidebar;
                annotationList = nextAnnotationList;
                setupMainEventListeners();
            },
            currentToolModeSync: () => getAppContext().syncToolMode?.(currentToolMode),
            setupResponsiveLayout: () => setupResponsiveLayout(),
            setupFloatingSelectionToolbar,
            setWorkspaceMode,
            setMobileNotesViewHandler: (handler) => {
                setMobileNotesView = handler;
            },
            getSplitViewDeps: () => ({
                updatePanelControls,
                setMobileToolbarExpanded
            }),
            handleRestorePagePosition: (event) => {
                const page = event.detail.page;
                if (page && currentReader && page > 1) {
                    logger.debug('Received restore-page-position event. Jumping to', page);
                    currentReader.scrollToPage(page);
                }
            }
        }
    });

    setupSearch();
    setupNotesInnerResizer();
    void projectWorkspace.refreshProjectSnapshotHistory();
    renderProjectHome();

    return initialized;
}

// Global handler for list items
window.openFileById = (id) => workspaceDocuments.openFileById(id, {
    onMissingDocument: (documentId) => promptRelinkDocument(documentId)
});

async function handleJumpToSource(sourceId, highlightId) {
    const result = await navigateToLinkedSource({
        sourceId,
        highlightId,
        findHighlightById,
        findFileById: (id) => state.files.find((file) => file.id === id) ?? null,
        openFile: (fileData) => workspaceDocuments.openFile(fileData),
        getCurrentFile: () => state.currentFile,
        getCurrentReader: () => currentReader,
        notify: ({ message, level }) => emitAppNotification({
            title: level === 'warning' ? 'Source Navigation' : 'Navigation',
            message,
            level
        })
    });

    if (result.status === 'missing-file') {
        logger.warn('Source file not found', { effectiveSourceId: result.effectiveSourceId, sourceId });
    }

    if (result.status === 'missing-highlight') {
        logger.warn('Highlight not found', highlightId);
    }
}

function updateToolAvailability(fileType) {
    const isPDF = fileType === 'application/pdf';
    const toolsToToggle = ['rect-mode', 'ellipse-mode', 'highlighter-mode'];

    toolsToToggle.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            if (!btn.dataset.baseTitle) {
                btn.dataset.baseTitle = btn.title || '';
            }

            btn.disabled = !isPDF;
            if (!isPDF) {
                btn.classList.add('disabled');
                btn.title = `${btn.dataset.baseTitle} (Only available for PDF)`.trim();
            } else {
                btn.classList.remove('disabled');
                btn.title = btn.dataset.baseTitle;
            }
        }
    });

    const currentModeBtn = document.querySelector('.mode-btn.active');
    if (currentModeBtn && currentModeBtn.disabled) {
        getAppContext().setToolMode?.('pan');
    }

    [elements.prevBtn, elements.nextBtn, elements.mobilePrevBtn, elements.mobileNextBtn]
        .filter(Boolean)
        .forEach((button) => {
            button.disabled = !state.currentFile;
        });
}

function updatePageInfo() {
    if (state.totalPages > 0) {
        elements.pageInfo.textContent = `${state.currentPage} / ${state.totalPages}`;
        elements.mobilePageInfo && (elements.mobilePageInfo.textContent = `${state.currentPage} / ${state.totalPages}`);
        elements.mobileContextPageInfo && (elements.mobileContextPageInfo.textContent = `${state.currentPage} / ${state.totalPages}`);
    } else {
        elements.pageInfo.textContent = '—';
        elements.mobilePageInfo && (elements.mobilePageInfo.textContent = '—');
        elements.mobileContextPageInfo && (elements.mobileContextPageInfo.textContent = '—');
    }
}

function loadFilesFromStorage() {
    return [];
}

setAppService('getProjectFiles', () => state.files);
setAppService('hydrateProjectFiles', (projectFiles, options = {}) => workspaceDocuments.hydrateProjectFiles(projectFiles, options));

// Start app
readerLoader = createReaderLoader({
    elements,
    state,
    getOutlineSidebar: () => outlineSidebar,
    documentHistoryManager,
    resetAuxiliaryPanels,
    setToolMode: (mode) => getAppContext().setToolMode?.(mode),
    updatePageInfo
});

void init();
