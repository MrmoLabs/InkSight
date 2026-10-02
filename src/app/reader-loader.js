import { getAppContext, setAppService } from './app-context.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ReaderLoader');

export function createReaderLoader({
    elements,
    state,
    getOutlineSidebar,
    documentHistoryManager,
    resetAuxiliaryPanels,
    setToolMode,
    updatePageInfo
}) {
    const resolveOutlineSidebar = () => getOutlineSidebar?.() ?? null;

    const showViewerMessage = (className, message) => {
        const messageElement = document.createElement('div');
        messageElement.className = className;
        messageElement.textContent = message;
        elements.viewer.replaceChildren(messageElement);
    };

    const setPageInfo = (page, totalPages = state.totalPages) => {
        const normalizedTotalPages = Number.isFinite(totalPages) && totalPages > 0
            ? totalPages
            : 0;
        const normalizedPage = Number.isFinite(page) && page > 0
            ? page
            : normalizedTotalPages > 0
                ? Math.min(Math.max(state.currentPage || 1, 1), normalizedTotalPages)
                : (state.currentPage > 0 ? state.currentPage : 1);

        state.currentPage = normalizedPage;
        state.totalPages = normalizedTotalPages;
        updatePageInfo?.();
    };

    const enablePaging = () => {
        elements.prevBtn.disabled = false;
        elements.nextBtn.disabled = false;
    };

    const readerTypeConfigs = [
        {
            matches: (fileData) => fileData.type === 'application/pdf',
            loadingText: 'Loading PDF...',
            errorLabel: 'PDF',
            loadReaderModule: async () => {
                const { PDFReader } = await import('../readers/pdf-reader.js');
                return PDFReader;
            },
            defaultMode: 'pan',
            beforeLoad: () => {
                resolveOutlineSidebar()?.reset();
            },
            configureReader: (reader) => {
                setAppService('pdfReader', reader);
                reader.setPageCountCallback((count) => {
                    setPageInfo(state.currentPage, count);
                });
                reader.setPageChangeCallback((page) => {
                    setPageInfo(page);
                    if (getAppContext().currentBook?.md5) {
                        documentHistoryManager.updatePage(getAppContext().currentBook.md5, page);
                    }
                });
            },
            load: async (reader, fileData) => {
                const md5 = getAppContext().currentBook.md5;
                const startPage = md5
                    ? documentHistoryManager.getHistory(md5)?.lastPage || 1
                    : 1;

                await reader.load(fileData, startPage);
                enablePaging();
                resolveOutlineSidebar()?.render(reader.getOutline(), reader.pdfDoc);

                if (md5) {
                    await documentHistoryManager.restoreState(md5, {
                        restoreWorkspaceData: !getAppContext().workspaceSnapshotRestored
                    });
                    documentHistoryManager.startAutoSave(md5, fileData.name.replace(/\.[^/.]+$/, ''));
                }
            }
        },
        {
            matches: (fileData) => fileData.type === 'application/epub+zip'
                || fileData.type === 'application/epub'
                || fileData.name.toLowerCase().endsWith('.epub'),
            loadingText: 'Loading EPUB...',
            errorLabel: 'EPUB',
            loadReaderModule: async () => {
                const { EpubReader } = await import('../readers/epub-reader.js');
                return EpubReader;
            },
            defaultMode: 'text',
            beforeLoad: () => {
                resolveOutlineSidebar()?.reset();
                setAppService('pdfReader', null);
            },
            configureReader: (reader) => {
                reader.setPageCountCallback((count) => {
                    setPageInfo(state.currentPage, count);
                });
                reader.setPageChangeCallback((location) => {
                    setPageInfo(location?.start?.location);
                    if (getAppContext().currentBook?.md5) {
                        documentHistoryManager.updateLocation(getAppContext().currentBook.md5, reader.getCurrentLocation?.() || location?.start || {});
                    }
                });
            },
            load: async (reader, fileData) => {
                await reader.load(fileData);
                enablePaging();
                const history = documentHistoryManager.getHistory(fileData.id);
                if (history?.lastLocation) {
                    reader.goToLocation(history.lastLocation);
                }
            }
        },
        {
            matches: (fileData) => fileData.type === 'text/plain'
                || fileData.type === 'text/markdown'
                || fileData.name.toLowerCase().endsWith('.md')
                || fileData.name.toLowerCase().endsWith('.txt'),
            loadingText: 'Loading Text...',
            errorLabel: 'Text',
            loadReaderModule: async () => {
                const { TextReader } = await import('../readers/text-reader.js');
                return TextReader;
            },
            defaultMode: 'text',
            beforeLoad: () => {
                resolveOutlineSidebar()?.reset();
                setAppService('pdfReader', null);
            },
            configureReader: (reader) => {
                reader.setPageCountCallback((count) => {
                    setPageInfo(state.currentPage, count);
                });
                reader.setPageChangeCallback((page) => {
                    setPageInfo(page);
                });
                reader.setScrollChangeCallback?.((scrollTop) => {
                    if (getAppContext().currentBook?.md5) {
                        documentHistoryManager.updateScroll(getAppContext().currentBook.md5, scrollTop);
                    }
                });
            },
            load: async (reader, fileData) => {
                await reader.load(fileData);
                enablePaging();
                const history = documentHistoryManager.getHistory(fileData.id);
                if (history?.lastScrollTop || history?.lastLocation) {
                    reader.goToLocation({
                        ...(history.lastLocation || {}),
                        scrollTop: history.lastScrollTop || 0
                    });
                }
            }
        }
    ];

    const getReaderTypeConfig = (fileData) => readerTypeConfigs.find((config) => config.matches(fileData)) ?? null;

    const loadReaderForFile = async (fileData) => {
        const config = getReaderTypeConfig(fileData);

        if (!config) {
            resetAuxiliaryPanels();
            showViewerMessage('error', `Unsupported file type: ${fileData.type}`);
            setAppService('pdfReader', null);
            return null;
        }

        config.beforeLoad?.();
        resetAuxiliaryPanels();
        showViewerMessage('loading', config.loadingText);

        const ReaderClass = await config.loadReaderModule();
        const reader = new ReaderClass(elements.viewer);
        config.configureReader?.(reader);

        try {
            await config.load(reader, fileData);
            setToolMode?.(config.defaultMode);
            return reader;
        } catch (e) {
            showViewerMessage('error', `Error loading ${config.errorLabel}: ${e.message}`);
            logger.error(`Error loading ${config.errorLabel}`, e);
            return reader;
        }
    };

    return {
        getReaderTypeConfig,
        loadReaderForFile
    };
}
