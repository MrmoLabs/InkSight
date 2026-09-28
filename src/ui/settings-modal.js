import { themeManager } from '../core/theme-manager.js';
import { preferencesManager } from '../core/preferences-manager.js';
import { aiConfigManager } from '../core/ai-config-manager.js';
import { chatComplete } from '../core/ai-client.js';
import { modalManager } from './modal-manager.js';
import { emitAppNotification } from './app-notifications.js';
import { resetWorkspace } from '../app/workspace-reset.js';
import { getLocale, setLocale, supportedLocales, t } from '../i18n/index.js';

const THEME_OPTIONS = [
    { value: 'default', labelKey: 'theme.default' },
    { value: 'colorful', labelKey: 'theme.colorful' },
    { value: 'soft', labelKey: 'theme.soft' },
    { value: 'retro', labelKey: 'theme.retro' },
    { value: 'dark', labelKey: 'theme.dark' },
    { value: 'starry', labelKey: 'theme.starry' }
];

const SETTINGS_SECTIONS = [
    { key: 'appearance', labelKey: 'settings.appearance' },
    { key: 'reading', labelKey: 'settings.reading' },
    { key: 'ai', labelKey: 'settings.ai' },
    { key: 'workspace', labelKey: 'settings.workspace' }
];

/**
 * Standalone settings dialog with a sidebar layout: nav on the left,
 * one page per section on the right. Uses the same modal CSS classes as
 * ModalManager but keeps its own overlay so confirm/prompt content can
 * never clobber the settings form.
 */
class SettingsModal {
    constructor() {
        this.isVisible = false;
        this.activeSection = 'appearance';
        this._resetArmed = false;
        this._resetTimer = null;
        this.createModal();
    }

    createModal() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';

        this.content = document.createElement('div');
        this.content.className = 'modal-content settings-modal';

        this.closeBtn = document.createElement('button');
        this.closeBtn.className = 'modal-close';
        this.closeBtn.innerHTML = '&times;';
        this.closeBtn.onclick = () => this.hide();

        this.layout = document.createElement('div');
        this.layout.className = 'settings-modal__layout';

        this.sidebar = document.createElement('nav');
        this.sidebar.className = 'settings-modal__sidebar';

        const sidebarTitle = document.createElement('div');
        sidebarTitle.className = 'settings-modal__sidebar-title';
        sidebarTitle.dataset.i18n = 'settings.title';
        sidebarTitle.textContent = t('settings.title');
        this.sidebar.appendChild(sidebarTitle);

