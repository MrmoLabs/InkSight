import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../ui/app-notifications.js', () => ({
    emitAppNotification: vi.fn()
}));

vi.mock('../../inksight-file/inksight-project-actions.js', () => ({
    saveCurrentProject: vi.fn()
}));

vi.mock('../../inksight-file/inksight-file-restore.js', () => ({
    restoreInksightPersistence: vi.fn()
}));

vi.mock('../../inksight-file/inksight-runtime-project-io.js', () => ({
    loadRuntimeProjectSnapshot: vi.fn(),
    saveRuntimeProjectSnapshot: vi.fn(),
    listRuntimeProjectSnapshots: vi.fn()
}));

vi.mock('../workspace-export.js', () => ({
    exportWorkspaceArtifact: vi.fn(() => true)
}));

describe('project-workspace', () => {
    let createProjectWorkspaceController;
    let saveCurrentProject;
    let loadRuntimeProjectSnapshot;
    let saveRuntimeProjectSnapshot;
    let listRuntimeProjectSnapshots;
    let emitAppNotification;
    let exportWorkspaceArtifact;

    beforeEach(async () => {
        vi.resetModules();
        ({ createProjectWorkspaceController } = await import('../project-workspace.js'));
        ({ saveCurrentProject } = await import('../../inksight-file/inksight-project-actions.js'));
        ({ loadRuntimeProjectSnapshot, saveRuntimeProjectSnapshot, listRuntimeProjectSnapshots } = await import('../../inksight-file/inksight-runtime-project-io.js'));
        ({ emitAppNotification } = await import('../../ui/app-notifications.js'));
        ({ exportWorkspaceArtifact } = await import('../workspace-export.js'));

        document.body.innerHTML = `<div id="save-status"></div>`;
        localStorage.clear();
        sessionStorage.clear();

        const { initAppContext, setAppService } = await import('../app-context.js');
        initAppContext();
        window.inksight.board = { id: 'board-1' };
        window.inksight.currentBook = { name: 'Book.pdf' };
        window.inksight.getProjectFiles = vi.fn(() => [{ id: 'file-1' }]);
        window.inksight.hydrateProjectFiles = vi.fn();
        window.inksight.runtimeStorageInfo = {};
        setAppService('currentProjectId', 'project-1');
        listRuntimeProjectSnapshots.mockResolvedValue({
            snapshots: []
        });
    });

    function createController(renderFileList = vi.fn()) {
        return createProjectWorkspaceController({
            localStorage,
            sessionStorage,
            saveStatusIndicator: document.getElementById('save-status'),
            renderFileList
        });
    }

    it('handles project-save-completed by updating the indicator text', () => {
        const controller = createController();

        controller.handleProjectSaveCompleted({
            detail: {
                savedAt: Date.parse('2026-04-16T10:20:00.000Z'),
                mode: 'Server workspace'
            }
        });

        expect(document.getElementById('save-status').textContent).toContain('Saved at');
    });

    it('performs server autosave and updates runtime storage info', async () => {
        saveRuntimeProjectSnapshot.mockResolvedValue({
            success: true,
            projectDir: 'D:/runtime/project',
            snapshotId: 'snapshot-1',
            savedAt: '2026-04-16T10:20:00.000Z',
            summary: {
                cardCount: 2,
                highlightCount: 1,
                documentCount: 1,
                elementCount: 3
            }
        });
        const controller = createController();

        const result = await controller.performProjectAutosave({ notify: true });

        expect(result).toBe(true);
        expect(saveRuntimeProjectSnapshot).toHaveBeenCalled();
        expect(window.inksight.runtimeStorageInfo.rootPath).toBe('D:/runtime/project');
        expect(emitAppNotification).toHaveBeenCalled();
        expect(listRuntimeProjectSnapshots).toHaveBeenCalled();
    });

    it('restores a runtime workspace and hydrates project files when available', async () => {
        loadRuntimeProjectSnapshot.mockResolvedValue({
            payload: {
                elements: [{ id: 'node-1' }],
                viewport: { x: 1, y: 2, zoom: 1 },
                theme: 'light',
                bookId: 'doc-2'
            },
            projectFiles: [{ id: 'doc-2', name: 'Doc.pdf', type: 'application/pdf' }],
            cleanup: vi.fn(),
            projectId: 'project-2',
            projectName: 'Recovered',
            savedAt: '2026-04-16T10:20:00.000Z'
        });
        const controller = createController();

        const result = await controller.restoreRuntimeWorkspace();

        expect(result).toBe(true);
        expect(window.inksight.hydrateProjectFiles).toHaveBeenCalledWith(
            [{ id: 'doc-2', name: 'Doc.pdf', type: 'application/pdf' }],
            { openCurrentBookId: 'doc-2' }
        );
        expect(window.inksight.workspaceSnapshotRestored).toBe(true);
        expect(document.getElementById('save-status').textContent).toContain('Recovered server workspace');
    });

    it('blocks project autosave while a runtime workspace restore is in flight', async () => {
        let finishLoad;
        loadRuntimeProjectSnapshot.mockReturnValue(new Promise((resolve) => {
            finishLoad = resolve;
        }));
        const controller = createController();

        const restoring = controller.restoreRuntimeWorkspace();
        while (!finishLoad) {
            await Promise.resolve();
        }

        expect(await controller.performProjectAutosave()).toBe(false);
        expect(saveRuntimeProjectSnapshot).not.toHaveBeenCalled();

        finishLoad(null);
        await restoring;
    });

    it('pauses background autosave after a damaged snapshot and allows a manual replacement', async () => {
        loadRuntimeProjectSnapshot.mockResolvedValue({
            success: false,
            notFound: false,
            error: 'Invalid project asset size'
        });
        saveRuntimeProjectSnapshot.mockResolvedValue({
            success: true,
            projectDir: 'D:/runtime/project',
            snapshotId: 'snapshot-replacement',
            savedAt: '2026-04-16T10:20:00.000Z',
            summary: {}
        });
        const controller = createController();

        expect(await controller.restoreRuntimeWorkspace()).toBe(false);
        expect(window.inksight.workspaceRestoreFailed).toBe(true);
        expect(await controller.performProjectAutosave()).toBe(false);
        expect(saveRuntimeProjectSnapshot).not.toHaveBeenCalled();

        expect(await controller.performProjectAutosave({ notify: true })).toBe(true);
        expect(window.inksight.workspaceRestoreFailed).toBe(false);
        expect(saveRuntimeProjectSnapshot).toHaveBeenCalledTimes(1);
    });

    it('restores a selected snapshot from project history', async () => {
        listRuntimeProjectSnapshots.mockResolvedValue({
            snapshots: [{
                snapshotId: 'snapshot-1',
                savedAt: '2026-04-16T10:20:00.000Z',
                projectName: 'Recovered',
                bookName: 'Doc.pdf',
                cardCount: 2,
                highlightCount: 1,
                documentCount: 1
            }]
        });
        loadRuntimeProjectSnapshot.mockResolvedValue({
            payload: {
                elements: [{ id: 'node-1' }],
                viewport: { x: 1, y: 2, zoom: 1 },
                theme: 'light',
                bookId: 'doc-2'
            },
            projectFiles: [{ id: 'doc-2', name: 'Doc.pdf', type: 'application/pdf' }],
            cleanup: vi.fn(),
            projectId: 'project-2',
            projectName: 'Recovered',
            savedAt: '2026-04-16T10:20:00.000Z',
            snapshotId: 'snapshot-1'
        });
        const { modalManager } = await import('../../ui/modal-manager.js');
        vi.spyOn(modalManager, 'confirm').mockResolvedValue(true);
        const controller = createController();

        await controller.refreshProjectSnapshotHistory();
        const restored = await controller.restoreProjectHistorySnapshot('snapshot-1');

        expect(restored).toBe(true);
        expect(loadRuntimeProjectSnapshot).toHaveBeenCalledWith({
            runtimeIdentity: expect.objectContaining({ projectId: expect.any(String) }),
            snapshotId: 'snapshot-1'
        });
    });

    it('exports the project folder when promptSaveProject is called with a board', async () => {
        saveCurrentProject.mockResolvedValue({ ok: true });
        saveRuntimeProjectSnapshot.mockResolvedValue({
            success: true,
            snapshotId: 'snapshot-after-save',
            savedAt: '2026-04-16T10:21:00.000Z',
            summary: {}
        });
        const controller = createController();

        await controller.promptSaveProject();

        expect(saveCurrentProject).toHaveBeenCalledWith(window.inksight.board);
        expect(saveRuntimeProjectSnapshot).toHaveBeenCalled();
        expect(document.getElementById('save-status').textContent).toBe('Project saved and reload recovery updated.');
    });

    it('records recent runtime workspaces after autosave', async () => {
        saveRuntimeProjectSnapshot.mockResolvedValue({
            success: true,
            projectDir: 'D:/runtime/project',
            snapshotId: 'snapshot-1',
            savedAt: '2026-04-16T10:20:00.000Z',
            summary: {
                cardCount: 2,
                highlightCount: 1,
                documentCount: 1,
                elementCount: 3
            }
        });
        const controller = createController();

        await controller.performProjectAutosave();

        expect(controller.getRecentProjects()).toEqual([
            expect.objectContaining({
                projectId: expect.any(String),
                source: 'runtime-workspace'
            })
        ]);
    });

    it('delegates artifact export through the workspace export module', () => {
        const controller = createController();

        controller.promptExportArtifact('outline');

        expect(exportWorkspaceArtifact).toHaveBeenCalledWith({ type: 'outline' });
    });
});
