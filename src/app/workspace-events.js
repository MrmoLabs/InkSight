import { handleRecoveryPanelClick } from './recovery-panel-actions.js';
import { getAppContext } from './app-context.js';
import { emitAppNotification } from '../ui/app-notifications.js';
import { APP_EVENTS } from '../core/event-names.js';
import { t } from '../i18n/index.js';

export function createWorkspaceEventListeners({
    elements,
    windowTarget = window,
    projectWorkspace,
    workspaceDocuments,
    ui,
    navigation,
    dragState
}) {
    return [
        { target: elements.fileInput, event: 'change', handler: workspaceDocuments.handleFileSelect },
        { target: elements.toolbarImportDocumentsBtn, event: 'click', handler: ui.promptImportDocument },
        { target: elements.toolbarOpenProjectBtn, event: 'click', handler: () => void projectWorkspace.promptOpenProject() },
        { target: elements.toolbarSaveProjectBtn, event: 'click', handler: () => void projectWorkspace.promptSaveProject() },
        { target: elements.toolbarExportOutlineBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('outline') },
        { target: elements.toolbarExportCitationsBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('citations') },
        { target: elements.toolbarExportNotesBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('notes-package') },
        { target: elements.mobileImportDocumentsBtn, event: 'click', handler: ui.promptImportDocument },
        { target: elements.mobileOpenProjectBtn, event: 'click', handler: () => void projectWorkspace.promptOpenProject() },
        { target: elements.mobileSaveProjectBtn, event: 'click', handler: () => void projectWorkspace.promptSaveProject() },
        { target: elements.mobileExportOutlineBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('outline') },
        { target: elements.mobileExportCitationsBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('citations') },
        { target: elements.mobileExportNotesBtn, event: 'click', handler: () => projectWorkspace.promptExportArtifact('notes-package') },
        { target: elements.prevBtn, event: 'click', handler: () => navigation.getCurrentReader()?.onPrevPage() },
        { target: elements.nextBtn, event: 'click', handler: () => navigation.getCurrentReader()?.onNextPage() },
        { target: elements.mobilePrevBtn, event: 'click', handler: () => navigation.getCurrentReader()?.onPrevPage() },
        { target: elements.mobileNextBtn, event: 'click', handler: () => navigation.getCurrentReader()?.onNextPage() },
        {
            target: windowTarget,
            event: APP_EVENTS.ADD_CARD_TO_BOARD,
            handler: () => ui.setWorkspaceMode('map')
        },
        {
            target: windowTarget,
            event: APP_EVENTS.PROJECT_SAVE_REQUESTED,
            handler: () => void projectWorkspace.promptSaveProject()
        },
        {
            target: windowTarget,
            event: APP_EVENTS.OPEN_GRAPH_VIEW,
            handler: async (e) => {
                const cardId = e.detail?.cardId;
                if (!cardId) {
                    return;
                }

                // 未上板的标注也可以展开图谱（单根视图，子节点来自图谱内创建）
                const cardExists = getAppContext()?.cardSystem?.cards?.has?.(cardId);
                if (!cardExists) {
                    emitAppNotification({ message: t('workspace.annotationMissing'), level: 'warning' });
                    return;
                }

                // The graph overlay lives inside the mind-map pane. Force that
                // pane to full width so compact/split layouts cannot collapse
                // the interactive viewport to zero pixels.
                ui.setWorkspaceMode('map', { force: true, notesView: 'mindmap' });
                const { openGraphView } = await import('../mindmap/graph-view/graph-view.js');
                openGraphView({ rootCardId: cardId });
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.DOCUMENT_REGISTERED,
            handler: () => {
                ui.attemptAutoRelinkRecoveredDocuments();
                ui.renderFileList();
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.DOCUMENT_LOADED_CHANGED,
            handler: () => {
                ui.attemptAutoRelinkRecoveredDocuments();
                ui.renderFileList();
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.DOCUMENTS_RESTORED,
            handler: () => {
                // 恢复会把所有注册降级为未加载——先用文件库对账，
                // 否则还在项目里的文件会被误判为 missing link
                ui.reconcileDocumentRegistrations?.();
                ui.attemptAutoRelinkRecoveredDocuments();
                ui.renderFileList();
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.RECOVERY_VALIDATE_REQUESTED,
            handler: () => {
                ui.showRecoveryValidation();
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.PROJECT_SAVE_COMPLETED,
            handler: (event) => projectWorkspace.handleProjectSaveCompleted(event)
        },
        {
            target: windowTarget,
            event: APP_EVENTS.PROJECT_OPENED,
            handler: (event) => projectWorkspace.handleProjectOpened(event)
        },
        {
            target: elements.viewer,
            event: 'click',
            handler: (event) => {
                const homeActionButton = event.target.closest('[data-home-action]');
                if (homeActionButton) {
                    const action = homeActionButton.getAttribute('data-home-action');
                    if (action === 'continue-workspace') {
                        void projectWorkspace.continueLatestWorkspace();
                    } else if (action === 'import') {
                        ui.promptImportDocument();
                    } else if (action === 'open-project') {
                        void projectWorkspace.promptOpenProject();
                    } else if (action === 'save-project') {
                        void projectWorkspace.promptSaveProject();
                    } else if (action === 'snapshot') {
                        void projectWorkspace.createProjectSnapshot();
                    } else if (action === 'export-notes') {
                        projectWorkspace.promptExportArtifact('notes-package');
                    }
                    return;
                }

                const recentProjectButton = event.target.closest('[data-recent-project-id]');
                if (recentProjectButton) {
                    const projectId = recentProjectButton.getAttribute('data-recent-project-id');
                    if (projectId) {
                        void projectWorkspace.openRecentProject(projectId);
                    }
                    return;
                }

                const snapshotButton = event.target.closest('[data-home-snapshot-id]');
                if (snapshotButton) {
                    const snapshotId = snapshotButton.getAttribute('data-home-snapshot-id');
                    if (snapshotId) {
                        void projectWorkspace.restoreProjectHistorySnapshot(snapshotId);
                    }
                }
            }
        },
        {
            target: elements.fileList,
            event: 'click',
            handler: (event) => {
                const handled = handleRecoveryPanelClick(event, {
                    onMatchDocument: (documentId) => ui.matchRecoveredDocument(documentId),
                    onRelinkDocument: (documentId) => ui.promptRelinkDocument(documentId),
                    onRecoveryAction: (action) => {
                        if (action === 'auto') {
                            ui.attemptAutoRelinkRecoveredDocuments({ notifyUser: true });
                        }
                        if (action === 'bulk') {
                            ui.promptBulkRelink();
                        }
                        if (action === 'validate') {
                            ui.showRecoveryValidation();
                        }
                    }
                });
                if (handled) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                const actionButton = event.target.closest('[data-file-action]');
                if (actionButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const fileId = actionButton.getAttribute('data-file-id');
                    const action = actionButton.getAttribute('data-file-action');

                    if (!fileId || !action) {
                        return;
                    }

                    if (action === 'move-up') {
                        void workspaceDocuments.moveFileByOffset(fileId, -1);
                    } else if (action === 'move-down') {
                        void workspaceDocuments.moveFileByOffset(fileId, 1);
                    } else if (action === 'remove') {
                        void workspaceDocuments.removeFileFromWorkspace(fileId);
                    }
                    return;
                }

                const projectActionButton = event.target.closest('[data-project-action]');
                if (projectActionButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const action = projectActionButton.getAttribute('data-project-action');

                    if (action === 'snapshot') {
                        void projectWorkspace.createProjectSnapshot();
                    } else if (action === 'open') {
                        void projectWorkspace.promptOpenProject();
                    } else if (action === 'save') {
                        void projectWorkspace.promptSaveProject();
                    } else if (action === 'import') {
                        ui.promptImportDocument();
                    } else if (action === 'history') {
                        void projectWorkspace.promptProjectHistory();
                    }
                    return;
                }

                const historyRestoreButton = event.target.closest('[data-project-history-id]');
                if (historyRestoreButton) {
                    event.preventDefault();
                    event.stopPropagation();
                    const snapshotId = historyRestoreButton.getAttribute('data-project-history-id');
                    if (snapshotId) {
                        void projectWorkspace.restoreProjectHistorySnapshot(snapshotId);
                    }
                    return;
                }

                const fileItem = event.target.closest('[data-open-file-id]');
                if (fileItem) {
                    const fileId = fileItem.getAttribute('data-open-file-id');
                    if (fileId) {
                        workspaceDocuments.openFileById(fileId);
                    }
                }
            }
        },
        {
            target: elements.fileList,
            event: 'dragstart',
            handler: (event) => {
                const item = event.target.closest('[data-open-file-id]');
                if (!item || item.classList.contains('disabled')) {
                    return;
                }

                const draggedFileId = item.getAttribute('data-open-file-id');
                dragState.setDraggedFileId(draggedFileId);
                item.classList.add('dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', draggedFileId || '');
            }
        },
        {
            target: elements.fileList,
            event: 'dragover',
            handler: (event) => {
                const targetItem = event.target.closest('[data-open-file-id]');
                if (!dragState.getDraggedFileId() || !targetItem) {
                    return;
                }

                event.preventDefault();
                const targetFileId = targetItem.getAttribute('data-open-file-id');
                if (!targetFileId || targetFileId === dragState.getDraggedFileId()) {
                    return;
                }

                elements.fileList.querySelectorAll('.file-item.drop-target').forEach((item) => {
                    item.classList.remove('drop-target');
                });
                targetItem.classList.add('drop-target');
                event.dataTransfer.dropEffect = 'move';
            }
        },
        {
            target: elements.fileList,
            event: 'drop',
            handler: (event) => {
                const targetItem = event.target.closest('[data-open-file-id]');
                const draggedFileId = dragState.getDraggedFileId();
                if (!draggedFileId || !targetItem) {
                    return;
                }

                event.preventDefault();
                const targetFileId = targetItem.getAttribute('data-open-file-id');
                if (!targetFileId || targetFileId === draggedFileId) {
                    return;
                }

                const targetIndex = dragState.getFiles().findIndex((file) => file.id === targetFileId);
                if (targetIndex >= 0) {
                    workspaceDocuments.moveFileToIndex(draggedFileId, targetIndex);
                }
            }
        },
        {
            target: elements.fileList,
            event: 'dragend',
            handler: () => {
                dragState.setDraggedFileId(null);
                elements.fileList.querySelectorAll('.file-item.dragging, .file-item.drop-target').forEach((item) => {
                    item.classList.remove('dragging', 'drop-target');
                });
            }
        },
        {
            target: windowTarget,
            event: APP_EVENTS.JUMP_TO_SOURCE,
            handler: (e) => {
                const { sourceId, highlightId } = e.detail;
                navigation.handleJumpToSource(sourceId, highlightId);
                navigation.closeCompactPanels();
            }
        }
    ].filter(({ target }) => target);
}
