import { createLogger } from '../core/logger.js';
import { APP_EVENTS } from '../core/event-names.js';

const logger = createLogger('SplitView');

export class SplitView {
    constructor(options) {
        logger.debug('Initializing SplitView with options', options);
        this.leftPanel = document.getElementById(options.leftId);
        this.centerPanel = document.getElementById(options.centerId);
        this.rightPanel = document.getElementById(options.rightId);

        this.resizerLeft = document.getElementById(options.resizerLeftId);
        this.resizerRight = document.getElementById(options.resizerRightId);

        if (!this.leftPanel || !this.centerPanel || !this.rightPanel || !this.resizerLeft || !this.resizerRight) {
            logger.error('One or more elements not found', {
                left: this.leftPanel,
                center: this.centerPanel,
                right: this.rightPanel,
                resizerLeft: this.resizerLeft,
                resizerRight: this.resizerRight
            });
            return;
        }

        this.minWidth = 200;
        this.minCenterWidth = options.minCenterWidth || 300;
        this.compactBreakpoint = options.compactBreakpoint || 1100;
        this.mobileBreakpoint = options.mobileBreakpoint || 680;
        this.mouseResizeMargin = options.mouseResizeMargin || 6;
        this.touchResizeMargin = options.touchResizeMargin || 18;
        this.isCompact = false;
        this.viewportMode = 'desktop';
        this.activeResize = null;
        this.pendingResizeClientX = null;
        this.resizeFrame = null;
        this.handleViewportChange = () => this.applyResponsiveState();
        this.handleWindowBlur = () => this.stopActiveResize();
        this.panelPresets = options.panelPresets || {
            left: ['30vw', '36vw', '42vw'],
            right: ['32vw', '40vw', '48vw']
        };
        this.panelPresetIndex = {
            left: 1,
            right: 1
        };

        this.setupResizers();
        this.syncResizerAvailability('left', this.isLeftCollapsed());
        this.syncResizerAvailability('right', this.isRightCollapsed());
        window.addEventListener('resize', this.handleViewportChange);
        window.addEventListener('blur', this.handleWindowBlur);
        this.applyResponsiveState();
        logger.debug('SplitView initialized successfully');
    }

    setupResizers() {
        const addResizeListeners = (element, isLeft) => {
            const isPointerNearHandle = (event) => {
                const rect = element.getBoundingClientRect();
                const clientX = event.clientX;
                const isTouchLike = event.pointerType === 'touch' || event.pointerType === 'pen';
                const margin = isTouchLike ? this.touchResizeMargin : this.mouseResizeMargin;
                const handleCenter = rect.left + (rect.width / 2);
                return Math.abs(clientX - handleCenter) <= margin;
            };

            const startResize = (event) => {
                if (element.classList.contains('resizer-disabled')) {
                    return;
                }

                if (event.button !== undefined && event.button !== 0) {
                    return;
                }

                if (!isPointerNearHandle(event)) {
                    return;
                }

                event.preventDefault();
                this.beginResizeSession(element, isLeft ? 'left' : 'right', event);
            };

            element.addEventListener('pointerdown', startResize);
        };

        addResizeListeners(this.resizerLeft, true);
        addResizeListeners(this.resizerRight, false);
    }

    beginResizeSession(handle, panel, event) {
        this.stopActiveResize();

        const targetPanel = panel === 'left' ? this.leftPanel : this.rightPanel;
        const oppositePanel = panel === 'left' ? this.rightPanel : this.leftPanel;

        this.activeResize = {
            handle,
            panel,
            pointerId: event.pointerId,
            viewportWidth: document.documentElement.clientWidth,
            oppositePanelWidth: oppositePanel.getBoundingClientRect().width
        };
        this.pendingResizeClientX = event.clientX;

        targetPanel.classList.add('resizing');
        document.body.classList.add('split-resizing');
        document.body.style.cursor = 'col-resize';

        handle.setPointerCapture?.(event.pointerId);
        window.addEventListener('pointermove', this.handlePointerMove, { passive: true });
        window.addEventListener('pointerup', this.handlePointerUp);
        window.addEventListener('pointercancel', this.handlePointerUp);
        handle.addEventListener('lostpointercapture', this.handleLostPointerCapture);

        this.scheduleResize();
    }

