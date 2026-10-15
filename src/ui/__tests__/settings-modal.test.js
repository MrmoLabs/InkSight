import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsModal } from '../settings-modal.js';
import { themeManager } from '../../core/theme-manager.js';
import { preferencesManager, DEFAULT_PREFERENCES } from '../../core/preferences-manager.js';
import { aiConfigManager } from '../../core/ai-config-manager.js';
import { getLocale, normalizeLocale, setLocale, t } from '../../i18n/index.js';
import { modalManager } from '../modal-manager.js';
import { resetWorkspace } from '../../app/workspace-reset.js';
import { emitAppNotification } from '../app-notifications.js';

vi.mock('../../app/workspace-reset.js', () => ({ resetWorkspace: vi.fn() }));
vi.mock('../app-notifications.js', () => ({ emitAppNotification: vi.fn() }));

describe('settings restore defaults', () => {
    let scheduleTimeout;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        resetWorkspace.mockResolvedValue(undefined);
        settingsModal.hide();
        modalManager.hide();
        document.body.append(settingsModal.overlay, modalManager.overlay);
        themeManager.setTheme('default');
        preferencesManager.reset();
        setLocale(normalizeLocale(navigator.language));
        themeManager.setTheme('colorful');
        setLocale('zh-CN');
        preferencesManager.set({ fontSize: 23, lineHeight: 2 });
        aiConfigManager.set({ provider: 'openai' });
        settingsModal.open();
        scheduleTimeout = vi.spyOn(globalThis, 'setTimeout');
    });

    afterEach(() => {
        modalManager.hide();
        settingsModal.hide();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('opens a destructive confirmation without changing the workspace or settings', () => {
        settingsModal.resetBtn.click();

        expect(modalManager.isVisible).toBe(true);
        expect(modalManager.body.querySelector('h3')).toHaveTextContent(t('settings.restoreTitle'));
        expect(modalManager.body.querySelector('p')).toHaveTextContent(t('settings.restoreMessage'));
        expect(modalManager.body.querySelector('.danger')).toHaveTextContent(t('settings.restoreConfirm'));
        expect(resetWorkspace).not.toHaveBeenCalled();
        expect(themeManager.getTheme()).toBe('colorful');
        expect(preferencesManager.get()).toEqual({ fontSize: 23, lineHeight: 2 });
    });

    it.each(['cancel', 'Escape', 'backdrop'])('preserves settings and workspace on %s', async (dismissal) => {
        const aiConfig = aiConfigManager.get();
        const resetting = settingsModal.handleReset();
        if (dismissal === 'cancel') {
            modalManager.body.querySelector('.modal-btn:not(.modal-btn-primary)').click();
        } else if (dismissal === 'Escape') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } else {
            modalManager.overlay.click();
        }
        await resetting;

        expect(resetWorkspace).not.toHaveBeenCalled();
        expect(themeManager.getTheme()).toBe('colorful');
        expect(getLocale()).toBe('zh-CN');
        expect(preferencesManager.get()).toEqual({ fontSize: 23, lineHeight: 2 });
        expect(aiConfigManager.get()).toEqual(aiConfig);
        expect(emitAppNotification).not.toHaveBeenCalled();
        expect(scheduleTimeout).not.toHaveBeenCalledWith(expect.any(Function), 800);
    });

    it('waits for the confirmed workspace reset before restoring settings and preserves AI config', async () => {
        let finishReset;
        resetWorkspace.mockReturnValue(new Promise((resolve) => { finishReset = resolve; }));
        const aiConfig = aiConfigManager.get();
        const resetting = settingsModal.handleReset();
        modalManager.body.querySelector('.modal-btn-primary').click();
        await Promise.resolve();

        expect(resetWorkspace).toHaveBeenCalledTimes(1);
        expect(themeManager.getTheme()).toBe('colorful');
        expect(preferencesManager.get()).toEqual({ fontSize: 23, lineHeight: 2 });
        finishReset();
        await resetting;

        expect(themeManager.getTheme()).toBe('default');
        expect(getLocale()).toBe(normalizeLocale(navigator.language));
        expect(preferencesManager.get()).toEqual(DEFAULT_PREFERENCES);
        expect(settingsModal.themeSelect.value).toBe('default');
        expect(settingsModal.languageSelect.value).toBe(getLocale());
        expect(settingsModal.fontSizeSlider.value).toBe(String(DEFAULT_PREFERENCES.fontSize));
        expect(settingsModal.lineHeightSlider.value).toBe(String(DEFAULT_PREFERENCES.lineHeight));
        expect(settingsModal.resetStatus.textContent).toBe(t('settings.restored'));
        expect(aiConfigManager.get()).toEqual(aiConfig);
        expect(emitAppNotification).toHaveBeenCalledWith({ message: t('settings.restored'), level: 'success' });
        expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 800);
    });

    it('reports a reset failure without restoring settings or scheduling a reload', async () => {
        resetWorkspace.mockRejectedValue(new Error('Reset failed'));
        const resetting = settingsModal.handleReset();
        modalManager.body.querySelector('.modal-btn-primary').click();
        await resetting;

        expect(themeManager.getTheme()).toBe('colorful');
        expect(getLocale()).toBe('zh-CN');
        expect(preferencesManager.get()).toEqual({ fontSize: 23, lineHeight: 2 });
        expect(emitAppNotification).toHaveBeenCalledWith({
            message: t('workspace.clearFailed', { message: 'Reset failed' }),
            level: 'error'
        });
        expect(scheduleTimeout).not.toHaveBeenCalledWith(expect.any(Function), 800);
    });
});
