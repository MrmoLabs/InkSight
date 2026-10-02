import { BoardTransforms, PlaitBoard } from '@plait/core';
import { ThemeColorMode } from '@plait/core';
import { getAppContext, setAppService } from '../app/app-context.js';
import { emitAppNotification } from '../ui/app-notifications.js';
import { restoreInksightPersistence } from './inksight-file-restore.js';
import { getBaseBookName } from '../core/document-history-helpers.js';
import {
    isAbortError,
    openInksightProjectDirectory,
    saveInksightProjectDirectory
} from './inksight-project-directory-io.js';
import { APP_EVENTS } from '../core/event-names.js';

function summarizePayload(payload) {
    const elements = Array.isArray(payload?.elements) ? payload.elements.length : 0;
    const cards = Array.isArray(payload?.cards) ? payload.cards.length : 0;
    const highlights = Array.isArray(payload?.highlights) ? payload.highlights.length : 0;
    const documents = Array.isArray(payload?.documents) ? payload.documents.length : 0;

    return { elements, cards, highlights, documents };
}

function syncSavedImageCardPaths(appContext, payload) {
    const cardEntries = Array.isArray(payload?.cards) ? payload.cards : [];
    const savedCards = cardEntries.length > 0 && Array.isArray(cardEntries[0])
        ? cardEntries.map(([, card]) => card)
        : cardEntries;

    const savedPathByCardId = new Map(
        savedCards
            .filter((card) => card?.type === 'image' && typeof card.projectAssetPath === 'string')
            .map((card) => [card.id, card.projectAssetPath])
    );

    if (!savedPathByCardId.size || !(appContext.cardSystem?.cards instanceof Map)) {
        return;
    }

    for (const [cardId, assetPath] of savedPathByCardId.entries()) {
        const card = appContext.cardSystem.cards.get(cardId);
        if (card) {
            card.projectAssetPath = assetPath;
        }
    }
}

export async function saveCurrentProject(board, options = {}) {
    const appContext = getAppContext();
    const fileName = getBaseBookName(appContext.currentBook?.name) || undefined;
    const projectFiles = appContext.getProjectFiles?.() ?? [];
    const {
        notify = true,
        forcePrompt = false,
        ...saveOptions
    } = options;
    let result = null;

    try {
        result = await saveInksightProjectDirectory({
            board,
            appContext,
            projectFiles,
            name: fileName,
            directoryHandle: forcePrompt ? null : appContext.currentProjectDirectoryHandle,
            projectMetadata: {
                projectId: appContext.currentProjectId || null
            },
            ...saveOptions
        });
        setAppService('currentProjectDirectoryHandle', result.directoryHandle);
        if (result.projectMetadata?.projectId) {
            setAppService('currentProjectId', result.projectMetadata.projectId);
        }
    } catch (error) {
        if (isAbortError(error)) {
            return null;
        }

        emitAppNotification({
            title: 'Project Folder Save Failed',
            message: error?.message || 'Saving this project requires a writable project folder.',
            level: 'error'
        });
        throw error;
    }

    const payload = result?.payload;

    if (!payload) {
        return null;
    }

    syncSavedImageCardPaths(appContext, payload);

    const summary = summarizePayload(payload);
    if (notify) {
        emitAppNotification({
            title: 'Project Folder Saved',
            message: `Saved ${summary.elements} board items, ${summary.cards} cards, ${summary.highlights} highlights, ${summary.documents} document references, and bundled ${projectFiles.length} source files into the project folder.`,
            level: 'success'
        });
    }

    window.dispatchEvent(new CustomEvent(APP_EVENTS.PROJECT_SAVE_COMPLETED, {
        detail: {
            savedAt: Date.now(),
            mode: 'Local project export',
            projectId: appContext.currentProjectId || null,
            projectName: appContext.currentBook?.name || fileName || 'workspace',
            directoryName: result.directoryHandle?.name || appContext.currentProjectDirectoryHandle?.name || null,
            source: 'project-folder'
        }
    }));

    return payload;
}

export async function openProjectFile(board, listRender = null) {
    const appContext = getAppContext();
    let data = null;
    let projectFiles = [];
    let projectDirectoryHandle = null;
    let projectCleanup = null;

    try {
        const directoryProject = await openInksightProjectDirectory();
        data = directoryProject.payload;
        projectFiles = directoryProject.projectFiles;
        projectDirectoryHandle = directoryProject.directoryHandle;
        projectCleanup = directoryProject.cleanup;
        setAppService('currentProjectDirectoryHandle', projectDirectoryHandle);
        if (directoryProject.projectMetadata?.projectId) {
            setAppService('currentProjectId', directoryProject.projectMetadata.projectId);
        } else {
            setAppService('currentProjectId', null);
        }
    } catch (error) {
        if (isAbortError(error)) {
            return null;
        }

        emitAppNotification({
            title: 'Project Folder Open Failed',
            message: error?.message || 'Opening a project requires selecting a valid project folder.',
            level: 'error'
        });
        throw error;
    }

    appContext.currentProjectCleanup?.();
    setAppService('currentProjectCleanup', projectCleanup);

    if (listRender?.update) {
        board.children = data.elements;
        board.viewport = data.viewport || { zoom: 1 };
        board.theme = data.theme || { themeColorMode: ThemeColorMode.default };
        listRender.update(board.children, {
            board,
            parent: board,
            parentG: PlaitBoard.getElementHost(board),
        });
        BoardTransforms.fitViewport(board);
        board.history.undos = [];
        board.history.redos = [];
    } else {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.RESTORE_BOARD_STATE, {
            detail: {
                elements: data.elements,
                viewport: data.viewport,
                theme: data.theme || { themeColorMode: ThemeColorMode.default }
            }
        }));
    }

    restoreInksightPersistence(data, getAppContext(), {
        onBookMismatch: ({ bookName }) => {
            emitAppNotification({
                title: 'Book Mismatch',
                message: `This mind map was saved for a different book (${bookName}). Nodes might not link correctly until the original source files are relinked.`,
                level: 'warning',
            });
        }
    });

    setAppService('workspaceSnapshotRestored', true);

    if (projectFiles.length) {
        await appContext.hydrateProjectFiles?.(projectFiles, {
            openCurrentBookId: data.bookId || null
        });
    }

    const summary = summarizePayload(data);
    emitAppNotification({
        title: 'Project Folder Opened',
        message: `Loaded ${summary.elements} board items, ${summary.cards} cards, ${summary.highlights} highlights, ${summary.documents} document references, and restored ${projectFiles.length} bundled source files from the project folder.`,
        level: 'success',
        actions: [
            { label: 'Validate', onClick: () => window.dispatchEvent(new CustomEvent(APP_EVENTS.RECOVERY_VALIDATE_REQUESTED)) }
        ]
    });

    window.dispatchEvent(new CustomEvent(APP_EVENTS.PROJECT_OPENED, {
        detail: {
            openedAt: Date.now(),
            mode: 'Local project export',
            projectId: getAppContext().currentProjectId || null,
            projectName: getAppContext().currentBook?.name || projectDirectoryHandle?.name || 'workspace',
            directoryName: projectDirectoryHandle?.name || null,
            source: 'project-folder'
        }
    }));

    return data;
}