        this.navButtons = new Map();
        SETTINGS_SECTIONS.forEach(({ key, labelKey }) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'settings-modal__nav-item';
            item.dataset.i18n = labelKey;
            item.textContent = t(labelKey);
            item.dataset.section = key;
            item.onclick = () => this.setActiveSection(key);
            this.sidebar.appendChild(item);
            this.navButtons.set(key, item);
        });

        this.pages = document.createElement('div');
        this.pages.className = 'settings-modal__pages';
        this.pageMap = new Map();

        const sectionBuilders = {
            appearance: () => this.buildAppearanceSection(),
            reading: () => this.buildReadingSection(),
            ai: () => this.buildAiSection(),
            workspace: () => this.buildWorkspaceSection()
        };

        SETTINGS_SECTIONS.forEach(({ key }) => {
            const page = document.createElement('div');
            page.className = 'settings-modal__page';
            page.dataset.section = key;
            page.appendChild(sectionBuilders[key]());
            this.pages.appendChild(page);
            this.pageMap.set(key, page);
        });

        const actions = document.createElement('div');
        actions.className = 'modal-actions settings-modal__actions';

        this.resetBtn = document.createElement('button');
        this.resetBtn.type = 'button';
        this.resetBtn.className = 'modal-btn';
        this.resetBtn.dataset.i18n = 'settings.restoreDefaults';
        this.resetBtn.textContent = t('settings.restoreDefaults');
        this.resetBtn.onclick = () => this.handleReset();

        const closeActionBtn = document.createElement('button');
        closeActionBtn.type = 'button';
        closeActionBtn.className = 'modal-btn modal-btn-primary';
        closeActionBtn.dataset.i18n = 'common.close';
        closeActionBtn.textContent = t('common.close');
        closeActionBtn.onclick = () => this.hide();

        actions.appendChild(this.resetBtn);
        actions.appendChild(closeActionBtn);

        this.main = document.createElement('div');
        this.main.className = 'settings-modal__main';
        this.main.appendChild(this.pages);
        this.main.appendChild(actions);

        this.layout.appendChild(this.sidebar);
        this.layout.appendChild(this.main);

        this.content.appendChild(this.closeBtn);
        this.content.appendChild(this.layout);
        this.overlay.appendChild(this.content);
        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.hide();
            }
        });

        document.addEventListener('keydown', (e) => {
            // 确认/输入弹窗打开时让它优先处理 Escape，避免一并关闭设置弹窗
            if (e.key === 'Escape' && this.isVisible && !modalManager.isVisible) {
                this.hide();
            }
        });

        this.setActiveSection('appearance');
    }

    setActiveSection(key) {
        this.activeSection = key;
        this.navButtons.forEach((btn, btnKey) => {
            btn.classList.toggle('active', btnKey === key);
        });
        this.pageMap.forEach((page, pageKey) => {
            page.classList.toggle('active', pageKey === key);
        });
    }

    buildAppearanceSection() {
        const section = document.createElement('div');
        section.className = 'settings-modal__group';

        const heading = document.createElement('h4');
        heading.className = 'settings-modal__group-title';
        heading.dataset.i18n = 'settings.appearance';
        heading.textContent = t('settings.appearance');
        section.appendChild(heading);

        const row = document.createElement('div');
        row.className = 'settings-modal__row';

        const label = document.createElement('label');
        label.className = 'settings-modal__label';
        label.dataset.i18n = 'settings.theme';
        label.textContent = t('settings.theme');

        this.themeSelect = document.createElement('select');
        this.themeSelect.className = 'settings-modal__select';
        this.themeSelect.setAttribute('aria-label', t('settings.theme'));
        this.themeSelect.dataset.i18nAriaLabel = 'settings.theme';
        THEME_OPTIONS.forEach(({ value, labelKey }) => {
            const option = document.createElement('option');
            option.value = value;
            option.dataset.i18n = labelKey;
            option.textContent = t(labelKey);
            this.themeSelect.appendChild(option);
        });
        this.themeSelect.value = themeManager.getTheme();
        this.themeSelect.addEventListener('change', () => {
            themeManager.setTheme(this.themeSelect.value);
        });

        row.appendChild(label);
        row.appendChild(this.themeSelect);
        section.appendChild(row);

        const languageRow = document.createElement('div');
        languageRow.className = 'settings-modal__row settings-modal__row--tall';
        const languageLabel = document.createElement('label');
        languageLabel.className = 'settings-modal__label';
        languageLabel.dataset.i18n = 'settings.language';
        languageLabel.textContent = t('settings.language');
        this.languageSelect = document.createElement('select');
        this.languageSelect.className = 'settings-modal__select';
        this.languageSelect.setAttribute('aria-label', t('settings.language'));
        this.languageSelect.dataset.i18nAriaLabel = 'settings.language';
        supportedLocales.forEach((locale) => {
            const option = document.createElement('option');
            option.value = locale;
            option.dataset.i18n = `language.${locale}`;
            option.textContent = t(`language.${locale}`);
            this.languageSelect.appendChild(option);
        });
        this.languageSelect.value = getLocale();
        this.languageSelect.addEventListener('change', () => setLocale(this.languageSelect.value));
        languageRow.appendChild(languageLabel);
        languageRow.appendChild(this.languageSelect);
        section.appendChild(languageRow);

        const languageHint = document.createElement('p');
        languageHint.className = 'settings-modal__hint';
        languageHint.dataset.i18n = 'settings.languageHint';
        languageHint.textContent = t('settings.languageHint');
        section.appendChild(languageHint);
        return section;
    }

    buildReadingSection() {
        const section = document.createElement('div');
        section.className = 'settings-modal__group';

        const heading = document.createElement('h4');
        heading.className = 'settings-modal__group-title';
        heading.dataset.i18n = 'settings.reading';
        heading.textContent = t('settings.reading');
        section.appendChild(heading);

        const limits = preferencesManager.getLimits();
        const prefs = preferencesManager.get();

        this.fontSizeSlider = this.buildSliderRow(section, {
            label: t('settings.fontSize'),
            labelKey: 'settings.fontSize',
            min: limits.fontSize.min,
            max: limits.fontSize.max,
            step: 1,
            value: prefs.fontSize,
            format: (v) => `${v}px`,
            onChange: (value) => preferencesManager.set({ fontSize: value })
        });

        this.lineHeightSlider = this.buildSliderRow(section, {
            label: t('settings.lineHeight'),
            labelKey: 'settings.lineHeight',
            min: limits.lineHeight.min,
            max: limits.lineHeight.max,
            step: 0.1,
            value: prefs.lineHeight,
            format: (v) => v.toFixed(1),
            onChange: (value) => preferencesManager.set({ lineHeight: value })
        });

        return section;
    }

    buildSliderRow(container, { label, labelKey, min, max, step, value, format, onChange }) {
        const row = document.createElement('div');
        row.className = 'settings-modal__row';

        const labelEl = document.createElement('label');
        labelEl.className = 'settings-modal__label';
        labelEl.textContent = label;
        if (labelKey) labelEl.dataset.i18n = labelKey;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'settings-modal__slider';
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider.setAttribute('aria-label', label);

        const valueEl = document.createElement('span');
        valueEl.className = 'settings-modal__value';
        valueEl.textContent = format(Number(value));

        slider.addEventListener('input', () => {
            const next = Number(slider.value);
            valueEl.textContent = format(next);
            onChange(next);
        });

        row.appendChild(labelEl);
        row.appendChild(slider);
        row.appendChild(valueEl);
        container.appendChild(row);

        return slider;
    }

    buildWorkspaceSection() {
        const section = document.createElement('div');
        section.className = 'settings-modal__group';

        const heading = document.createElement('h4');
        heading.className = 'settings-modal__group-title';
        heading.dataset.i18n = 'settings.workspace';
        heading.textContent = t('settings.workspace');
        section.appendChild(heading);

        const hint = document.createElement('p');
        hint.className = 'settings-modal__hint';
        hint.dataset.i18n = 'workspace.clearHint';
        hint.textContent = t('workspace.clearHint');
        section.appendChild(hint);

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'modal-btn modal-btn-primary danger';
        resetBtn.dataset.i18n = 'workspace.clear';
        resetBtn.textContent = t('workspace.clear');
        resetBtn.onclick = () => this.handleWorkspaceReset();
        section.appendChild(resetBtn);

        return section;
    }

    async handleWorkspaceReset() {
        const confirmed = await modalManager.confirm({
            title: t('workspace.clearTitle'),
            message: t('workspace.clearMessage'),
            confirmLabel: t('workspace.clearAll'),
            cancelLabel: t('common.cancel'),
            danger: true
        });
        if (!confirmed) {
            return;
        }

        try {
            resetWorkspace();
            emitAppNotification({ message: t('workspace.cleared'), level: 'success' });
            setTimeout(() => window.location.reload(), 800);
        } catch (error) {
            emitAppNotification({ message: t('workspace.clearFailed', { message: error.message }), level: 'error' });
        }
    }

    buildAiSection() {
        const presets = aiConfigManager.getPresets();
        const config = aiConfigManager.get();
        const section = document.createElement('div');
        section.className = 'settings-modal__group';

        const heading = document.createElement('h4');
        heading.className = 'settings-modal__group-title';
        heading.dataset.i18n = 'settings.ai';
        heading.textContent = t('settings.ai');
        section.appendChild(heading);

        const buildRow = (labelText, control, labelKey = '') => {
            const row = document.createElement('div');
            row.className = 'settings-modal__row';
            const label = document.createElement('label');
            label.className = 'settings-modal__label';
            label.textContent = labelText;
            if (labelKey) label.dataset.i18n = labelKey;
            row.appendChild(label);
            row.appendChild(control);
            section.appendChild(row);
            return row;
        };

        const buildInput = (placeholder, type = 'text', placeholderKey = '') => {
            const input = document.createElement('input');
            input.type = type;
            input.className = 'settings-modal__input';
            input.placeholder = placeholder;
            if (placeholderKey) input.dataset.i18nPlaceholder = placeholderKey;
            input.spellcheck = false;
            return input;
        };

        // 厂商预设
        this.aiProviderSelect = document.createElement('select');
        this.aiProviderSelect.className = 'settings-modal__select';
        Object.entries(presets).forEach(([value, preset]) => {
            const option = document.createElement('option');
            option.value = value;
            option.dataset.i18n = preset.labelKey;
            option.textContent = t(preset.labelKey);
            this.aiProviderSelect.appendChild(option);
        });
        this.aiProviderSelect.value = config.provider;
        buildRow(t('ai.provider'), this.aiProviderSelect, 'ai.provider').classList.add('settings-modal__row--tall');
        this.aiProviderSelect.addEventListener('change', () => {
            const next = aiConfigManager.set({ provider: this.aiProviderSelect.value });
            this.syncAiSection(next);
        });

        // 接口协议（自定义时可改）
        this.aiProtocolSelect = document.createElement('select');
        this.aiProtocolSelect.className = 'settings-modal__select';
        [
            { value: 'openai', labelKey: 'ai.protocol.openai' },
            { value: 'anthropic', labelKey: 'ai.protocol.anthropic' },
            { value: 'gemini', labelKey: 'ai.protocol.gemini' }
        ].forEach(({ value, labelKey }) => {
            const option = document.createElement('option');
            option.value = value;
            option.dataset.i18n = labelKey;
            option.textContent = t(labelKey);
            this.aiProtocolSelect.appendChild(option);
        });
        buildRow(t('ai.protocol'), this.aiProtocolSelect, 'ai.protocol').classList.add('settings-modal__row--tall');
        this.aiProtocolSelect.addEventListener('change', () => {
            aiConfigManager.set({ protocol: this.aiProtocolSelect.value });
        });

        // Base URL
        this.aiBaseUrlInput = buildInput(t('ai.urlPlaceholder'), 'text', 'ai.urlPlaceholder');
        this.aiBaseUrlInput.value = config.baseUrl;
        buildRow(t('ai.address'), this.aiBaseUrlInput, 'ai.address').classList.add('settings-modal__row--tall');
        this.aiBaseUrlInput.addEventListener('change', () => {
            aiConfigManager.set({ baseUrl: this.aiBaseUrlInput.value });
        });

        // API Key
        this.aiApiKeyInput = buildInput(t('ai.keyPlaceholder'), 'password', 'ai.keyPlaceholder');
        this.aiApiKeyInput.value = config.apiKey;
        this.aiApiKeyInput.autocomplete = 'off';
        buildRow('API Key', this.aiApiKeyInput).classList.add('settings-modal__row--tall');
        this.aiApiKeyInput.addEventListener('change', () => {
            aiConfigManager.set({ apiKey: this.aiApiKeyInput.value });
        });

        // Browser builds let users choose convenience or session-only storage.
        // Electron always routes the key through the OS-backed secure store.
        const storageRow = document.createElement('div');
        storageRow.className = 'settings-modal__key-storage';
        if (aiConfigManager.usesSecureStorage()) {
            const secureHint = document.createElement('p');
            secureHint.className = 'settings-modal__hint';
            secureHint.dataset.i18n = 'ai.secureStorageHint';
            secureHint.textContent = t('ai.secureStorageHint');
            storageRow.appendChild(secureHint);
        } else {
            const rememberLabel = document.createElement('label');
            rememberLabel.className = 'settings-modal__checkbox-label';
            this.aiRememberKeyInput = document.createElement('input');
            this.aiRememberKeyInput.type = 'checkbox';
            this.aiRememberKeyInput.checked = config.rememberApiKey;
            this.aiRememberKeyInput.addEventListener('change', () => {
                aiConfigManager.set({ rememberApiKey: this.aiRememberKeyInput.checked });
            });
            const rememberText = document.createElement('span');
            rememberText.dataset.i18n = 'ai.rememberKey';
            rememberText.textContent = t('ai.rememberKey');
            rememberLabel.append(this.aiRememberKeyInput, rememberText);
            storageRow.appendChild(rememberLabel);

            const storageHint = document.createElement('p');
            storageHint.className = 'settings-modal__hint';
            storageHint.dataset.i18n = 'ai.rememberKeyHint';
            storageHint.textContent = t('ai.rememberKeyHint');
            storageRow.appendChild(storageHint);
        }

        this.aiClearKeyBtn = document.createElement('button');
        this.aiClearKeyBtn.type = 'button';
        this.aiClearKeyBtn.className = 'modal-btn settings-modal__clear-key';
        this.aiClearKeyBtn.dataset.i18n = 'ai.clearKey';
        this.aiClearKeyBtn.textContent = t('ai.clearKey');
        this.aiClearKeyBtn.disabled = !config.apiKey;
        this.aiClearKeyBtn.addEventListener('click', () => {
            const next = aiConfigManager.clearApiKey();
            this.syncAiSection(next);
            emitAppNotification({ message: t('ai.keyCleared'), level: 'success' });
        });
        storageRow.appendChild(this.aiClearKeyBtn);
        section.appendChild(storageRow);

        // 模型名
        this.aiModelInput = buildInput(t('ai.modelPlaceholder'), 'text', 'ai.modelPlaceholder');
        this.aiModelInput.value = config.model;
        buildRow(t('ai.model'), this.aiModelInput, 'ai.model').classList.add('settings-modal__row--tall');
        this.aiModelInput.addEventListener('change', () => {
            aiConfigManager.set({ model: this.aiModelInput.value });
        });

        // 测试连接
        const testRow = document.createElement('div');
        testRow.className = 'settings-modal__row';
        this.aiTestBtn = document.createElement('button');
        this.aiTestBtn.type = 'button';
        this.aiTestBtn.className = 'modal-btn';
        this.aiTestBtn.dataset.i18n = 'ai.test';
        this.aiTestBtn.textContent = t('ai.test');
        this.aiTestBtn.onclick = () => this.handleAiTest();
        testRow.appendChild(this.aiTestBtn);
        // 结果内联显示在弹窗内：全局通知会被设置弹窗的遮罩挡住
        this.aiTestStatus = document.createElement('span');
        this.aiTestStatus.className = 'settings-modal__test-status';
        testRow.appendChild(this.aiTestStatus);
        section.appendChild(testRow);

        return section;
    }

    syncAiSection(config) {
        if (this.aiProviderSelect) this.aiProviderSelect.value = config.provider;
        if (this.aiProtocolSelect) this.aiProtocolSelect.value = config.protocol;
        if (this.aiBaseUrlInput) this.aiBaseUrlInput.value = config.baseUrl;
        if (this.aiApiKeyInput) this.aiApiKeyInput.value = config.apiKey;
        if (this.aiRememberKeyInput) this.aiRememberKeyInput.checked = config.rememberApiKey;
        if (this.aiClearKeyBtn) this.aiClearKeyBtn.disabled = !config.apiKey;
        if (this.aiModelInput) this.aiModelInput.value = config.model;
    }

    setAiTestStatus(message, state = '') {
        if (!this.aiTestStatus) {
            return;
        }
        this.aiTestStatus.textContent = message;
        this.aiTestStatus.classList.remove('is-pending', 'is-success', 'is-error');
        if (state) {
            this.aiTestStatus.classList.add(state);
        }
    }

    async handleAiTest() {
        const config = aiConfigManager.get();
        if (!config.baseUrl || !config.apiKey || !config.model) {
            this.setAiTestStatus(t('ai.incomplete'), 'is-error');
            return;
        }

        this.aiTestBtn.disabled = true;
        this.aiTestBtn.textContent = t('ai.testing');
        this.setAiTestStatus(t('ai.connecting'), 'is-pending');
        try {
            const reply = await chatComplete(config, {
                system: t('ai.testSystem'),
                messages: [{ role: 'user', content: 'ping' }]
            });
            this.setAiTestStatus(t('ai.success', { reply: reply.slice(0, 40) }), 'is-success');
        } catch (error) {
            this.setAiTestStatus(t('ai.failed', { message: error.message }), 'is-error');
        } finally {
            this.aiTestBtn.disabled = false;
            this.aiTestBtn.textContent = t('ai.test');
        }
    }

    handleReset() {
        if (!this._resetArmed) {
            this._resetArmed = true;
            this.resetBtn.textContent = t('settings.confirmRestore');
            this.resetBtn.classList.add('danger');
            this._resetTimer = setTimeout(() => this.disarmReset(), 3000);
            return;
        }

        this.disarmReset();
        preferencesManager.reset();
        this.syncFromPreferences();
    }

    disarmReset() {
        this._resetArmed = false;
        clearTimeout(this._resetTimer);
        this._resetTimer = null;
        this.resetBtn.textContent = t('settings.restoreDefaults');
        this.resetBtn.classList.remove('danger');
    }

    syncFromPreferences() {
        const prefs = preferencesManager.get();
        if (this.fontSizeSlider) {
            this.fontSizeSlider.value = prefs.fontSize;
            this.fontSizeSlider.dispatchEvent(new Event('input'));
        }
        if (this.lineHeightSlider) {
            this.lineHeightSlider.value = prefs.lineHeight;
            this.lineHeightSlider.dispatchEvent(new Event('input'));
        }
    }

    open() {
        this.themeSelect.value = themeManager.getTheme();
        this.languageSelect.value = getLocale();
        this.syncFromPreferences();
        this.disarmReset();
        this.show();
    }

    show() {
        this.isVisible = true;
        this.overlay.classList.add('active');
    }

    hide() {
        this.isVisible = false;
        this.overlay.classList.remove('active');
        this.disarmReset();
    }
}

export const settingsModal = new SettingsModal();
