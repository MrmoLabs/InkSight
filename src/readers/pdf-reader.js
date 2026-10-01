import * as pdfjsLib from 'pdfjs-dist';
import { highlightManager } from '../core/highlight-manager.js';
import { PDFAreaSelector } from './pdf-area-selector.js';
import { PDFHighlightRenderer } from './pdf-highlight-renderer.js';
import { PDFHighlighterTool } from './pdf-highlighter-tool.js';
import { getAppContext, setAppService, updateCurrentBook } from '../app/app-context.js';
import {
    registerPdfReaderGlobalListeners,
    setupPdfPanHandling,
    setupPdfZoomHandling
} from './pdf-reader-events.js';
import {
    applyReaderSelectionMode,
    clearSelectedHighlightState,
    createTouchSelectionScheduler,
    createReaderHighlightToolbar,
    findCardIdByHighlightId,
    handleReaderHighlightClick,
    registerHighlightToolbarDeletionHandler,
    removeHighlightFromStores,
    updateHighlightModelColor
} from './reader-shared.js';
import {
    applyHighlightColorToElements,
    collectSelectionRects,
    createPageWrapper,
    findHighlightById,
    getNearestPageNumber,
    resolveDestinationPageNumber,
    syncDefaultHighlightColor
} from './pdf-reader-utils.js';
import { createLogger } from '../core/logger.js';
import { APP_EVENTS } from '../core/event-names.js';

const logger = createLogger('PDFReader');

// Set worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
).toString();

export class PDFReader {
    // Static default colors - persists across instances (file switches)
    static defaultColors = {
        text: '#FFE234',
        highlighter: 'rgba(255, 226, 52, 0.6)',
        rect: '#FF6B6B',
        ellipse: '#FF6B6B'
    };

    // Static selection mode - persists across instances
    static currentSelectionMode = 'pan';

    constructor(container) {
        this.destroyed = false;
        this.container = container;
        // Make container focusable to receive keyboard events
        this.container.setAttribute('tabindex', '0');
        this.container.style.outline = 'none'; // Remove default focus outline
        this.pdfDoc = null;
        this.scale = 1.5;
        this.scaleMode = 'auto';
        this.pageStack = null;
        this.pinchFocusPoint = null;
        this.pinchViewportCenter = null;
        this.pageDetectionListenerAttached = false;
        this.pages = []; // { num, wrapper, viewport, rendered }
        this.observer = null;
        this.selectionMode = PDFReader.currentSelectionMode; // Initialize from static state
        this.fileId = null;
        this.zoomFeedbackTimeout = null;
        this.initialScrollTimeout = null;
        this.cleanupCallbacks = [];
        this.boundDetectCurrentPage = this.detectCurrentPage.bind(this);
        this.touchSelectionScheduler = createTouchSelectionScheduler(
            (pageNum) => this.handleSelection(pageNum),
            {
                readSelection: () => window.getSelection(),
                getSignature: (selection) => {
                    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
                        return '';
                    }

                    const text = selection.toString().trim().replace(/\s+/g, ' ');
                    if (!text) {
                        return '';
                    }

                    const range = selection.getRangeAt(0);
                    return `${text}|${range.startOffset}|${range.endOffset}`;
                }
            }
        );
        this.handleScrollTick = () => {
            if (!this.scrollTicking) {
                window.requestAnimationFrame(() => {
                    this.detectCurrentPage();
                    this.scrollTicking = false;
                });
                this.scrollTicking = true;
            }
        };

        // Initialize modules
        this.highlightRenderer = new PDFHighlightRenderer(container, this.pages, this.fileId);
        this.highlightRenderer.setOnHighlightClick((e, highlightId, cardId) => {
            this.handleHighlightClick(e, highlightId, cardId);
        });

        this.areaSelector = new PDFAreaSelector({
            onHighlightClick: (e, highlightId, cardId) => {
                this.handleHighlightClick(e, highlightId, cardId);
            }
        });

        this.highlighterTool = new PDFHighlighterTool({
            container: container,
            pages: this.pages,
            onHighlightClick: (e, highlightId, cardId) => {
                this.handleHighlightClick(e, highlightId, cardId);
            }
        });

        this.toolbar = createReaderHighlightToolbar(container, {
            onDeleteHighlight: (highlightId, cardId) => {
                this.deleteHighlight(highlightId, cardId);
            },
            onUpdateColor: (highlightId, color) => {
                this.updateHighlightColor(highlightId, color);
            }
        });

        this.initObserver();
        this.initResponsiveFitObserver();
        this.initEventHandlers();

        this.cleanupCallbacks.push(registerPdfReaderGlobalListeners(this));

        // Initialize selection mode and colors
        this.setSelectionMode(this.selectionMode);

