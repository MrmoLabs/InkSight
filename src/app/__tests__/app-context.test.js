import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_EVENTS } from '../../core/event-names.js';
import { flushPendingBoardRestore, initAppContext, restoreBoardState, setAppService } from '../app-context.js';

describe('deferred board restoration', () => {
    beforeEach(() => {
        delete window.inksight;
        initAppContext();
    });

    it('queues project state until a board is mounted', () => {
        const payload = { elements: [{ id: 'node-1' }], viewport: { zoom: 1 } };
        const listener = vi.fn();
        window.addEventListener(APP_EVENTS.RESTORE_BOARD_STATE, listener, { once: true });

        expect(restoreBoardState(payload)).toBe(false);
        expect(listener).not.toHaveBeenCalled();

        setAppService('board', {});
        expect(flushPendingBoardRestore()).toBe(true);
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: payload }));
        expect(window.inksight.pendingBoardRestore).toBeNull();
    });

    it('dispatches immediately when the board already exists', () => {
        const payload = { elements: [] };
        const listener = vi.fn();
        setAppService('board', {});
        window.addEventListener(APP_EVENTS.RESTORE_BOARD_STATE, listener, { once: true });

        expect(restoreBoardState(payload)).toBe(true);
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ detail: payload }));
    });

    it('drops a queued document restore after switching books', () => {
        const listener = vi.fn();
        window.addEventListener(APP_EVENTS.RESTORE_BOARD_STATE, listener);
        setAppService('currentBook', { md5: 'book-a' });

        expect(restoreBoardState({ elements: [], expectedBookMd5: 'book-a' })).toBe(false);
        setAppService('currentBook', { md5: 'book-b' });
        setAppService('board', {});

        expect(flushPendingBoardRestore()).toBe(false);
        expect(listener).not.toHaveBeenCalled();
        window.removeEventListener(APP_EVENTS.RESTORE_BOARD_STATE, listener);
    });
});
