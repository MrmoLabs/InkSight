import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS } from '../event-names.js';
import { flushPendingBoardRestore } from '../../app/app-context.js';

function createInksightState(overrides = {}) {
    return {
        board: { children: [{ id: 'el-1' }], viewport: { x: 1, y: 2, zoom: 1 } },
        currentBook: { md5: 'book-md5', id: 'book-md5', name: 'Book.pdf' },
        highlightManager: {
            getPersistenceData: vi.fn(() => ({ highlights: [{ id: 'h-1' }] })),
            restorePersistenceData: vi.fn()
        },
        cardSystem: {
            getPersistenceData: vi.fn(() => ({ cards: [['c-1', { id: 'c-1' }]], connections: [{ id: 'link-1' }] })),
            restorePersistenceData: vi.fn()
        },
        ...overrides
    };
}

describe('DocumentHistoryManager', () => {
    let DocumentHistoryManager;
    let manager;
    let mockIpc;
    let originalRequire;

    beforeEach(async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        localStorage.clear();

        originalRequire = globalThis.require;
        globalThis.require = undefined;
        window.require = undefined;
        window.ipcRenderer = undefined;
        window.electronAPI = undefined;

        window.inksight = createInksightState();

        mockIpc = {
            saveFile: vi.fn().mockResolvedValue({ success: true, path: '/tmp/Book.inksight' }),
            loadFile: vi.fn(),
            findSaveByMd5: vi.fn()
        };

        vi.resetModules();
        ({ DocumentHistoryManager } = await import('../document-history-manager.js'));
        manager = new DocumentHistoryManager();
        manager.ipcRenderer = mockIpc;
        manager.currentMd5 = 'book-md5';
        manager.currentBookName = 'Book.pdf';
    });

    afterEach(() => {
        manager?.stopAutoSave();
        globalThis.require = originalRequire;
        delete window.require;
        delete window.ipcRenderer;
        delete window.electronAPI;
        vi.useRealTimers();
        vi.restoreAllMocks();
        localStorage.clear();
    });

    describe('filename helpers', () => {
        it('normalizes save filenames from source book names', () => {
            expect(manager.getBaseBookName('Book.pdf')).toBe('Book');
            expect(manager.getSaveFilename('Book.pdf')).toBe('Book.inksight');
            expect(manager.getSaveFilename('Research:Draft?.epub')).toBe('Research_Draft_.inksight');
        });

        it('returns restore candidates in preferred order', () => {
            expect(manager.getRestoreCandidates('Novel.epub')).toEqual([
                'Novel.inksight',
                'Novel.epub.inksight'
            ]);
            expect(manager.getRestoreCandidates('Notes')).toEqual(['Notes.inksight']);
        });
    });

    describe('auto-save lifecycle', () => {
        it('schedules periodic auto-save and clears it on stop', () => {
            vi.useFakeTimers();
            const performAutoSaveSpy = vi.spyOn(manager, 'performAutoSave').mockResolvedValue();

            manager.startAutoSave('md5-1', 'Timed Book.pdf');
            vi.advanceTimersByTime(3 * 60 * 1000);

            expect(performAutoSaveSpy).toHaveBeenCalledTimes(1);
            expect(manager.currentMd5).toBe('md5-1');
            expect(manager.currentBookName).toBe('Timed Book.pdf');

            manager.stopAutoSave();
            vi.advanceTimersByTime(3 * 60 * 1000);

            expect(performAutoSaveSpy).toHaveBeenCalledTimes(1);
            expect(manager.currentMd5).toBeNull();
            expect(manager.currentBookName).toBeNull();
        });

        it('skips saving while restore is still pending', async () => {
            manager.hasPendingRestore = true;
            manager.isStatsRestored = false;

            await manager.performAutoSave();

            expect(mockIpc.saveFile).not.toHaveBeenCalled();
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Restore pending'));
        });

        it('prevents overwriting existing content with an empty board', async () => {
            manager.initialElementCount = 3;
            manager.isStatsRestored = true;
            window.inksight.board.children = [];

            await manager.performAutoSave();

            expect(mockIpc.saveFile).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('EMPTY board'));
        });

        it('serializes board state, metadata, and updates save history', async () => {
            manager.updatePage('book-md5', 42);
            manager.isStatsRestored = true;

            await manager.performAutoSave();

            expect(mockIpc.saveFile).toHaveBeenCalledWith('Book.inksight', expect.any(String));

            const [, payload] = mockIpc.saveFile.mock.calls[0];
            const parsed = JSON.parse(payload);
            expect(parsed.bookMd5).toBe('book-md5');
            expect(parsed.bookName).toBe('Book.pdf');
            expect(parsed.cards).toEqual([['c-1', { id: 'c-1' }]]);
            expect(parsed.highlights).toEqual([{ id: 'h-1' }]);
            expect(parsed.lastPage).toBe(42);
            expect(manager.history['book-md5'].saveFilename).toBe('Book.inksight');
            expect(manager.history['book-md5'].autoSavePath).toBe('/tmp/Book.inksight');
        });
    });

    describe('restore flow', () => {
        it('loads from persisted autoSavePath basename when saveFilename is missing', async () => {
            manager.history['book-md5'] = { autoSavePath: 'C:\\saves\\Recovered.inksight' };
            mockIpc.loadFile.mockResolvedValue({ success: true, content: JSON.stringify({ elements: [] }) });

            await manager.restoreState('book-md5');

            expect(mockIpc.loadFile).toHaveBeenCalledWith('Recovered.inksight');
        });

        it('falls back to normalized filename candidates when there is no history', async () => {
            window.inksight.currentBook.name = 'Novel.epub';
            mockIpc.loadFile.mockResolvedValue({ success: false, error: 'missing' });
            mockIpc.findSaveByMd5.mockResolvedValue({ success: false });

            await manager.restoreState('book-md5');

            expect(mockIpc.loadFile).toHaveBeenCalledWith('Novel.inksight');
        });

        it('uses MD5 lookup when the primary restore file is missing', async () => {
            manager.history['book-md5'] = { saveFilename: 'Missing.inksight' };
            mockIpc.loadFile
                .mockResolvedValueOnce({ success: false, error: 'missing' })
                .mockResolvedValueOnce({ success: true, content: JSON.stringify({ elements: [] }) });
            mockIpc.findSaveByMd5.mockResolvedValue({ success: true, filename: 'Recovered.inksight' });

            await manager.restoreState('book-md5');

            expect(mockIpc.findSaveByMd5).toHaveBeenCalledWith('book-md5');
            expect(mockIpc.loadFile).toHaveBeenNthCalledWith(1, 'Missing.inksight');
            expect(mockIpc.loadFile).toHaveBeenNthCalledWith(2, 'Recovered.inksight');
            expect(manager.history['book-md5'].saveFilename).toBe('Recovered.inksight');
        });

        it('restores page position, cards, highlights, and board state when board is ready', async () => {
            const restorePageListener = vi.fn();
            const restoreBoardListener = vi.fn();
            window.addEventListener(APP_EVENTS.RESTORE_PAGE_POSITION, restorePageListener);
            window.addEventListener(APP_EVENTS.RESTORE_BOARD_STATE, restoreBoardListener);

            mockIpc.loadFile.mockResolvedValue({
                success: true,
                content: JSON.stringify({
                    lastPage: 9,
                    elements: [{ id: 'restored-node' }],
                    viewport: { x: 10, y: 20, zoom: 2 },
                    highlights: [{ id: 'h-9' }],
                    cards: [['c-9', { id: 'c-9' }]],
                    connections: [{ id: 'link-9' }]
                })
            });

            await manager.restoreState('book-md5');

            expect(restorePageListener).toHaveBeenCalled();
            expect(restoreBoardListener).toHaveBeenCalled();
            expect(window.inksight.highlightManager.restorePersistenceData).toHaveBeenCalledWith(
                { highlights: [{ id: 'h-9' }] },
                { from: null, to: 'book-md5' }
            );
            expect(window.inksight.cardSystem.restorePersistenceData).toHaveBeenCalledWith(
                { cards: [['c-9', { id: 'c-9' }]], connections: [{ id: 'link-9' }] },
                { from: null, to: 'book-md5' }
            );
            expect(manager.initialElementCount).toBe(1);
            expect(manager.isStatsRestored).toBe(true);
            expect(manager.hasPendingRestore).toBe(false);

            window.removeEventListener(APP_EVENTS.RESTORE_PAGE_POSITION, restorePageListener);
            window.removeEventListener(APP_EVENTS.RESTORE_BOARD_STATE, restoreBoardListener);
        });

        it('keeps board restore queued until the deferred canvas becomes ready', async () => {
            window.inksight.board = null;

            const restoreBoardListener = vi.fn();
            window.addEventListener(APP_EVENTS.RESTORE_BOARD_STATE, restoreBoardListener);

            mockIpc.loadFile.mockResolvedValue({
                success: true,
                content: JSON.stringify({
                    elements: [{ id: 'delayed-node' }],
                    viewport: { x: 0, y: 0, zoom: 1 }
                })
            });

            await manager.restoreState('book-md5');
            expect(restoreBoardListener).not.toHaveBeenCalled();
            expect(manager.isStatsRestored).toBe(true);

            window.dispatchEvent(new CustomEvent(APP_EVENTS.BOARD_READY));
            window.inksight.board = { children: [] };
            expect(flushPendingBoardRestore()).toBe(true);

            expect(restoreBoardListener).toHaveBeenCalled();
            expect(manager.isStatsRestored).toBe(true);
            expect(manager.hasPendingRestore).toBe(false);

            window.removeEventListener(APP_EVENTS.RESTORE_BOARD_STATE, restoreBoardListener);
        });
    });
});