    handlePointerMove = (event) => {
        if (!this.activeResize || event.pointerId !== this.activeResize.pointerId) {
            return;
        }

        this.pendingResizeClientX = event.clientX;
        this.scheduleResize();
    }

    handlePointerUp = (event) => {
        if (!this.activeResize || event.pointerId !== this.activeResize.pointerId) {
            return;
        }

        this.stopActiveResize();
    }

    handleLostPointerCapture = (event) => {
        if (!this.activeResize || event.pointerId !== this.activeResize.pointerId) {
            return;
        }

        this.stopActiveResize();
    }

    scheduleResize() {
        if (this.resizeFrame !== null || !this.activeResize) {
            return;
        }

        this.resizeFrame = window.requestAnimationFrame(() => {
            this.resizeFrame = null;
            if (!this.activeResize || this.pendingResizeClientX == null) {
                return;
            }

            this.performResize(this.activeResize.panel, this.pendingResizeClientX);
        });
    }

    performResize(panel, clientX) {
        if (!this.activeResize) {
            return;
        }

        const viewportWidth = this.activeResize.viewportWidth;
        const maxWidth = viewportWidth - this.activeResize.oppositePanelWidth - this.minCenterWidth;
        const nextWidth = panel === 'left' ? clientX : viewportWidth - clientX;

        if (nextWidth < this.minWidth || nextWidth > maxWidth) {
            return;
        }

        const targetPanel = panel === 'left' ? this.leftPanel : this.rightPanel;
        targetPanel.style.width = `${nextWidth}px`;
        targetPanel.style.flex = 'none';
        this.syncPresetIndexFromWidth(panel, nextWidth);
    }

