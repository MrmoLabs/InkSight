import { t } from '../i18n/index.js';

export async function navigateToLinkedSource({
    sourceId,
    highlightId,
    findHighlightById,
    findFileById,
    openFile,
    getCurrentFile,
    getCurrentReader,
    notify
}) {
    const highlight = findHighlightById?.(highlightId) ?? null;
    const effectiveSourceId = highlight ? highlight.sourceId : sourceId;
    const file = findFileById?.(effectiveSourceId) ?? null;

    if (!file) {
        notify?.({
            message: t('navigation.sourceNotLoaded'),
            level: 'warning'
        });
        return { status: 'missing-file', effectiveSourceId, highlight };
    }

    if (!highlight) {
        notify?.({
            message: t('navigation.highlightMissing'),
            level: 'warning'
        });
        return { status: 'missing-highlight', effectiveSourceId, file };
    }

    const currentFile = getCurrentFile?.() ?? null;
    if (!currentFile || currentFile.id !== effectiveSourceId) {
        await openFile?.(file);
    }

    const reader = getCurrentReader?.();
    if (!reader) {
        return { status: 'no-reader', effectiveSourceId, file, highlight };
    }

    if (typeof reader.scrollToHighlight === 'function') {
        await reader.scrollToHighlight(highlightId);
        if (highlight.needsValidation) {
            notify?.({
                message: t('navigation.needsValidation'),
                level: 'warning'
            });
            return { status: 'needs-validation', effectiveSourceId, file, highlight };
        }
        return { status: 'scrolled-highlight', effectiveSourceId, file, highlight };
    }

    const pageInfo = reader.pages ? reader.pages[highlight.location?.page - 1] : null;
    if (pageInfo?.wrapper) {
        pageInfo.wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (typeof reader.flashHighlight === 'function') {
            setTimeout(() => {
                reader.flashHighlight(highlightId);
            }, 500);
        }
        return { status: 'scrolled-page', effectiveSourceId, file, highlight };
    }

    return { status: 'no-scroll-target', effectiveSourceId, file, highlight };
}
