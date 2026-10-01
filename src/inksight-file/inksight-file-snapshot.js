import { sanitizeViewport } from '../mindmap/viewport-state.js';
import { graphNodesStore } from '../mindmap/graph-view/graph-nodes-store.js';
import { DRAWNIX_FILE_VERSION, isInksightPayload } from './inksight-file-types.js';

export function buildInksightPersistenceSnapshot(appContext = {}) {
    const snapshot = {};

    if (appContext.currentBook?.md5) {
        snapshot.bookMd5 = appContext.currentBook.md5;
        snapshot.bookName = appContext.currentBook.name;
        snapshot.bookId = appContext.currentBook.id;
    }

    if (appContext.cardSystem?.getPersistenceData) {
        const persistenceData = appContext.cardSystem.getPersistenceData();
        snapshot.cards = persistenceData.cards;
        snapshot.connections = persistenceData.connections;
    }

    if (appContext.highlightManager?.getPersistenceData) {
        const highlightData = appContext.highlightManager.getPersistenceData();
        snapshot.highlights = highlightData.highlights;
    }

    if (appContext.documentManager?.getPersistenceData) {
        const documentData = appContext.documentManager.getPersistenceData();
        snapshot.documents = documentData.documents;
    }

    if (graphNodesStore.hasData()) {
        snapshot.graphNodes = graphNodesStore.getPersistenceData();
    }

    return snapshot;
}

export function buildInksightFilePayload({ appContext = {}, board, lastPage } = {}) {
    const payload = {
        type: 'drawnix',
        version: DRAWNIX_FILE_VERSION,
        source: 'web',
        elements: board?.children || [],
        viewport: sanitizeViewport(board?.viewport) || { zoom: 1 },
        theme: board?.theme,
        ...buildInksightPersistenceSnapshot(appContext),
        ...(lastPage ? { lastPage } : {})
    };

    if (!isInksightPayload(payload)) {
        throw new Error('Invalid InkSight file payload');
    }

    return payload;
}
