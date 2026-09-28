import { t } from '../i18n/index.js';

export function reorderFilesById(files = [], fileId, targetIndex) {
    const currentIndex = files.findIndex((file) => file.id === fileId);
    if (currentIndex < 0) {
        return files.slice();
    }

    const boundedIndex = Math.max(0, Math.min(targetIndex, files.length - 1));
    if (currentIndex === boundedIndex) {
        return files.slice();
    }

    const nextFiles = files.slice();
    const [movedFile] = nextFiles.splice(currentIndex, 1);
    nextFiles.splice(boundedIndex, 0, movedFile);
    return nextFiles;
}

export function buildDocumentRemovalPrompt({
    name,
    cardCount = 0,
    highlightCount = 0,
    isCurrentDocument = false
} = {}) {
    const referenceCount = cardCount + highlightCount;

    if (referenceCount <= 0 && !isCurrentDocument) {
        return t('docs.removeSimple', { name });
    }

    const details = [];
    if (cardCount > 0) {
        details.push(t(cardCount === 1 ? 'docs.linkedCards.one' : 'docs.linkedCards.other', { count: cardCount }));
    }
    if (highlightCount > 0) {
        details.push(t(highlightCount === 1 ? 'docs.linkedHighlights.one' : 'docs.linkedHighlights.other', { count: highlightCount }));
    }
    if (isCurrentDocument) {
        details.push(t('docs.currentDoc'));
    }

    return t('docs.removeDetail', { name, details: details.join(', ') });
}
