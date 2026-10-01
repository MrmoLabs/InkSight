import { emitAppNotification } from '../ui/app-notifications.js';
import { createLogger } from '../core/logger.js';
import { t } from '../i18n/index.js';
import { getAppContext, restoreBoardState, setAppService } from './app-context.js';
import {
    formatAutosaveTime,
    loadProjectSnapshotMeta,
    loadProjectAutosavePrefs,
    PROJECT_AUTOSAVE_SNAPSHOT_KEY,
    saveProjectAutosavePrefs
} from './project-status-helpers.js';
import {
    listProjectSnapshots,
    recordProjectSnapshot,
    restoreProjectSnapshot
} from './project-history.js';
import {
    ensureRuntimeProjectId,
    ensureRuntimeSessionId,
    ensureRuntimeUserId,
    setRuntimeProjectId
} from './runtime-project-identity.js';
import { saveCurrentProject } from '../inksight-file/inksight-project-actions.js';
import { restoreInksightPersistence } from '../inksight-file/inksight-file-restore.js';
import { loadRuntimeProjectSnapshot, saveRuntimeProjectSnapshot } from '../inksight-file/inksight-runtime-project-io.js';
import { listRecentProjects, recordRecentProject } from './recent-projects.js';
import { exportWorkspaceArtifact } from './workspace-export.js';
import { modalManager } from '../ui/modal-manager.js';

const logger = createLogger('ProjectWorkspace');

const MODE_LABEL_KEYS = {
    'Server workspace': 'mode.server',
    'Snapshot history': 'mode.snapshotHistory',
    'Local project export': 'mode.localExport'
};

function translateModeLabel(modeLabel) {
    const key = MODE_LABEL_KEYS[modeLabel];
    return key ? t(key) : modeLabel;
}

