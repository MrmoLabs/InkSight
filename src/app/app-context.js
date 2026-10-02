import { APP_EVENTS } from '../core/event-names.js';

const DEFAULT_CONTEXT = {
    currentBook: {
        md5: null,
        name: null,
        id: null
    },
    cardSystem: null,
    highlightManager: null,
    documentManager: null,
    pdfReader: null,
    outlineSidebar: null,
    annotationList: null,
    board: null,
    pendingRestore: null,
    pendingBoardRestore: null,
    workspaceSnapshotRestored: false,
    workspaceRestoreFailed: false,
    pendingDocumentImport: null,
    openProjectFile: null,
    getProjectFiles: null,
    hydrateProjectFiles: null,
    currentProjectId: null,
    runtimeUserId: null,
    runtimeSessionId: null,
    runtimeStorageInfo: null,
    currentProjectDirectoryHandle: null,
    currentProjectCleanup: null
};

export function initAppContext() {
    const existing = window.inksight || {};
    const context = {
        ...DEFAULT_CONTEXT,
        ...existing,
        currentBook: {
            ...DEFAULT_CONTEXT.currentBook,
            ...(existing.currentBook || {})
        }
    };

    window.inksight = context;
    return context;
}

export function getAppContext() {
    return window.inksight || initAppContext();
}

export function getAppService(key) {
    return getAppContext()[key];
}

export function setAppService(key, value) {
    const context = getAppContext();
    context[key] = value;
    return value;
}

export function restoreBoardState(payload) {
    const context = getAppContext();
    if (!context.board) {
        context.pendingBoardRestore = payload;
        return false;
    }

    window.dispatchEvent(new CustomEvent(APP_EVENTS.RESTORE_BOARD_STATE, { detail: payload }));
    return true;
}

export function flushPendingBoardRestore() {
    const context = getAppContext();
    if (!context.board || !context.pendingBoardRestore) {
        return false;
    }

    const payload = context.pendingBoardRestore;
    context.pendingBoardRestore = null;
    if (payload.expectedBookMd5 && payload.expectedBookMd5 !== context.currentBook?.md5) {
        return false;
    }
    window.dispatchEvent(new CustomEvent(APP_EVENTS.RESTORE_BOARD_STATE, { detail: payload }));
    return true;
}

export function updateCurrentBook(patch) {
    const context = getAppContext();
    Object.assign(context.currentBook, patch);
    return context.currentBook;
}
