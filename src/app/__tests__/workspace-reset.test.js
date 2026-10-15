import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Transforms } from '@plait/core';
import { resetWorkspace } from '../workspace-reset.js';
import { DOCUMENT_HISTORY_STORAGE_KEY } from '../../core/document-history-store.js';
import { graphNodesStore } from '../../mindmap/graph-view/graph-nodes-store.js';
import {
    ensureRuntimeProjectId,
    ensureRuntimeSessionId,
    ensureRuntimeUserId,
    RUNTIME_PROJECT_ID_KEY,
    RUNTIME_SESSION_ID_KEY
} from '../runtime-project-identity.js';

vi.mock('@plait/core', () => ({
    Transforms: {
        removeNode: vi.fn((board, [index]) => board.children.splice(index, 1))
    }
}));

describe('workspace reset', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        sessionStorage.clear();
        window.inksight = {
            board: { children: [{ id: 'first' }, { id: 'second' }] },
            cardSystem: { clearAll: vi.fn() },
            highlightManager: { clearAll: vi.fn() },
            documentManager: { clearAll: vi.fn() }
        };
        graphNodesStore.restorePersistenceData({
            nodes: [{ id: 'node', parentId: 'card', content: 'Note' }]
        });
    });

    it('clears workspace data and renews project/session identities while preserving user and AI data', async () => {
        const userId = ensureRuntimeUserId();
        const projectId = ensureRuntimeProjectId();
        const sessionId = ensureRuntimeSessionId();
        const aiConfig = JSON.stringify({ provider: 'openai', apiKey: 'test-key' });
        localStorage.setItem('inksight:ai-config', aiConfig);
        localStorage.setItem('unrelated:preference', 'keep');
        localStorage.setItem(RUNTIME_SESSION_ID_KEY, 'legacy-session');
        localStorage.setItem('inksight_project_autosave_snapshot', '{}');
        localStorage.setItem('inksight_project_autosave_prefs', '{}');
        localStorage.setItem(DOCUMENT_HISTORY_STORAGE_KEY, '{}');

        await resetWorkspace();

        expect(window.inksight.board.children).toEqual([]);
        expect(Transforms.removeNode).toHaveBeenNthCalledWith(1, window.inksight.board, [1]);
        expect(Transforms.removeNode).toHaveBeenNthCalledWith(2, window.inksight.board, [0]);
        expect(window.inksight.cardSystem.clearAll).toHaveBeenCalledOnce();
        expect(window.inksight.highlightManager.clearAll).toHaveBeenCalledOnce();
        expect(window.inksight.documentManager.clearAll).toHaveBeenCalledOnce();
        expect(graphNodesStore.getAll()).toEqual([]);
        expect(localStorage.getItem(RUNTIME_PROJECT_ID_KEY)).toBeNull();
        expect(localStorage.getItem(RUNTIME_SESSION_ID_KEY)).toBeNull();
        expect(sessionStorage.getItem(RUNTIME_SESSION_ID_KEY)).toBeNull();
        expect(localStorage.getItem('inksight_project_autosave_snapshot')).toBeNull();
        expect(localStorage.getItem('inksight_project_autosave_prefs')).toBeNull();
        expect(localStorage.getItem(DOCUMENT_HISTORY_STORAGE_KEY)).toBeNull();
        expect(ensureRuntimeProjectId()).not.toBe(projectId);
        expect(ensureRuntimeSessionId()).not.toBe(sessionId);
        expect(ensureRuntimeUserId()).toBe(userId);
        expect(localStorage.getItem('inksight:ai-config')).toBe(aiConfig);
        expect(localStorage.getItem('unrelated:preference')).toBe('keep');
    });

    it('clears identities even when the canvas has not been initialized', async () => {
        window.inksight.board = null;
        ensureRuntimeSessionId();
        ensureRuntimeProjectId();

        await resetWorkspace();

        expect(Transforms.removeNode).not.toHaveBeenCalled();
        expect(localStorage.getItem(RUNTIME_PROJECT_ID_KEY)).toBeNull();
        expect(sessionStorage.getItem(RUNTIME_SESSION_ID_KEY)).toBeNull();
    });

    it('clears the session independently when localStorage is unavailable', async () => {
        ensureRuntimeSessionId();
        const removeItem = Storage.prototype.removeItem;
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (key) {
            if (this === localStorage) throw new Error('Storage unavailable');
            return removeItem.call(this, key);
        });

        await expect(resetWorkspace()).resolves.toBeUndefined();

        expect(sessionStorage.getItem(RUNTIME_SESSION_ID_KEY)).toBeNull();
    });
});