    resolvePresetWidth(panel, preset) {
        const value = typeof preset === 'function' ? preset(window.innerWidth) : preset;
        if (typeof value === 'number') {
            return value;
        }

        if (typeof value === 'string') {
            if (value.endsWith('vw')) {
                return (window.innerWidth * parseFloat(value)) / 100;
            }

            if (value.endsWith('px')) {
                return parseFloat(value);
            }

            const parsed = parseFloat(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        return panel === 'left' ? 320 : 360;
    }

    getPanelResizeBounds(panel) {
        const leftPanelWidth = this.leftPanel.getBoundingClientRect().width;
        const rightPanelWidth = this.rightPanel.getBoundingClientRect().width;

        if (panel === 'left') {
            return {
                min: this.minWidth,
                max: window.innerWidth - rightPanelWidth - this.minCenterWidth
            };
        }

        return {
            min: this.minWidth,
            max: window.innerWidth - leftPanelWidth - this.minCenterWidth
        };
    }

    setPanelWidth(panel, width) {
        const targetPanel = panel === 'left' ? this.leftPanel : this.rightPanel;
        const { min, max } = this.getPanelResizeBounds(panel);
        const nextWidth = Math.max(min, Math.min(width, max));
        targetPanel.style.width = `${nextWidth}px`;
        targetPanel.style.flex = 'none';
        this.syncPresetIndexFromWidth(panel, nextWidth);
        return nextWidth;
    }

    syncPresetIndexFromWidth(panel, width) {
        const presets = this.panelPresets[panel] || [];
        if (presets.length === 0) {
            return;
        }

        let bestIndex = 0;
        let bestDiff = Infinity;
        presets.forEach((preset, index) => {
            const presetWidth = this.resolvePresetWidth(panel, preset);
            const diff = Math.abs(presetWidth - width);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIndex = index;
            }
        });
        this.panelPresetIndex[panel] = bestIndex;
    }

    cyclePanelPreset(panel) {
        if (this.viewportMode !== 'tablet') {
            return null;
        }

        const presets = this.panelPresets[panel] || [];
        if (presets.length === 0) {
            return null;
        }

        const nextIndex = (this.panelPresetIndex[panel] + 1) % presets.length;
        this.panelPresetIndex[panel] = nextIndex;
        const width = this.resolvePresetWidth(panel, presets[nextIndex]);
        const appliedWidth = this.setPanelWidth(panel, width);

        window.dispatchEvent(new CustomEvent(APP_EVENTS.LAYOUT_PANEL_PRESET_CHANGED, {
            detail: {
                panel,
                index: nextIndex,
                width: appliedWidth
            }
        }));

        return appliedWidth;
    }

    stopActiveResize() {
        if (this.resizeFrame !== null) {
            window.cancelAnimationFrame(this.resizeFrame);
            this.resizeFrame = null;
        }

        if (!this.activeResize) {
            this.pendingResizeClientX = null;
            document.body.classList.remove('split-resizing');
            document.body.style.cursor = 'default';
            return;
        }

        const { handle } = this.activeResize;
        this.leftPanel.classList.remove('resizing');
        this.rightPanel.classList.remove('resizing');
        window.removeEventListener('pointermove', this.handlePointerMove);
        window.removeEventListener('pointerup', this.handlePointerUp);
        window.removeEventListener('pointercancel', this.handlePointerUp);
        handle.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
        if (handle.hasPointerCapture?.(this.activeResize.pointerId)) {
            handle.releasePointerCapture(this.activeResize.pointerId);
        }

        this.activeResize = null;
        this.pendingResizeClientX = null;
        document.body.classList.remove('split-resizing');
        document.body.style.cursor = 'default';
    }

    applyResponsiveState() {
        const nextCompact = window.innerWidth <= this.compactBreakpoint;
        const nextViewportMode = window.innerWidth <= this.mobileBreakpoint ? 'mobile' : nextCompact ? 'tablet' : 'desktop';
        const changed = this.isCompact !== nextCompact;
        const modeChanged = this.viewportMode !== nextViewportMode;
        this.isCompact = nextCompact;
        this.viewportMode = nextViewportMode;
        document.body.classList.toggle('compact-layout', this.isCompact);
        document.body.classList.toggle('tablet-layout', this.viewportMode === 'tablet');
        document.body.classList.toggle('mobile-layout', this.viewportMode === 'mobile');
        document.body.classList.toggle('desktop-layout', this.viewportMode === 'desktop');
        document.body.dataset.viewport = this.viewportMode;

        if (!changed && !modeChanged) return;

        if (this.isCompact) {
            this.setLeftCollapsed(true);
            this.setRightCollapsed(true);
        } else if (this.viewportMode === 'tablet') {
            this.setPanelWidth('left', this.resolvePresetWidth('left', this.panelPresets.left?.[this.panelPresetIndex.left] ?? '36vw'));
            this.setPanelWidth('right', this.resolvePresetWidth('right', this.panelPresets.right?.[this.panelPresetIndex.right] ?? '40vw'));
        }
    }

    isCompactLayout() {
        return this.isCompact;
    }

    isLeftCollapsed() {
        return this.leftPanel.classList.contains('collapsed');
    }

    isRightCollapsed() {
        return this.rightPanel.classList.contains('collapsed');
    }

    syncResizerAvailability(panel, collapsed) {
        const resizer = panel === 'left' ? this.resizerLeft : this.resizerRight;
        resizer.classList.toggle('resizer-disabled', collapsed);
        resizer.setAttribute('aria-hidden', String(collapsed));

        if (collapsed && this.activeResize?.panel === panel) {
            this.stopActiveResize();
        }
    }

    setLeftCollapsed(collapsed) {
        this.leftPanel.classList.toggle('collapsed', collapsed);
        this.syncResizerAvailability('left', collapsed);
        this.emitPanelState('left', !collapsed);
    }

    setRightCollapsed(collapsed) {
        this.rightPanel.classList.toggle('collapsed', collapsed);
        this.syncResizerAvailability('right', collapsed);
        this.emitPanelState('right', !collapsed);
    }

    emitPanelState(panel, open) {
        window.dispatchEvent(new CustomEvent(APP_EVENTS.LAYOUT_PANEL_TOGGLED, {
            detail: {
                panel,
                open,
                compact: this.isCompact
            }
        }));
    }

    closeAll() {
        this.setLeftCollapsed(true);
        this.setRightCollapsed(true);
    }

    toggleLeft() {
        const willOpen = this.isLeftCollapsed();
        if (this.isCompact && willOpen) {
            this.setRightCollapsed(true);
        }
        this.setLeftCollapsed(!willOpen);
    }

    toggleRight() {
        const willOpen = this.isRightCollapsed();
        if (this.isCompact && willOpen) {
            this.setLeftCollapsed(true);
        }
        this.setRightCollapsed(!willOpen);
    }
}
