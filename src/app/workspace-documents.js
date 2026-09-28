import { emitAppNotification } from '../ui/app-notifications.js';
import { modalManager } from '../ui/modal-manager.js';
import { t } from '../i18n/index.js';
import { getAppContext, setAppService, updateCurrentBook } from './app-context.js';
import { chooseDocumentTarget } from './document-relink.js';
import { buildDocumentRemovalPrompt, reorderFilesById } from './file-list-helpers.js';
import { resolveImportDecision } from './import-decision.js';

async function generateHash(message, logger) {
    if (window.crypto && window.crypto.subtle) {
        try {
            const msgBuffer = new TextEncoder().encode(message);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
            return hashHex.substring(0, 32);
        } catch (error) {
            logger?.warn?.('Crypto API failed, falling back', error);
        }
    }

    let hash = 5381;
    for (let i = 0; i < message.length; i++) {
        hash = ((hash << 5) + hash) + message.charCodeAt(i);
    }

    const hashHex = (hash >>> 0).toString(16).padStart(8, '0');
    const suffix = message.length.toString(16) + (message.charCodeAt(0) || 0).toString(16);
    return (hashHex + suffix).padEnd(32, '0').substring(0, 32);
}

export function createWorkspaceDocumentsController({
    logger,
    projectWorkspace,
    getDocumentReferenceDetails,
    workspace,
    readers,
    ui
}) {
    function destroyCurrentReader() {
        const currentReader = readers.getCurrentReader();
        if (currentReader?.destroy) {
            currentReader.destroy();
        }
        readers.setCurrentReader(null);
        setAppService('pdfReader', null);
    }

    function resetReadingState() {
        workspace.state.currentPage = 1;
        workspace.state.totalPages = 0;
        ui.updatePageInfo();
    }

    function clearLoadedFiles() {
        destroyCurrentReader();
        resetReadingState();
        readers.documentHistoryManager.stopAutoSave();
        workspace.state.files = [];
        workspace.state.currentFile = null;
        workspace.elements.viewer.innerHTML = '';
        updateCurrentBook({
            md5: null,
            id: null,
            name: null
        });
        ui.updateToolbarSummary();
        ui.renderProjectHome?.();
    }

    async function openFile(fileData) {
        destroyCurrentReader();
        resetReadingState();
        readers.documentHistoryManager.stopAutoSave();

        workspace.state.currentFile = fileData;
        ui.updateToolbarSummary();

        updateCurrentBook({
            md5: fileData.id,
            id: fileData.id,
            name: fileData.name
        });

        ui.renderFileList();
        workspace.elements.viewer.innerHTML = '';

        const appContext = getAppContext();
        appContext.documentManager?.registerDocument(
            fileData.id,
            fileData.name,
            fileData.type,
            true
        );

        appContext.cardSystem?.updateSourceNames?.(fileData.id, fileData.name);
        appContext.highlightManager?.updateSourceNames?.(fileData.id, fileData.name);
        appContext.annotationList?.load?.(fileData.id);

        const nextReader = await readers.readerLoader.loadReaderForFile(fileData);
        readers.setCurrentReader(nextReader);

        ui.updateToolAvailability(fileData.type);
        ui.setWorkspaceMode('reading', { force: true });
        ui.renderFileList();
    }

    async function importSingleFile(file, { pendingDocumentImport, reservedIds, importedFileData }) {
        const appContext = getAppContext();
        const decision = resolveImportDecision({
            file,
            pendingDocumentImport,
            documentManager: appContext.documentManager,
            currentFiles: workspace.state.files
        });
        const targetDocument = decision.mode === 'new'
            ? null
            : decision.targetDocumentId
                ? appContext.documentManager?.getDocumentInfo?.(decision.targetDocumentId) ?? chooseDocumentTarget({
                    file,
                    pendingDocumentImport: { id: decision.targetDocumentId, type: file.type },
                    documentManager: appContext.documentManager,
                    reservedIds
                })
                : null;

        if ((pendingDocumentImport?.id || decision.mode === 'relink-only') && !targetDocument) {
            const relinkTargetName = pendingDocumentImport?.name || file.name;
            emitAppNotification({
                title: t('notify.relinkSkipped.title'),
                message: t('notify.relinkSkipped.message', { name: file.name, target: relinkTargetName }),
                level: 'warning'
            });
            return null;
        }

        const fileSignature = `${file.name}-${file.size}-${file.lastModified}`;
        const fileId = targetDocument?.id || await generateHash(fileSignature, logger);

        if (targetDocument?.id) {
            reservedIds.add(targetDocument.id);
        }

        const fileData = {
            id: fileId,
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
            fileObj: file,
            restoredDocumentId: targetDocument?.id || null,
            importMode: decision.mode
        };

        const existingIndex = workspace.state.files.findIndex((item) => item.id === fileId);
        if (existingIndex >= 0) {
            workspace.state.files[existingIndex] = fileData;
        } else {
            workspace.state.files.push(fileData);
        }

        appContext.documentManager?.registerDocument(
            fileId,
            file.name,
            file.type,
            true
        );

        appContext.cardSystem?.updateSourceNames?.(fileId, file.name);
        appContext.highlightManager?.updateSourceNames?.(fileId, file.name);
        importedFileData.push(fileData);
        if (decision.mode === 'replace') {
            emitAppNotification({
                title: t('notify.documentReplaced.title'),
                message: t('notify.documentReplaced.message', { name: file.name }),
                level: 'success'
            });
        } else if (decision.mode === 'relink-only') {
            emitAppNotification({
                title: t('notify.sourceRelinked.title'),
                message: t('notify.sourceRelinked.message', { name: file.name }),
                level: 'success'
            });
        }

        if (pendingDocumentImport?.id || decision.mode === 'relink-only') {
            return null;
        }
        return fileData;
    }

    async function importFiles(files, { openImportedFile = true } = {}) {
        const appContext = getAppContext();
        if (!appContext.currentProjectId) {
            projectWorkspace.ensureProjectIdentity();
        }

        const pendingDocumentImport = appContext.pendingDocumentImport;
        const reservedIds = new Set();
        const importedFileData = [];

        for (const file of files) {
            let fileData;
            try {
                fileData = await importSingleFile(file, { pendingDocumentImport, reservedIds, importedFileData });
            } catch (error) {
                logger?.warn?.('[workspace-documents] Failed to import file:', file?.name, error);
                emitAppNotification({
                    title: t('notify.importFailed.title'),
                    message: t('notify.importFailed.message', { name: file?.name || 'Unknown file' }),
                    level: 'error'
                });
                continue;
            }
            if (!fileData) {
                break;
            }
        }

        setAppService('pendingDocumentImport', null);
        ui.renderFileList();

        if (!importedFileData.length) {
            return [];
        }

        if (openImportedFile) {
            try {
                await openFile(importedFileData[0]);
            } catch (error) {
                logger?.warn?.('[workspace-documents] Failed to open imported file:', importedFileData[0]?.name, error);
                emitAppNotification({
                    title: t('notify.openFailed.title'),
                    message: t('notify.openFailed.message', { name: importedFileData[0]?.name || 'Document' }),
                    level: 'error'
                });
            }
        }

        void projectWorkspace.performProjectAutosave({ notify: false });
        return importedFileData;
    }

    async function handleFileSelect(event) {
        const files = Array.from(event.target.files || []);
        if (!files.length) {
            return;
        }

        const pendingDocumentImport = getAppContext().pendingDocumentImport;
        const openImportedFile = !(pendingDocumentImport?.mode === 'bulk' || files.length > 1);
        await importFiles(files, { openImportedFile });
        workspace.elements.fileInput.value = '';
    }

    function openFileById(id, { onMissingDocument } = {}) {
        const file = workspace.state.files.find((item) => item.id === id);
        if (file) {
            void openFile(file);
            return;
        }

        const missingDocument = getAppContext().documentManager?.getDocumentInfo?.(id);
        if (missingDocument && !missingDocument.loaded) {
            onMissingDocument?.(id);
        }
    }

    async function moveFileByOffset(fileId, offset) {
        const currentIndex = workspace.state.files.findIndex((file) => file.id === fileId);
        if (currentIndex < 0) {
            return;
        }

        const targetIndex = currentIndex + offset;
        if (targetIndex < 0 || targetIndex >= workspace.state.files.length) {
            return;
        }

        const [file] = workspace.state.files.splice(currentIndex, 1);
        workspace.state.files.splice(targetIndex, 0, file);
        ui.renderFileList();
    }

    function moveFileToIndex(fileId, targetIndex) {
        workspace.state.files = reorderFilesById(workspace.state.files, fileId, targetIndex);
        ui.renderFileList();
    }

    async function removeFileFromWorkspace(fileId) {
        const fileIndex = workspace.state.files.findIndex((file) => file.id === fileId);
        if (fileIndex < 0) {
            return;
        }

        const fileToRemove = workspace.state.files[fileIndex];
        const appContext = getAppContext();
        const { cardCount, highlightCount, referenceCount } = getDocumentReferenceDetails(fileId);
        const isCurrentDocument = appContext.currentBook?.id === fileId;
        const confirmed = await modalManager.confirm({
            title: t('docs.removeTitle'),
            message: buildDocumentRemovalPrompt({ name: fileToRemove.name, cardCount, highlightCount, isCurrentDocument }),
            confirmLabel: t('common.remove'),
            danger: true
        });

        if (!confirmed) {
            return;
        }

        const [removedFile] = workspace.state.files.splice(fileIndex, 1);

        // Always unregister so the library list drops the entry immediately.
        // Keeping it registered would render an undeletable "Missing" ghost
        // item; linked cards/highlights stay intact and show as missing links.
        appContext.documentManager?.unregisterDocument?.(fileId);

        if (workspace.state.currentFile?.id === fileId) {
            const fallbackFile = workspace.state.files[fileIndex] || workspace.state.files[fileIndex - 1] || null;
            if (fallbackFile) {
                await openFile(fallbackFile);
            } else {
                clearLoadedFiles();
                ui.renderFileList();
            }
        } else {
            ui.renderFileList();
        }

        emitAppNotification({
            title: t('notify.documentRemoved.title'),
            message: referenceCount > 0
                ? t('notify.documentRemoved.linked', { name: removedFile.name })
                : t('notify.documentRemoved.simple', { name: removedFile.name }),
            level: 'success'
        });
    }

    async function hydrateProjectFiles(projectFiles = [], { openCurrentBookId = null } = {}) {
        clearLoadedFiles();

        if (!Array.isArray(projectFiles) || !projectFiles.length) {
            renderFileList();
            return [];
        }

        const appContext = getAppContext();
        workspace.state.files = projectFiles.map((file) => ({
            ...file,
            restoredDocumentId: file.id
        }));

        workspace.state.files.forEach((file) => {
            appContext.documentManager?.registerDocument(file.id, file.name, file.type, true);
        });

        ui.renderFileList();

        const initialFile = workspace.state.files.find((file) => file.id === openCurrentBookId) || workspace.state.files[0];
        if (initialFile) {
            await openFile(initialFile);
        }

        return workspace.state.files;
    }

    return {
        clearLoadedFiles,
        destroyCurrentReader,
        handleFileSelect,
        hydrateProjectFiles,
        importFiles,
        moveFileByOffset,
        moveFileToIndex,
        openFile,
        openFileById,
        removeFileFromWorkspace,
        resetReadingState
    };
}
