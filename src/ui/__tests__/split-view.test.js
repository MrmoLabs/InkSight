import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitView } from '../split-view.js';

describe('SplitView resizer availability', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <aside id="sidebar"></aside>
            <div id="resizer-left" class="resizer"></div>
            <main id="reader"></main>
            <div id="resizer-right" class="resizer"></div>
            <aside id="notes" class="collapsed"></aside>
        `;
        document.body.className = '';
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
        Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback();
            return 1;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    });

    function createSplitView() {
        return new SplitView({
            leftId: 'sidebar',
            centerId: 'reader',
            rightId: 'notes',
            resizerLeftId: 'resizer-left',
            resizerRightId: 'resizer-right'
        });
    }

    it('hides a collapsed panel resizer and restores it when the panel opens', () => {
        const splitView = createSplitView();
        const rightResizer = document.getElementById('resizer-right');

        expect(rightResizer).toHaveClass('resizer-disabled');
        expect(rightResizer).toHaveAttribute('aria-hidden', 'true');

        splitView.setRightCollapsed(false);

        expect(rightResizer).not.toHaveClass('resizer-disabled');
        expect(rightResizer).toHaveAttribute('aria-hidden', 'false');
    });

    it('does not begin dragging from a disabled resizer', () => {
        const splitView = createSplitView();
        const rightResizer = document.getElementById('resizer-right');
        rightResizer.getBoundingClientRect = () => ({ left: 1436, width: 4 });

        rightResizer.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 1438,
            pointerId: 1,
            pointerType: 'mouse'
        }));

        expect(splitView.activeResize).toBeNull();
        expect(document.body).not.toHaveClass('split-resizing');
    });

    it('stops an active resize when its panel is collapsed', () => {
        const splitView = createSplitView();
        const leftResizer = document.getElementById('resizer-left');
        leftResizer.getBoundingClientRect = () => ({ left: 320, width: 4 });
        leftResizer.setPointerCapture = vi.fn();
        leftResizer.hasPointerCapture = vi.fn(() => false);

        leftResizer.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            clientX: 322,
            pointerId: 2,
            pointerType: 'mouse'
        }));
        expect(splitView.activeResize?.panel).toBe('left');

        splitView.setLeftCollapsed(true);

        expect(splitView.activeResize).toBeNull();
        expect(leftResizer).toHaveClass('resizer-disabled');
        expect(document.body).not.toHaveClass('split-resizing');
    });
});
