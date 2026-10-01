
import { getAppContext, restoreBoardState } from '../app/app-context.js';
import { resolveDocumentHistoryIpc } from './document-history-ipc.js';
import {
    applySaveResultToHistory,
    buildAutoSavePayload,
    getBaseBookName,
    getRestoreCandidates,
    getSaveFilename,
    resolveHistoryFilename,
    sanitizeSaveFilename
} from './document-history-helpers.js';
import {
    DOCUMENT_HISTORY_STORAGE_KEY,
    loadDocumentHistory,
    saveDocumentHistory,
    updateDocumentHistoryLocation,
    updateDocumentHistoryPage,
    updateDocumentHistoryScroll
} from './document-history-store.js';
import { createLogger } from './logger.js';
import {
    getInksightExpectedElementCount,
    restoreInksightPersistence,
    validateInksightRestorePayload
} from '../inksight-file/inksight-file-restore.js';
import { APP_EVENTS } from './event-names.js';

const logger = createLogger('DocumentHistoryManager');

export class DocumentHistoryManager {
    constructor() {
        this.ipcRenderer = null;
        this.history = {};
        this.autoSaveInterval = null;
        this.currentMd5 = null;
        this.currentBookName = null;
        this.HISTORY_KEY = DOCUMENT_HISTORY_STORAGE_KEY;
        this.hasPendingRestore = false;
        this.isStatsRestored = true;
        this.initialElementCount = 0;

        this.init();
    }

    sanitizeSaveFilename(filename) {
        return sanitizeSaveFilename(filename);
    }

    getBaseBookName(bookName) {
        return getBaseBookName(bookName);
    }

    getSaveFilename(bookName) {
        return getSaveFilename(bookName);
    }

    getRestoreCandidates(bookName) {
        return getRestoreCandidates(bookName);
    }

    init() {
        this.ipcRenderer = resolveDocumentHistoryIpc();
        this.history = loadDocumentHistory(localStorage, this.HISTORY_KEY);
    }

    getHistory(md5) {
        return this.history[md5];
    }

    updatePage(md5, page) {
        updateDocumentHistoryPage(this.history, md5, page);
        this.saveHistory();
    }

    updateLocation(md5, location) {
        updateDocumentHistoryLocation(this.history, md5, location);
        this.saveHistory();
    }

    updateScroll(md5, scrollTop) {
        updateDocumentHistoryScroll(this.history, md5, scrollTop);
        this.saveHistory();
    }

    saveHistory() {
        saveDocumentHistory(this.history, localStorage, this.HISTORY_KEY);
    }

    startAutoSave(md5, bookName) {
        this.stopAutoSave();
        this.currentMd5 = md5;
        this.currentBookName = bookName;

        logger.debug('Starting auto-save for', bookName);

        // Auto-save every 3 minutes
        this.autoSaveInterval = setInterval(() => {
            this.performAutoSave();
        }, 3 * 60 * 1000);
    }

    stopAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
        this.currentMd5 = null;
        this.currentBookName = null;
    }

    async performAutoSave() {
        // Late init retry
        if (!this.ipcRenderer) {
            this.init();
        }

        const appContext = getAppContext();
        if (!this.currentMd5 || !this.ipcRenderer || !appContext) {
            return; // Silent fail if not ready
        }

        // SAFETY: Do not save if restore hasn't confirmed success
        if (!this.isStatsRestored && this.hasPendingRestore) {
            logger.warn('Skipping auto-save: Restore pending or in progress.');
            return;
        }

        try {
            const board = appContext.board;
            if (!board) return;

            // SAFETY VALVE: Empty Board Protection
            // If we expected elements (from restore) but board is empty, DO NOT SAVE.
            if (this.initialElementCount > 0 && board.children.length === 0) {
                logger.error('CRITICAL: Attempted to save EMPTY board over existing data. Aborting save.');
                return;
            }

            const data = buildAutoSavePayload({
                appContext,
                board,
                historyEntry: this.history[this.currentMd5]
            });

            const jsonStr = JSON.stringify(data, null, 2);

            // Construct filename
            const safeFileName = this.getSaveFilename(this.currentBookName);

            // Use IPC to save
            const result = await this.ipcRenderer.saveFile(safeFileName, jsonStr);

            if (result.success) {
                logger.debug('Auto-saved to', result.path);
                applySaveResultToHistory({
                    history: this.history,
                    md5: this.currentMd5,
                    resultPath: result.path,
                    saveFilename: safeFileName
                });
                this.saveHistory();
            } else {
                logger.error('IPC save failed:', result.error);
            }

        } catch (e) {
            logger.error('Auto-save failed', e);
        }
    }

    cacheResolvedFilename(md5, filename) {
        this.updatePage(md5, 1);
        if (this.history[md5]) {
            this.history[md5].saveFilename = filename;
            this.saveHistory();
        }
    }

    async findFilenameByMd5(md5) {
        if (!this.ipcRenderer?.findSaveByMd5) {
            return null;
        }

        const searchResult = await this.ipcRenderer.findSaveByMd5(md5);
        if (searchResult.success && searchResult.filename) {
            logger.debug('MD5 match found', searchResult.filename);
            this.cacheResolvedFilename(md5, searchResult.filename);
            return searchResult.filename;
        }

        return null;
    }

    async determineRestoreFilename(md5) {
        const record = this.history[md5];
        if (record && (record.saveFilename || record.autoSavePath)) {
            return resolveHistoryFilename(record);
        }

        const bookName = getAppContext().currentBook?.name;
        if (bookName) {
            const candidates = this.getRestoreCandidates(bookName);
            logger.debug('No history found, trying fallback candidates', candidates);
            const fallbackFilename = candidates[0] || null;
            logger.debug('Selected fallback filename', fallbackFilename);
            if (fallbackFilename) {
                return fallbackFilename;
            }
        }

        logger.debug('No filename determined for restore. Attempting MD5 match...');
        return await this.findFilenameByMd5(md5);
    }

    async loadRestorePayload(md5, filename) {
        let activeFilename = filename;
        let result = { success: false };

        if (activeFilename) {
            logger.debug('Requesting restore for', activeFilename);
            result = await this.ipcRenderer.loadFile(activeFilename);
        }

        if (!result.success) {
            logger.warn('Primary load failed (' + (result.error || 'No filename') + '). Attempting MD5 Auto-Discovery...');
            const discoveredFilename = await this.findFilenameByMd5(md5);
            if (discoveredFilename) {
                activeFilename = discoveredFilename;
                logger.debug('MD5 match found. Recovering from', activeFilename);
                result = await this.ipcRenderer.loadFile(activeFilename);
            } else {
                logger.debug('MD5 Auto-Discovery found no matches.');
            }
        }

        return { filename: activeFilename, result };
    }

    completeRestore({ restored = true } = {}) {
        this.isStatsRestored = restored;
        this.hasPendingRestore = false;
    }

    async restoreBoardWhenReady(data) {
        logger.debug('Restoring board state', { elements: data.elements.length });
        restoreBoardState({ elements: data.elements, viewport: data.viewport });
        this.completeRestore({ restored: true });
    }

    restorePagePosition(md5, data) {
        if (!data.lastPage) {
            return;
        }

        logger.debug('Found lastPage in save file', data.lastPage);
        this.updatePage(md5, data.lastPage);
        window.dispatchEvent(new CustomEvent(APP_EVENTS.RESTORE_PAGE_POSITION, {
            detail: { page: data.lastPage }
        }));
    }

    trackExpectedElements(data) {
        const expectedCount = getInksightExpectedElementCount(data);

        if (expectedCount === 0 && !Array.isArray(data?.elements)) {
            return;
        }

        this.initialElementCount = expectedCount;
        logger.debug('Expecting to restore elements', this.initialElementCount);
    }

    restorePersistenceState(data, appContext) {
        restoreInksightPersistence(data, appContext, {
            clearPdfHighlights: false,
            fallbackToCurrentBookIdWithoutMd5: true
        });
    }

    async restoreState(md5) {
        if (!md5 || !this.ipcRenderer) return;
        this.hasPendingRestore = true; // Mark restore start
        this.initialElementCount = 0;   // Reset count

        const filename = await this.determineRestoreFilename(md5);
        if (!filename) {
            logger.debug('No filename determined after all fallbacks. Assuming new document.');
            this.completeRestore({ restored: true });
            return;
        }

        try {
            const { result } = await this.loadRestorePayload(md5, filename);

            if (!result.success) {
                logger.warn('All restore attempts failed. Assuming valid NEW document.');
                this.completeRestore({ restored: true });
                return;
            }

            const data = JSON.parse(result.content);
            validateInksightRestorePayload(data, {
                expectedMd5: md5,
                onMismatch: ({ expectedMd5, actualMd5 }) => {
                    logger.warn('MD5 mismatch in save file', { expected: expectedMd5, actual: actualMd5 });
                }
            });
            this.restorePagePosition(md5, data);
            this.trackExpectedElements(data);

            // Restore Data
            const ag = getAppContext();
            if (!ag) return;
            this.restorePersistenceState(data, ag);

            if (data.elements) {
                void this.restoreBoardWhenReady(data);
            } else {
                this.completeRestore({ restored: true });
            }

        } catch (e) {
            logger.error('Restore failed', e);
            // On hard failure, avoid auto-save to protect file
            this.completeRestore({ restored: false });
        }
    }
}

export const documentHistoryManager = new DocumentHistoryManager();