        this.cleanupCallbacks.push(setupPdfZoomHandling(
            this.container,
            () => this.scale,
            (newScale) => this.setScale(newScale),
            {
                onPreviewStart: (gesture) => this.startPinchPreview(gesture),
                onPreviewUpdate: (gesture) => this.updatePinchPreview(gesture),
                onPreviewCommit: (gesture) => this.commitPinchPreview(gesture),
                onPreviewCancel: () => this.clearPinchPreview()
            }
        ));
        this.cleanupCallbacks.push(setupPdfPanHandling(
            this.container,
            () => this.selectionMode
        ));
    }

    showZoomFeedback(scale = this.scale) {
        if (!this.zoomFeedbackEl) {
            this.zoomFeedbackEl = document.createElement('div');
            this.zoomFeedbackEl.className = 'reader-zoom-feedback';
            this.container.appendChild(this.zoomFeedbackEl);
        }

        this.zoomFeedbackEl.textContent = `${Math.round(scale * 100)}%`;
        this.zoomFeedbackEl.classList.add('visible');

        if (this.zoomFeedbackTimeout) {
            clearTimeout(this.zoomFeedbackTimeout);
        }

        this.zoomFeedbackTimeout = window.setTimeout(() => {
            this.zoomFeedbackEl?.classList.remove('visible');
        }, 900);
    }

    initEventHandlers() {
        this.handleCardSoftDeleted = (e) => {
            const { id, highlightId, deleted } = e.detail;
            const card = id ? getAppContext().cardSystem?.cards?.get?.(id) : null;
            if (deleted && highlightId && (!card || card.deleted === true)) {
                this.removeHighlightOverlays(highlightId);
            }
        };

        this.handleCardRestored = (e) => {
            const { highlightId } = e.detail;
            const highlight = findHighlightById(getAppContext().highlightManager?.highlights, highlightId);
            if (!highlight) return;

            const pageInfo = this.pages[highlight.location.page - 1];
            if (pageInfo?.rendered) {
                this.removeHighlightOverlays(highlightId);
                this.renderHighlightsForPage(highlight.location.page, getAppContext().highlightManager.highlights);
            }
        };

        this.handleHighlightsRestored = (e) => {
            const highlights = e.detail.highlights;
            this.pages.forEach((pageInfo) => {
                if (pageInfo.rendered) {
                    this.renderHighlightsForPage(pageInfo.num, highlights);
                }
            });
        };

        this.handleMindmapNodeUpdated = (e) => {
            const { highlightId, color } = e.detail;
            this.updateHighlightColor(highlightId, color);
        };

        this.handleHighlightRemoved = (e) => {
            const highlightId = e.detail;
            if (this.highlighterTool) {
                this.highlighterTool.removeHighlight(highlightId);
            }
            this.highlightRenderer.removeHighlightOverlays(highlightId);
        };

        registerHighlightToolbarDeletionHandler(this, {
            getSelectedHighlightId: () => this.toolbar.getSelectedHighlightId(),
            getSelectedCardId: () => this.toolbar.getSelectedCardId(),
            beforeDelete: (e) => {
                const activeTag = document.activeElement.tagName;
                const isContentEditable = document.activeElement.isContentEditable;
                if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && !isContentEditable) {
                    e.preventDefault();
                    return true;
                }

                return false;
            },
            afterDelete: () => {
                clearSelectedHighlightState(this, this.toolbar.getSelectedHighlightId());
            }
        });
    }

    async setScale(newScale, focusPoint = null, options = {}) {
        const { autoFit = false } = options;
        if (!autoFit) {
            this.scaleMode = 'manual';
        }

        if (Math.abs(this.scale - newScale) < 0.01) return;

        const { focusPointIsContent = false, viewportFocusPoint = null } = options;
        const resolvedFocusPoint = focusPoint ?? {
            x: this.container.clientWidth / 2,
            y: this.container.clientHeight / 2
        };
        const resolvedViewportFocusPoint = viewportFocusPoint ?? (
            focusPointIsContent
                ? {
                    x: this.container.clientWidth / 2,
                    y: this.container.clientHeight / 2
                }
                : resolvedFocusPoint
        );
        const contentFocusX = focusPointIsContent
            ? resolvedFocusPoint.x
            : this.container.scrollLeft + resolvedFocusPoint.x;
        const contentFocusY = focusPointIsContent
            ? resolvedFocusPoint.y
            : this.container.scrollTop + resolvedFocusPoint.y;
        const scaleAnchor = this.captureScaleAnchor(contentFocusX, contentFocusY);

        this.scale = newScale;

        // Reload pages with new scale
        const previousStack = this.pageStack;
        await this.initPages({ preserveExisting: true });

        this.restoreScaleAnchor(scaleAnchor, resolvedViewportFocusPoint);
        await this.renderVisiblePages();
        this.finishPageStackTransition(previousStack);
        this.showZoomFeedback(newScale);
    }

    async getFitToWidthScale() {
        if (!this.pdfDoc) return this.scale;

        const firstPage = await this.pdfDoc.getPage(1);
        const pageWidth = firstPage.getViewport({ scale: 1 }).width;
        const availableWidth = Math.max(240, this.container.clientWidth - 32);
        return Math.min(1.5, availableWidth / pageWidth);
    }

    initResponsiveFitObserver() {
        const scheduleFit = () => {
            if (this.scaleMode !== 'auto' || !this.pdfDoc || this.destroyed) {
                return;
            }

            if (this.fitRunning) {
                this.fitPending = true;
                return;
            }

            if (this.fitFrame) return;

            this.fitFrame = window.requestAnimationFrame(() => {
                this.fitFrame = null;
                if (this.scaleMode !== 'auto' || !this.pdfDoc || this.destroyed) return;
                this.fitRunning = true;
                void (async () => {
                    try {
                        const nextScale = await this.getFitToWidthScale();
                        if (!this.destroyed && this.scaleMode === 'auto') {
                            await this.setScale(nextScale, null, { autoFit: true });
                        }
                    } finally {
                        this.fitRunning = false;
                        if (this.fitPending) {
                            this.fitPending = false;
                            scheduleFit();
                        }
                    }
                })();
            });
        };

        if (typeof ResizeObserver !== 'undefined') {
            this.fitObserver = new ResizeObserver(scheduleFit);
            this.fitObserver.observe(this.container);
            this.cleanupCallbacks.push(() => {
                this.fitObserver?.disconnect();
                this.fitObserver = null;
            });
        } else {
            window.addEventListener('resize', scheduleFit);
            this.cleanupCallbacks.push(() => window.removeEventListener('resize', scheduleFit));
        }
    }

    captureScaleAnchor(contentFocusX, contentFocusY) {
        const anchorPage = this.pages.find((page) => {
            const top = page.wrapper.offsetTop;
            const bottom = top + page.wrapper.offsetHeight;
            return contentFocusY >= top && contentFocusY <= bottom;
        }) ?? this.pages[0];

        if (!anchorPage?.wrapper) {
            return null;
        }

        const pageTop = anchorPage.wrapper.offsetTop;
        const pageLeft = anchorPage.wrapper.offsetLeft;
        const pageHeight = anchorPage.wrapper.offsetHeight || 1;
        const pageWidth = anchorPage.wrapper.offsetWidth || 1;

        return {
            pageNum: anchorPage.num,
            relativeX: (contentFocusX - pageLeft) / pageWidth,
            relativeY: (contentFocusY - pageTop) / pageHeight
        };
    }

    restoreScaleAnchor(scaleAnchor, focusPoint) {
        if (!scaleAnchor) {
            this.container.scrollLeft = Math.max(0, this.container.scrollLeft);
            this.container.scrollTop = Math.max(0, this.container.scrollTop);
            return;
        }

        const anchorPage = this.pages[scaleAnchor.pageNum - 1];
        if (!anchorPage?.wrapper) {
            return;
        }

        const pageTop = anchorPage.wrapper.offsetTop;
        const pageLeft = anchorPage.wrapper.offsetLeft;
        const targetX = pageLeft + (anchorPage.wrapper.offsetWidth * scaleAnchor.relativeX);
        const targetY = pageTop + (anchorPage.wrapper.offsetHeight * scaleAnchor.relativeY);

        this.container.scrollLeft = Math.max(0, targetX - focusPoint.x);
        this.container.scrollTop = Math.max(0, targetY - focusPoint.y);
    }

    initObserver() {
        this.observer = new IntersectionObserver(
            (entries) => this.handleIntersection(entries),
            {
                root: this.container,
                threshold: [0.01, 0.5], // Check small and large intersections
                rootMargin: '200px' // Preload margin
            }
        );
        this.cleanupCallbacks.push(() => {
            if (this.observer) {
                this.observer.disconnect();
            }
        });

        // Add scroll listener for smoother page updates
        this.container.addEventListener('scroll', this.handleScrollTick, { passive: true });
        this.cleanupCallbacks.push(() => {
            this.container.removeEventListener('scroll', this.handleScrollTick);
        });
    }

    setPageCountCallback(callback) {
        this.onPageCountChange = callback;
    }

    setPageChangeCallback(callback) {
        this.onPageChange = callback;
    }

    setSelectionMode(mode) {
        this.selectionMode = mode;
        PDFReader.currentSelectionMode = mode; // Update static state
        this.areaSelector.setSelectionMode(mode);

        // Update tool colors based on mode
        if (mode === 'rect' || mode === 'rectangle' || mode === 'ellipse') {
            const colorKey = (mode === 'rect' || mode === 'rectangle') ? 'rect' : 'ellipse';
            this.areaSelector.setColor(PDFReader.defaultColors[colorKey]);
        } else if (mode === 'highlighter') {
            this.highlighterTool.setColor(PDFReader.defaultColors.highlighter);
        }

        // Activate highlighter tool if mode matches
        this.highlighterTool.setIsActive(mode === 'highlighter');

        applyReaderSelectionMode({
            container: this.container,
            mode,
            targetElements: Array.from(this.container.querySelectorAll('.textLayer')),
            nonTextTouchAction: mode === 'pan' ? 'pan-x pan-y pinch-zoom' : 'none'
        });
    }

    startPinchPreview(gesture) {
        if (!this.pageStack) return;
        if (gesture?.center) {
            this.pinchViewportCenter = gesture.center;
            this.pinchFocusPoint = this.resolvePinchFocusPoint(gesture.center);
            this.pageStack.style.transformOrigin = `${this.pinchFocusPoint.x}px ${this.pinchFocusPoint.y}px`;
        }
        this.pageStack.classList.add('pinch-zooming');
    }

    updatePinchPreview(gesture) {
        if (!this.pageStack) return;
        if (gesture?.center) {
            this.pinchViewportCenter = gesture.center;
            this.pinchFocusPoint = this.resolvePinchFocusPoint(gesture.center);
            this.pageStack.style.transformOrigin = `${this.pinchFocusPoint.x}px ${this.pinchFocusPoint.y}px`;
        }
        const scaleRatio = gesture.scale / this.scale;
        this.pageStack.classList.add('pinch-zooming');
        this.pageStack.style.setProperty('--pinch-scale', String(scaleRatio));
    }

    async commitPinchPreview(gesture) {
        const containerRect = this.container.getBoundingClientRect();
        const viewportFocusPoint = this.pinchViewportCenter
            ? {
                x: this.pinchViewportCenter.x - containerRect.left,
                y: this.pinchViewportCenter.y - containerRect.top
            }
            : {
                x: this.container.clientWidth / 2,
                y: this.container.clientHeight / 2
            };

        await this.setScale(gesture.scale, this.pinchFocusPoint, {
            focusPointIsContent: true,
            viewportFocusPoint
        });
        this.clearPinchPreview();
    }

    clearPinchPreview() {
        if (!this.pageStack) return;
        this.pageStack.classList.remove('pinch-zooming');
        this.pageStack.style.removeProperty('--pinch-scale');
        this.pageStack.style.removeProperty('transform-origin');
        this.pinchFocusPoint = null;
        this.pinchViewportCenter = null;
    }

    resolvePinchFocusPoint(center) {
        const containerRect = this.container.getBoundingClientRect();
        return {
            x: this.container.scrollLeft + (center.x - containerRect.left),
            y: this.container.scrollTop + (center.y - containerRect.top)
        };
    }

    handleSelection(pageNum) {
        const selection = window.getSelection();
        if (!selection.rangeCount || selection.isCollapsed) return;

        const range = selection.getRangeAt(0);
        // Normalize whitespace to avoid issues with PDF text extraction
        const text = selection.toString().trim().replace(/\s+/g, ' ');
        if (!text) return;

        // NEW LOGIC: Support cross-page selection
        // Instead of assuming everything is on `pageNum`, we check which page each rect belongs to.

        const { highlightRects, overlayDescriptors } = collectSelectionRects(range, this.pages);
        const highlightOverlays = overlayDescriptors.map((descriptor) => {
            const highlightDiv = document.createElement('div');
            highlightDiv.className = 'highlight-overlay';
            highlightDiv.style.position = 'absolute';
            highlightDiv.style.top = `${descriptor.topPx}px`;
            highlightDiv.style.left = `${descriptor.leftPx}px`;
            highlightDiv.style.width = `${descriptor.width}px`;
            highlightDiv.style.height = `${descriptor.height}px`;
            highlightDiv.style.backgroundColor = PDFReader.defaultColors.text;
            if (PDFReader.defaultColors.text.startsWith('#')) {
                highlightDiv.style.opacity = '0.4';
            }
            highlightDiv.style.pointerEvents = 'none';
            highlightDiv.style.zIndex = '100';

            descriptor.pageWrapper.appendChild(highlightDiv);
            return highlightDiv;
        });

        if (highlightRects.length === 0) return;

        // Use the page of the first rect as the primary "location" page, 
        // but individual rects now carry their own page info.
        const primaryPage = highlightRects[0].page;

        // Create highlight data
        const highlight = highlightManager.createHighlight(text, {
            page: primaryPage, // Primary anchor page (for sorting/jumping)
            rects: highlightRects // Contains { page, top, ... }
        }, this.fileId, 'text', PDFReader.defaultColors.text, this.fileName);

        // Convert temporary overlays to clickable highlights
        highlightOverlays.forEach(div => {
            div.dataset.highlightId = highlight.id;
            div.style.pointerEvents = 'auto';
            div.style.cursor = 'pointer';

            // The linked card may not be registered yet when the drag flow
            // lands here, so resolve the card id at click time instead of
            // after a fixed delay.
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                const cardId = findCardIdByHighlightId(getAppContext().cardSystem, highlight.id);
                if (cardId) {
                    this.handleHighlightClick(e, highlight.id, cardId);
                }
            });
        });

        selection.removeAllRanges();
    }

    async load(fileData, initialPage = 1) {
        try {
            // Clear highlights from previous document (visual only, preserve data)
            if (this.highlightRenderer && this.fileId) {

                this.highlightRenderer.clearAllHighlights();
            }

            this.fileId = fileData.id;
            this.fileName = fileData.name; // Store file name
            this.highlightRenderer.setFileId(fileData.id);
            this.areaSelector.setFileId(fileData.id);
            this.areaSelector.setFileName(fileData.name); // Pass file name to area selector
            if (this.highlighterTool) {
                this.highlighterTool.setFileId(fileData.id);
            }

            // Notify DocumentManager that this document is now loaded
            if (getAppContext().documentManager) {
                getAppContext().documentManager.markDocumentLoaded(fileData.id, true);
            }

            const arrayBuffer = await fileData.fileObj.arrayBuffer();

            // Calculate MD5
            try {
                const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

                updateCurrentBook({
                    md5: hashHex,
                    name: fileData.name,
                    id: this.fileId
                });

                // Check if we have a pending restore for this book
                if (getAppContext().pendingRestore && getAppContext().pendingRestore.md5 === hashHex) {
                    const oldId = getAppContext().pendingRestore.id;
                    if (oldId) {
                        if (getAppContext().highlightManager) {
                            getAppContext().highlightManager.remapSourceIds(this.fileId, oldId);
                        }
                        if (getAppContext().cardSystem) {
                            getAppContext().cardSystem.remapSourceIds(this.fileId, oldId);
                        }
                    } else {
                        console.warn('[PDFReader] Pending restore found but no old ID. Skipping remapping to be safe.');
                    }

                    // Clear pending restore
                    setAppService('pendingRestore', null);
                }
            } catch (e) {
                logger.error('Error calculating hash', e);
            }

            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            this.pdfDoc = await loadingTask.promise;

            // Fit the full page to the current reading column until the reader
            // explicitly zooms; the resize observer keeps orientation changes
            // and split-panel adjustments in sync.
            if (this.scaleMode === 'auto') {
                this.scale = await this.getFitToWidthScale();
            }

            this.onPageCountChange?.(this.pdfDoc.numPages);

            await this.initPages();

            // Reset scroll position to show first page
            // Store timeout so it can be cancelled if a jump occurs immediately
            if (initialPage > 1) { // Removed numPages check as this.pdfDoc might not be fully populated? No, it is awaited above.
                logger.debug('Jumping to initial page', initialPage);
                // Use a short delay to ensure layout
                setTimeout(() => {
                    this.scrollToPage(initialPage);
                }, 100);
            } else {
                this.initialScrollTimeout = setTimeout(() => {
                    requestAnimationFrame(() => {
                        this.container.scrollTop = 0;
                        this.container.scrollLeft = 0;
                        this.onPageChange?.(1);
                        this.initialScrollTimeout = null;
                    });
                }, 500);
            }

            return this.pdfDoc;
        } catch (error) {
            logger.error('Error loading PDF', error);
            throw error;
        }
    }

    async initPages(options = {}) {
        const { preserveExisting = false } = options;
        const previousPages = [...this.pages];
        previousPages.forEach((page) => {
            if (page.wrapper) {
                this.observer.unobserve(page.wrapper);
            }
        });

        if (!preserveExisting) {
            this.container.innerHTML = '';
        } else if (this.pageStack) {
            this.pageStack.classList.add('pdf-page-stack-overlay');
        }

        const { pageStack, pages } = await this.createPageStack();
        if (this.destroyed) return;
        this.pageStack = pageStack;
        this.pages.length = 0;
        this.pages.push(...pages);
        this.container.appendChild(this.pageStack);

        if (!this.pageDetectionListenerAttached) {
            this.container.addEventListener('scroll', this.boundDetectCurrentPage);
            this.pageDetectionListenerAttached = true;
            this.cleanupCallbacks.push(() => {
                this.container.removeEventListener('scroll', this.boundDetectCurrentPage);
            });
        }
    }

    async createPageStack() {
        const pageStack = document.createElement('div');
        pageStack.className = 'pdf-page-stack';
        pageStack.style.position = 'relative';
        pageStack.style.display = 'flex';
        pageStack.style.flexDirection = 'column';
        pageStack.style.alignItems = 'center';
        pageStack.style.transformOrigin = 'top center';
        pageStack.style.width = '100%';

        const pages = [];
        for (let num = 1; num <= this.pdfDoc.numPages; num++) {
            const page = await this.pdfDoc.getPage(num);
            if (this.destroyed) return { pageStack, pages };
            const viewport = page.getViewport({ scale: this.scale });
            const wrapper = createPageWrapper(num, viewport);

            pageStack.appendChild(wrapper);

            const pageInfo = {
                num,
                wrapper,
                viewport,
                rendered: false
            };
            pages.push(pageInfo);
            this.observer.observe(wrapper);
        }

        return { pageStack, pages };
    }

    async renderVisiblePages() {
        const viewportTop = this.container.scrollTop - 160;
        const viewportBottom = this.container.scrollTop + this.container.clientHeight + 160;
        const pagesToRender = this.pages.filter((page) => {
            const top = page.wrapper.offsetTop;
            const bottom = top + page.wrapper.offsetHeight;
            return bottom >= viewportTop && top <= viewportBottom;
        });

        await Promise.all(pagesToRender.map((page) => this.renderPage(page)));
    }

    finishPageStackTransition(previousStack) {
        if (!previousStack || previousStack === this.pageStack) return;

        requestAnimationFrame(() => {
            previousStack.classList.add('fade-out');
            window.setTimeout(() => {
                previousStack.remove();
            }, 140);
        });
    }

    handleIntersection(entries) {
        let needsUpdate = false;

        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const wrapper = entry.target;
                const pageNum = parseInt(wrapper.dataset.pageNum);
                const pageInfo = this.pages[pageNum - 1];

                if (pageInfo && !pageInfo.rendered) {
                    this.renderPage(pageInfo);
                }

                // Optimization: Unload pages that are far away
                this.cleanupPages(pageNum);

                needsUpdate = true;
            }
        });

        if (needsUpdate) {
            this.detectCurrentPage();
        }
    }

    detectCurrentPage() {
        if (!this.pages.length) return;

        const container = this.container;
        const viewTop = container.scrollTop;
        const viewHeight = container.clientHeight;
        const viewMiddle = viewTop + (viewHeight / 3); // Bias towards top third for "current" page

        let bestPage = this.currentPage || 1;

        // Find page covering the "middle" (top third) line
        for (const page of this.pages) {
            if (!page.wrapper) continue;
            const pageTop = page.wrapper.offsetTop;
            const pageBottom = pageTop + page.wrapper.offsetHeight;

            if (pageTop <= viewMiddle && pageBottom >= viewMiddle) {
                bestPage = page.num;
                break;
            }
        }

        if (this._lastReportedPage !== bestPage) {
            this._lastReportedPage = bestPage;
            this.onPageChange?.(bestPage);
        }
    }

    cleanupPages(currentPage) {
        const KEEP_RANGE = 3; // Keep current page +/- 3 pages

        // We can optimize this loop if pages array is large, but for typical PDFs it's fine.
        // For very large PDFs (1000+ pages), we might want to only check pages around the previously rendered range.
        // But iterating 1000 items is fast enough in JS.

        this.pages.forEach(page => {
            if (page.rendered && Math.abs(page.num - currentPage) > KEEP_RANGE) {
                // console.log(`[PDFReader] Unloading page ${page.num}`);
                page.wrapper.innerHTML = ''; // Clear canvas and text layer
                page.rendered = false;
            }
        });
    }

    async renderPage(pageInfo) {
        if (pageInfo.rendered) return pageInfo.renderTask ?? Promise.resolve();
        pageInfo.rendered = true;

        const viewport = pageInfo.viewport;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        // Output scaling
        const devicePixelRatio = window.devicePixelRatio || 1;
        canvas.width = viewport.width * devicePixelRatio;
        canvas.height = viewport.height * devicePixelRatio;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const renderContext = {
            canvasContext: context,
            viewport: viewport,
            transform: [devicePixelRatio, 0, 0, devicePixelRatio, 0, 0]
        };

        if (this.destroyed) return Promise.resolve();
        pageInfo.wrapper.appendChild(canvas);

        // Setup tool listeners on wrapper
        if (this.areaSelector) {
            this.areaSelector.setupListeners(pageInfo.wrapper, pageInfo.num);
        }
        if (this.highlighterTool) {
            this.highlighterTool.setupListeners(pageInfo.wrapper, pageInfo.num);
        }

        pageInfo.renderTask = this.pdfDoc.getPage(pageInfo.num).then(page => {
            return page.render(renderContext).promise;
        });

        return pageInfo.renderTask.then(() => {
            // Render Text Layer
            this.renderTextLayer(pageInfo);
            // Render highlights for this page
            setTimeout(() => {
                if (this.highlightRenderer && getAppContext().highlightManager) {
                    const highlights = getAppContext().highlightManager.highlights;
                    this.highlightRenderer.renderHighlightsForPage(pageInfo.num, highlights);
                }
            }, 0);
        }).catch(err => {
            if (err.name !== 'RenderingCancelledException') {
                logger.error('Render error', err);
            }
        });
    }

    renderTextLayer(pageInfo) {
        this.pdfDoc.getPage(pageInfo.num).then(page => {
            page.getTextContent().then(textContent => {
                const textLayerDiv = document.createElement('div');
                textLayerDiv.className = 'textLayer';

                // Set explicit dimensions matching viewport
                textLayerDiv.style.width = `${pageInfo.viewport.width}px`;
                textLayerDiv.style.height = `${pageInfo.viewport.height}px`;

                // IMPORTANT: Set scale factor for correct text sizing
                textLayerDiv.style.setProperty('--scale-factor', pageInfo.viewport.scale);

                pageInfo.wrapper.appendChild(textLayerDiv);

                const textLayer = new pdfjsLib.TextLayer({
                    textContentSource: textContent,
                    container: textLayerDiv,
                    viewport: pageInfo.viewport,
                    textDivs: []
                });

                textLayer.render().then(() => {
                    applyReaderSelectionMode({
                        container: this.container,
                        mode: this.selectionMode,
                        targetElements: [textLayerDiv],
                        nonTextTouchAction: this.selectionMode === 'pan' ? 'pan-x pan-y pinch-zoom' : 'none'
                    });
                    textLayerDiv.addEventListener('mouseup', () => {
                        if (this.selectionMode === 'text') {
                            this.handleSelection(pageInfo.num);
                        }
                    });
                    textLayerDiv.addEventListener('touchend', () => {
                        if (this.selectionMode === 'text') {
                            this.touchSelectionScheduler.schedule(pageInfo.num);
                        }
                    }, { passive: true });
                });
            });
        });
    }

    renderHighlightsForPage(pageNum, highlights) {
        this.highlightRenderer.renderHighlightsForPage(pageNum, highlights);
    }

    flashHighlight(highlightId) {
        this.highlightRenderer.flashHighlight(highlightId);
    }

    async scrollToHighlight(highlightId) {
        // console.log('[PDFReader] scrollToHighlight:', highlightId);

        // Cancel any pending initial scroll reset (race condition fix)
        if (this.initialScrollTimeout) {
            // console.log('[PDFReader] Cancelling initial scroll reset due to jump request');
            clearTimeout(this.initialScrollTimeout);
            this.initialScrollTimeout = null;
        }

        // Find highlight
        const highlight = findHighlightById(getAppContext().highlightManager?.highlights, highlightId);

        if (!highlight) {
            console.warn('[PDFReader] Highlight not found for scrolling:', highlightId);
            return;
        }

        const pageNum = highlight.location.page;
        const pageInfo = this.pages[pageNum - 1];

        if (!pageInfo || !pageInfo.wrapper) {
            console.warn('[PDFReader] Page wrapper not found for page:', pageNum);
            return;
        }

        // 1. Scroll page into view immediately
        pageInfo.wrapper.scrollIntoView({ behavior: 'auto', block: 'center' });

        // 2. Ensure page is rendered
        if (!pageInfo.rendered) {
            // console.log('[PDFReader] Page not rendered, rendering now:', pageNum);
            await this.renderPage(pageInfo);
        } else {
            // console.log('[PDFReader] Page already rendered:', pageNum);
        }

        // 3. Flash highlight (now that we know it's rendered)
        // Small delay to allow DOM updates if just rendered
        setTimeout(() => {
            this.flashHighlight(highlightId);
        }, 100);
    }

    handleHighlightClick(e, highlightId, cardId) {
        // Focus the container to ensure keyboard events are captured here
        this.container.focus();
        handleReaderHighlightClick(this, e, highlightId, cardId, ({ highlightId: selectedId, cardId: selectedCardId }) => {
            window.dispatchEvent(new CustomEvent(APP_EVENTS.HIGHLIGHT_CLICKED, {
                detail: { highlightId: selectedId, cardId: selectedCardId }
            }));
        });
    }

    hideToolbar() {
        clearSelectedHighlightState(this, this.toolbar.getSelectedHighlightId());
    }

    deleteHighlight(highlightId, cardId) {
        removeHighlightFromStores(getAppContext().cardSystem, highlightId, cardId);
    }

    removeHighlightOverlays(highlightId) {
        if (!highlightId) return;

        // Remove standard overlays (text highlights) and area borders (image highlights)
        const overlays = this.container.querySelectorAll(`[data-highlight-id="${highlightId}"]`);
        overlays.forEach(el => el.remove());

        // Also remove from SVG layer if present
        const svgs = this.container.querySelectorAll(`[data-highlight-svg-id="${highlightId}"]`);
        svgs.forEach(el => el.remove());

        // Ensure HighlightRenderer also cleans up
        if (this.highlightRenderer) {
            this.highlightRenderer.removeHighlightOverlays(highlightId);
        }
    }

    updateHighlightColor(highlightId, color) {
        applyHighlightColorToElements(this.container, highlightId, color);

        // Update model
        if (getAppContext().highlightManager) {
            const highlight = updateHighlightModelColor(highlightId, color);
            if (highlight) {
                syncDefaultHighlightColor(PDFReader.defaultColors, highlight.type, color);

                if (highlight.type === 'highlighter') {
                    // If currently using highlighter, update tool immediately
                    if (this.selectionMode === 'highlighter') {
                        this.highlighterTool.setColor(color);
                    }
                } else if (highlight.type === 'rect' || highlight.type === 'rectangle') {
                    if (this.selectionMode === 'rect' || this.selectionMode === 'rectangle') {
                        this.areaSelector.setColor(color);
                    }
                } else if (highlight.type === 'ellipse') {
                    if (this.selectionMode === 'ellipse') {
                        this.areaSelector.setColor(color);
                    }
                }
            }
        }
    }

    async getOutline() {
        if (!this.pdfDoc) return null;
        return await this.pdfDoc.getOutline();
    }

    async navigateToDest(dest) {
        if (!this.pdfDoc) return;

        try {
            const pageNum = await resolveDestinationPageNumber(this.pdfDoc, dest);
            if (!pageNum) {
                console.warn('[PDFReader] Destination is null');
                return;
            }

            this.scrollToPage(pageNum);
        } catch (e) {
            logger.error('Navigation error', e);
        }
    }

    scrollToPage(pageNum) {
        logger.debug('scrollToPage requested', pageNum);

        // Cancel initial scroll reset if it's pending (Fix for auto-restore race condition)
        if (this.initialScrollTimeout) {
            clearTimeout(this.initialScrollTimeout);
            this.initialScrollTimeout = null;
        }

        pageNum = Math.max(1, Math.min(pageNum, this.pdfDoc.numPages));
        const pageInfo = this.pages[pageNum - 1];

        if (pageInfo && pageInfo.wrapper) {
            logger.debug('Rolling to wrapper for page', { pageNum, top: pageInfo.wrapper.offsetTop });

            // Use 'auto' instead of 'smooth' to prevent race conditions during heavy render
            pageInfo.wrapper.scrollIntoView({ behavior: 'auto', block: 'start' });

            // Force immediate update
            // Verify if scroll actually happened before detecting?
            // setTimeout to allow layout to settle
            setTimeout(() => {
                this.detectCurrentPage();
            }, 50);
        } else {
            console.warn('[PDFReader] Page wrapper not found for:', pageNum);
        }
    }

    onPrevPage() {
        // Find first visible page or use current logic
        // Simply scrolling up by one page height? No, page-based.
        // We'll estimate current page from scroll position if needed, or track it.
        // For now, let's look at the first page that intersects or close to top.
        // A heuristic: find page closest to top of container.
        const bestPage = getNearestPageNumber(this.pages, this.container.scrollTop);

        if (bestPage > 1) {
            this.scrollToPage(bestPage - 1);
        }
    }

    onNextPage() {
        const bestPage = getNearestPageNumber(this.pages, this.container.scrollTop);

        if (bestPage < this.pdfDoc.numPages) {
            this.scrollToPage(bestPage + 1);
        }
    }

    centerContentHorizontally() {
        const overflowX = this.container.scrollWidth - this.container.clientWidth;
        this.container.scrollLeft = overflowX > 0 ? overflowX / 2 : 0;
    }

    onLayoutChange({ page } = {}) {
        if (!this.pdfDoc || !this.pages.length) {
            return;
        }

        const targetPage = Math.max(
            1,
            Math.min(page || this._lastReportedPage || getNearestPageNumber(this.pages, this.container.scrollTop), this.pdfDoc.numPages)
        );

        this.scrollToPage(targetPage);
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                this.centerContentHorizontally();
            });
        });
    }

    /**
     * Clean up all event listeners and resources
     */
    destroy() {
        // Block in-flight async render callbacks from touching the DOM
        // after teardown (they used to re-append page stacks).
        this.destroyed = true;

        if (this.fitFrame) {
            window.cancelAnimationFrame(this.fitFrame);
            this.fitFrame = null;
        }

        if (this.zoomFeedbackTimeout) {
            clearTimeout(this.zoomFeedbackTimeout);
            this.zoomFeedbackTimeout = null;
        }

        this.touchSelectionScheduler?.cancel?.();
        this.zoomFeedbackEl?.remove();


        if (this.initialScrollTimeout) {
            clearTimeout(this.initialScrollTimeout);
            this.initialScrollTimeout = null;
        }

        // Disconnect observer
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        this.cleanupCallbacks.forEach((cleanup) => cleanup());
        this.cleanupCallbacks = [];

        // Clean up sub-components
        if (this.areaSelector) {
            this.areaSelector.destroy();
        }
        if (this.highlighterTool) {
            // Assuming highlighterTool might need cleanup too, but for now just null it
            // Ideally add destroy to highlighterTool as well
        }
        if (this.toolbar) {
            this.toolbar.hide();
            // Remove toolbar element if it was appended to body/container
        }

        // Clear container
        this.container.innerHTML = '';
        this.pages = [];
        this.pdfDoc = null;
    }
}