export function createProjectWorkspaceController({
    localStorage,
    sessionStorage,
    saveStatusIndicator,
    renderFileList,
    renderProjectHome = null,
    ensureBoardReady = null
}) {
    let projectAutosaveIntervalId = null;
    let isProjectAutosaveRunning = false;
    let saveStatusHideTimeout = null;

    const projectStatusState = {
        ...loadProjectAutosavePrefs(localStorage),
        lastSavedAt: loadProjectSnapshotMeta(localStorage).savedAt,
        lastMode: 'Server workspace',
        snapshotHistory: [],
        recentProjects: listRecentProjects(localStorage)
    };

    async function ensureBoardAvailable() {
        if (getAppContext().board) {
            return true;
        }
        if (typeof ensureBoardReady !== 'function') {
            return false;
        }
        try {
            await ensureBoardReady();
        } catch (error) {
            logger.error('Could not initialize the mind map canvas', error);
            emitAppNotification({
                message: t('mindmap.loadFailed', { message: error.message }),
                level: 'error'
            });
        }
        return Boolean(getAppContext().board);
    }

    function refreshRecentProjects() {
        projectStatusState.recentProjects = listRecentProjects(localStorage);
        return projectStatusState.recentProjects;
    }

    function recordRecentProjectEntry(entry = {}) {
        projectStatusState.recentProjects = recordRecentProject({
            snapshotCount: projectStatusState.snapshotHistory.length,
            ...entry
        }, localStorage);
        renderFileList?.();
        renderProjectHome?.();
        return projectStatusState.recentProjects;
    }

    function ensureProjectIdentity() {
        const userId = ensureRuntimeUserId(localStorage);
        const sessionId = ensureRuntimeSessionId(sessionStorage);
        const projectId = ensureRuntimeProjectId(localStorage);

        setAppService('runtimeUserId', userId);
        setAppService('runtimeSessionId', sessionId);
        setAppService('currentProjectId', projectId);

        return { userId, sessionId, projectId };
    }

    function getProjectStatus(files = []) {
        const appContext = getAppContext();
        const linkedToDirectory = Boolean(appContext.currentProjectDirectoryHandle);
        const documentCount = files.length;
        const projectDirectoryName = appContext.currentProjectDirectoryHandle?.name || null;
        const runtimeRoot = appContext.runtimeStorageInfo?.rootPath || null;

        return {
            linkedToDirectory,
            title: linkedToDirectory ? t('status.linkedTitle') : t('status.unlinkedTitle'),
            description: linkedToDirectory
                ? t('status.linkedDesc')
                : t('status.unlinkedDesc'),
            summary: t(documentCount === 1 ? 'status.docs.one' : 'status.docs.other', { count: documentCount }),
            projectDirectoryName,
            runtimeRoot,
            snapshotHistory: projectStatusState.snapshotHistory,
            recentProjects: projectStatusState.recentProjects,
            lastSavedAt: projectStatusState.lastSavedAt,
            lastMode: projectStatusState.lastMode
        };
    }

    async function refreshProjectSnapshotHistory() {
        const runtimeIdentity = ensureProjectIdentity();
        projectStatusState.snapshotHistory = await listProjectSnapshots(runtimeIdentity);
        refreshRecentProjects();
        renderFileList?.();
        renderProjectHome?.();
        return projectStatusState.snapshotHistory;
    }

    async function restoreWorkspacePayload(result, {
        modeLabel = 'Server workspace',
        successMessage
    } = {}) {
        if (!result?.payload) {
            return false;
        }

        const appContext = getAppContext();
        appContext.currentProjectCleanup?.();
        setAppService('currentProjectCleanup', result.cleanup || null);
        setAppService('currentProjectDirectoryHandle', null);
        setAppService('currentProjectId', result.projectId || appContext.currentProjectId);

        restoreBoardState({
            elements: result.payload.elements,
            viewport: result.payload.viewport,
            theme: result.payload.theme
        });

        restoreInksightPersistence(result.payload, appContext, {
            onBookMismatch: ({ bookName }) => {
                emitAppNotification({
                    title: t('notify.bookMismatch.title'),
                    message: t('notify.bookMismatch.message', { book: bookName }),
                    level: 'warning'
                });
            }
        });

        if (result.projectFiles?.length) {
            await appContext.hydrateProjectFiles?.(result.projectFiles, {
                openCurrentBookId: result.payload.bookId || null
            });
        } else {
            renderFileList();
        }

        projectStatusState.lastSavedAt = result.savedAt ? Date.parse(result.savedAt) : projectStatusState.lastSavedAt;
        projectStatusState.lastMode = modeLabel;
        recordRecentProjectEntry({
            projectId: result.projectId || appContext.currentProjectId || runtimeIdentityOrProjectId(appContext, localStorage),
            projectName: result.projectName || appContext.currentBook?.name || 'workspace',
            directoryName: appContext.currentProjectDirectoryHandle?.name || null,
            savedAt: projectStatusState.lastSavedAt,
            lastOpenedAt: Date.now(),
            source: modeLabel === 'Local project export' ? 'project-folder' : 'runtime-workspace'
        });
        showSaveStatus('success', successMessage || t('notify.recovered', { mode: translateModeLabel(modeLabel).toLowerCase() }), 2200);
        return true;
    }

    function runtimeIdentityOrProjectId(appContext, storage) {
        return appContext.currentProjectId || ensureRuntimeProjectId(storage);
    }

    function showSaveStatus(state, message, duration = 1800) {
        if (!saveStatusIndicator) {
            return;
        }

        if (saveStatusHideTimeout) {
            clearTimeout(saveStatusHideTimeout);
            saveStatusHideTimeout = null;
        }

        saveStatusIndicator.textContent = message;
        saveStatusIndicator.className = `save-status-indicator visible ${state}`.trim();

        if (duration > 0) {
            saveStatusHideTimeout = setTimeout(() => {
                saveStatusIndicator.classList.remove('visible', 'success', 'error', 'saving');
            }, duration);
        }
    }

    function restartProjectAutosave() {
        if (projectAutosaveIntervalId) {
            clearInterval(projectAutosaveIntervalId);
            projectAutosaveIntervalId = null;
        }

        if (!projectStatusState.enabled) {
            return;
        }

        projectAutosaveIntervalId = setInterval(() => {
            void performProjectAutosave({ notify: false });
        }, Math.max(1, projectStatusState.intervalMinutes) * 60 * 1000);
    }

    async function persistRuntimeProjectSnapshot({ note = null } = {}) {
        const appContext = getAppContext();
        const board = appContext.board;
        if (!board) {
            return false;
        }

        const runtimeIdentity = ensureProjectIdentity();
        const result = await saveRuntimeProjectSnapshot({
            board,
            appContext,
            projectFiles: appContext.getProjectFiles?.() ?? [],
            runtimeIdentity,
            projectName: appContext.currentBook?.name || 'workspace',
            note: note || null
        });

        if (!result?.success) {
            return false;
        }

        try {
            localStorage.setItem(PROJECT_AUTOSAVE_SNAPSHOT_KEY, JSON.stringify({
                savedAt: Date.now()
            }));
        } catch (error) {
            console.warn('[project-workspace] Failed to persist autosave meta', error);
        }
        await recordProjectSnapshot({
            snapshotId: result.snapshotId,
            savedAt: result.savedAt,
            projectName: appContext.currentBook?.name || 'workspace',
            ...result.summary
        });
        setAppService('runtimeStorageInfo', {
            ...(appContext.runtimeStorageInfo || {}),
            rootPath: result.projectDir || appContext.runtimeStorageInfo?.rootPath || null
        });
        await refreshProjectSnapshotHistory();
        recordRecentProjectEntry({
            projectId: runtimeIdentity.projectId,
            projectName: appContext.currentBook?.name || 'workspace',
            directoryName: null,
            savedAt: Date.parse(result.savedAt || Date.now()),
            lastOpenedAt: Date.now(),
            source: 'runtime-workspace'
        });
        return true;
    }

    async function restoreRuntimeWorkspace() {
        const runtimeIdentity = ensureProjectIdentity();
        const result = await loadRuntimeProjectSnapshot({
            runtimeIdentity
        }).catch(() => null);

        if (!result?.payload) {
            return false;
        }
        await refreshProjectSnapshotHistory();
        return restoreWorkspacePayload(result, {
            modeLabel: 'Server workspace',
            successMessage: result.projectName
                ? t('notify.recoveredServerNamed', { name: result.projectName })
                : t('notify.recoveredServer')
        });
    }

    async function promptProjectHistory() {
        const snapshots = await refreshProjectSnapshotHistory();
        if (!snapshots.length) {
            emitAppNotification({
                title: t('notify.historyEmpty.title'),
                message: t('notify.historyEmpty.message'),
                level: 'warning'
            });
            return [];
        }

        emitAppNotification({
            title: t('notify.historyReady.title'),
            message: t(snapshots.length === 1 ? 'notify.historyReady.message.one' : 'notify.historyReady.message.other', { count: snapshots.length }),
            level: 'success'
        });
        return snapshots;
    }

    async function continueLatestWorkspace() {
        const restored = await restoreRuntimeWorkspace();
        if (!restored) {
            emitAppNotification({
                title: t('notify.continueEmpty.title'),
                message: t('notify.continueEmpty.message'),
                level: 'warning'
            });
        }
        return restored;
    }

    async function openRecentProject(projectId) {
        const recentProject = projectStatusState.recentProjects.find((entry) => entry.projectId === projectId);
        if (!recentProject) {
            return false;
        }

        if (recentProject.source === 'runtime-workspace') {
            setRuntimeProjectId(recentProject.projectId, localStorage);
            setAppService('currentProjectId', recentProject.projectId);
            return continueLatestWorkspace();
        }

        await promptOpenProject();
        return true;
    }

    function promptExportArtifact(type) {
        return exportWorkspaceArtifact({ type });
    }

    async function restoreProjectHistorySnapshot(snapshotId) {
        const runtimeIdentity = ensureProjectIdentity();
        const snapshot = projectStatusState.snapshotHistory.find((entry) => entry.snapshotId === snapshotId);
        const confirmed = await modalManager.confirm({
            title: t('history.restoreTitle'),
            message: t('history.restoreMessage', { time: formatAutosaveTime(Date.parse(snapshot?.savedAt || Date.now())) }),
            confirmLabel: t('library.restore'),
            danger: true
        });
        if (!confirmed) {
            return false;
        }

        const result = await restoreProjectSnapshot({
            runtimeIdentity,
            snapshotId
        }).catch(() => null);
        if (!result?.payload) {
            emitAppNotification({
                title: t('notify.historyRestoreFailed.title'),
                message: t('notify.historyRestoreFailed.message'),
                level: 'error'
            });
            return false;
        }

        await refreshProjectSnapshotHistory();
        return restoreWorkspacePayload(result, {
            modeLabel: 'Snapshot history',
            successMessage: snapshot?.projectName
                ? t('notify.restoredSnapshotNamed', { name: snapshot.projectName })
                : t('notify.restoredSnapshot')
        });
    }

    async function performProjectAutosave({ notify = false, forceExport = false, snapshotNote = null } = {}) {
        if (isProjectAutosaveRunning) {
            return false;
        }

        isProjectAutosaveRunning = true;

        try {
            if (!await ensureBoardAvailable()) {
                return false;
            }
            const appContext = getAppContext();
            const board = appContext.board;

            if (forceExport) {
                showSaveStatus('saving', t('status.exporting'), 0);
                let payload = null;
                try {
                    payload = await saveCurrentProject(board, {
                        notify,
                        forcePrompt: forceExport
                    });
                } catch {
                    showSaveStatus('error', t('status.exportCancelled'), 1800);
                    return false;
                }
                if (!payload) {
                    showSaveStatus('error', t('status.exportCancelled'), 1800);
                    return false;
                }

                projectStatusState.lastSavedAt = Date.now();
                projectStatusState.lastMode = 'Local project export';
                recordRecentProjectEntry({
                    projectId: appContext.currentProjectId || ensureRuntimeProjectId(localStorage),
                    projectName: appContext.currentBook?.name || 'workspace',
                    directoryName: appContext.currentProjectDirectoryHandle?.name || null,
                    savedAt: projectStatusState.lastSavedAt,
                    lastOpenedAt: Date.now(),
                    source: 'project-folder'
                });
                showSaveStatus('success', t('status.exported'));
                return true;
            }

            showSaveStatus('saving', t('status.savingSnapshot'), 0);
            const saved = await persistRuntimeProjectSnapshot({ note: snapshotNote || t('history.autoNote') });
            if (saved) {
                projectStatusState.lastSavedAt = Date.now();
                projectStatusState.lastMode = 'Server workspace';
                showSaveStatus('success', t('status.snapshotSaved', { time: formatAutosaveTime(projectStatusState.lastSavedAt) }));

                if (notify) {
                    emitAppNotification({
                        title: t('notify.serverSaved.title'),
                        message: t('notify.serverSaved.message'),
                        level: 'success'
                    });
                }
            }

            return saved;
        } finally {
            isProjectAutosaveRunning = false;
        }
    }

    function applyProjectAutosavePrefs(partialPrefs) {
        Object.assign(projectStatusState, partialPrefs);
        saveProjectAutosavePrefs(projectStatusState, localStorage);
        restartProjectAutosave();
    }

    async function promptOpenProject() {
        if (!await ensureBoardAvailable()) {
            emitAppNotification({
                title: t('notify.openNotReady.title'),
                message: t('notify.openNotReady.message'),
                level: 'warning'
            });
            return;
        }
        const openProject = getAppContext().openProjectFile;
        if (typeof openProject === 'function') {
            try {
                await openProject();
                const projectId = getAppContext().currentProjectId || ensureRuntimeProjectId(localStorage);
                setAppService('currentProjectId', projectId);
                setRuntimeProjectId(projectId, localStorage);
                projectStatusState.lastMode = 'Server workspace';
                recordRecentProjectEntry({
                    projectId,
                    projectName: getAppContext().currentBook?.name || 'workspace',
                    directoryName: getAppContext().currentProjectDirectoryHandle?.name || null,
                    savedAt: Date.now(),
                    lastOpenedAt: Date.now(),
                    source: 'project-folder'
                });
                void performProjectAutosave({ notify: false });
            } catch (error) {
                logger.warn('Open project folder failed', error);
            }
            return;
        }

        emitAppNotification({
            title: t('notify.openNotReady.title'),
            message: t('notify.openNotReady.message'),
            level: 'warning'
        });
    }

    async function createProjectSnapshot() {
        if (!await ensureBoardAvailable()) {
            emitAppNotification({
                title: t('notify.snapshotNotReady.title'),
                message: t('notify.snapshotNotReady.message'),
                level: 'warning'
            });
            return false;
        }
        const board = getAppContext().board;
        if (!board) {
            emitAppNotification({
                title: t('notify.snapshotNotReady.title'),
                message: t('notify.snapshotNotReady.message'),
                level: 'warning'
            });
            return false;
        }

        const note = await modalManager.prompt({
            title: t('history.saveTitle'),
            message: t('history.saveMessage'),
            placeholder: t('history.savePlaceholder'),
            confirmLabel: t('history.saveConfirm')
        });
        if (note === null) {
            return false;
        }

        const saved = await performProjectAutosave({ notify: true, snapshotNote: note || t('history.manualNote') });
        return Boolean(saved);
    }

    async function promptSaveProject() {
        if (!await ensureBoardAvailable()) {
            emitAppNotification({
                title: t('notify.openNotReady.title'),
                message: t('notify.openNotReady.message'),
                level: 'warning'
            });
            return;
        }
        const board = getAppContext().board;
        if (board) {
            let payload = null;
            try {
                payload = await saveCurrentProject(board);
            } catch (error) {
                logger.warn('Save project folder failed', error);
                return;
            }
            if (!payload) {
                return;
            }

            const savedAt = Date.now();
            projectStatusState.lastSavedAt = savedAt;
            projectStatusState.lastMode = 'Local project export';
            recordRecentProjectEntry({
                projectId: getAppContext().currentProjectId || ensureRuntimeProjectId(localStorage),
                projectName: getAppContext().currentBook?.name || 'workspace',
                directoryName: getAppContext().currentProjectDirectoryHandle?.name || null,
                savedAt,
                lastOpenedAt: savedAt,
                source: 'project-folder'
            });

            try {
                const runtimeSaved = await persistRuntimeProjectSnapshot({ note: t('history.savedProjectNote') });
                if (!runtimeSaved) {
                    showSaveStatus('error', t('status.savePartial'), 2800);
                    return;
                }
            } catch (error) {
                logger.warn('Runtime snapshot sync after project save failed', error);
                showSaveStatus('error', t('status.savePartial'), 2800);
                return;
            }

            projectStatusState.lastSavedAt = Date.now();
            showSaveStatus('success', t('status.savedAndRecovered'));
            return;
        }

        emitAppNotification({
            title: t('notify.saveNotReady.title'),
            message: t('notify.saveNotReady.message'),
            level: 'warning'
        });
    }

    function handleProjectSaveCompleted(event) {
        projectStatusState.lastSavedAt = event.detail?.savedAt || Date.now();
        projectStatusState.lastMode = event.detail?.mode || projectStatusState.lastMode;
        if (getAppContext().currentProjectId) {
            setRuntimeProjectId(getAppContext().currentProjectId, localStorage);
        }
        recordRecentProjectEntry({
            projectId: event.detail?.projectId || getAppContext().currentProjectId || ensureRuntimeProjectId(localStorage),
            projectName: event.detail?.projectName || getAppContext().currentBook?.name || 'workspace',
            directoryName: event.detail?.directoryName || getAppContext().currentProjectDirectoryHandle?.name || null,
            savedAt: projectStatusState.lastSavedAt,
            lastOpenedAt: Date.now(),
            source: event.detail?.source || 'project-folder'
        });
        showSaveStatus('success', t('status.savedAt', { time: formatAutosaveTime(projectStatusState.lastSavedAt) }));
    }

    function handleProjectOpened(event) {
        projectStatusState.lastMode = event.detail?.mode || projectStatusState.lastMode;
        if (getAppContext().currentProjectId) {
            setRuntimeProjectId(getAppContext().currentProjectId, localStorage);
        }
        recordRecentProjectEntry({
            projectId: event.detail?.projectId || getAppContext().currentProjectId || ensureRuntimeProjectId(localStorage),
            projectName: event.detail?.projectName || getAppContext().currentBook?.name || 'workspace',
            directoryName: event.detail?.directoryName || getAppContext().currentProjectDirectoryHandle?.name || null,
            savedAt: event.detail?.openedAt || Date.now(),
            lastOpenedAt: event.detail?.openedAt || Date.now(),
            source: event.detail?.source || 'project-folder'
        });
        showSaveStatus('success', t('status.opened'), 1800);
    }

    return {
        projectStatusState,
        ensureProjectIdentity,
        continueLatestWorkspace,
        getRecentProjects: () => projectStatusState.recentProjects,
        getProjectStatus,
        openRecentProject,
        promptExportArtifact,
        showSaveStatus,
        restartProjectAutosave,
        restoreRuntimeWorkspace,
        performProjectAutosave,
        createProjectSnapshot,
        applyProjectAutosavePrefs,
        promptOpenProject,
        promptProjectHistory,
        promptSaveProject,
        refreshProjectSnapshotHistory,
        restoreProjectHistorySnapshot,
        handleProjectSaveCompleted,
        handleProjectOpened
    };
}
