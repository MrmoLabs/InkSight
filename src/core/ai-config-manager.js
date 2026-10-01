/**
 * AIConfigManager - LLM API configuration (provider preset, endpoint, key, model).
 * Single active config. Under Electron the API key is persisted encrypted via
 * the main process (safeStorage); browser builds fall back to localStorage.
 * Same singleton pattern as PreferencesManager.
 */

const STORAGE_KEY = 'inksight:ai-config';

const PROTOCOLS = Object.freeze(['openai', 'anthropic', 'gemini']);

/**
 * Built-in provider presets. `protocol` selects the request adapter; most
 * Chinese providers expose an OpenAI-compatible chat completions endpoint.
 */
const PROVIDER_PRESETS = Object.freeze({
    deepseek: { label: 'DeepSeek', labelKey: 'ai.provider.deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
    kimi: { label: 'Kimi (Moonshot AI)', labelKey: 'ai.provider.kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    qwen: { label: 'Qwen', labelKey: 'ai.provider.qwen', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    zhipu: { label: 'Zhipu GLM', labelKey: 'ai.provider.zhipu', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
    openai: { label: 'OpenAI', labelKey: 'ai.provider.openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    openrouter: { label: 'OpenRouter', labelKey: 'ai.provider.openrouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
    anthropic: { label: 'Claude (Anthropic)', labelKey: 'ai.provider.anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514' },
    gemini: { label: 'Google Gemini', labelKey: 'ai.provider.gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
    custom: { label: 'Custom API', labelKey: 'ai.provider.custom', protocol: 'openai', baseUrl: '', model: '' }
});

const DEFAULT_CONFIG = Object.freeze({
    provider: 'deepseek',
    protocol: 'openai',
    baseUrl: PROVIDER_PRESETS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDER_PRESETS.deepseek.model,
    rememberApiKey: true
});

function sanitizeString(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function parseConfig(parsed) {
    return {
        provider: sanitizeString(parsed?.provider, DEFAULT_CONFIG.provider),
        protocol: PROTOCOLS.includes(parsed?.protocol) ? parsed.protocol : DEFAULT_CONFIG.protocol,
        baseUrl: sanitizeString(parsed?.baseUrl, DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ''),
        apiKey: sanitizeString(parsed?.apiKey),
        model: sanitizeString(parsed?.model, DEFAULT_CONFIG.model),
        // Existing browser configurations predate this preference and already
        // opted into persistence, so preserve their current behaviour.
        rememberApiKey: parsed?.rememberApiKey !== false
    };
}

class AIConfigManager {
    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.listeners = new Set();
        this.secureStorageEncryptionAvailable = null;
        this.STORAGE_KEY = STORAGE_KEY;
        this.PROVIDER_PRESETS = PROVIDER_PRESETS;
        this.PROTOCOLS = PROTOCOLS;
        this.init();
    }

    init() {
        this.config = { ...DEFAULT_CONFIG };
        this.secureStorageEncryptionAvailable = null;
        // Electron: the key is encrypted by the main process (safeStorage).
        // Browser builds keep localStorage persistence.
        this.secureStorage = Boolean(
            typeof window !== 'undefined'
            && window.electronAPI?.aiConfigLoad
            && window.electronAPI?.aiConfigSave
        );
        let storedInLocalStorage = false;
        try {
            const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(this.STORAGE_KEY) : null;
            if (stored) {
                this.config = parseConfig(JSON.parse(stored));
                storedInLocalStorage = true;
            }
        } catch {
            this.config = { ...DEFAULT_CONFIG };
        }

        if (this.secureStorage) {
            this.loadSecureConfig({ migrateFromLocalStorage: storedInLocalStorage });
        }
    }

    async loadSecureConfig({ migrateFromLocalStorage }) {
        try {
            const result = await window.electronAPI.aiConfigLoad();
            if (!result?.success) {
                return;
            }

            this.secureStorageEncryptionAvailable = result.encrypted === true;
            if (result.config) {
                this.config = parseConfig(result.config);
            }

            if (migrateFromLocalStorage && this.secureStorageEncryptionAvailable) {
                const saveResult = await window.electronAPI.aiConfigSave({ ...this.config });
                if (saveResult?.success && saveResult.encrypted) {
                    try {
                        localStorage.removeItem(this.STORAGE_KEY);
                    } catch {
                        // Non-fatal: config already lives in secure storage.
                    }
                }
            }

            this.listeners.forEach((fn) => fn(this.get()));
        } catch {
            // Keep the config loaded from localStorage, if any.
        }
    }
    get() {
        return { ...this.config };
    }

    getPresets() {
        return PROVIDER_PRESETS;
    }

    isConfigured() {
        const { baseUrl, apiKey, model } = this.config;
        return Boolean(baseUrl && apiKey && model);
    }

    usesSecureStorage() {
        return this.secureStorage;
    }

    getStorageStatus() {
        if (!this.secureStorage) {
            return 'browser';
        }
        if (this.secureStorageEncryptionAvailable === true) {
            return 'encrypted';
        }
        if (this.secureStorageEncryptionAvailable === false) {
            return 'unavailable';
        }
        return 'checking';
    }

    set(patch) {
        const next = { ...this.config };

        if (patch?.provider !== undefined && PROVIDER_PRESETS[patch.provider]) {
            next.provider = patch.provider;
            // Switching provider applies the preset defaults for unset fields.
            const preset = PROVIDER_PRESETS[patch.provider];
            next.protocol = preset.protocol;
            next.baseUrl = preset.baseUrl;
            next.model = preset.model || next.model;
        }
        if (patch?.protocol !== undefined && PROTOCOLS.includes(patch.protocol)) {
            next.protocol = patch.protocol;
        }
        if (patch?.baseUrl !== undefined) {
            next.baseUrl = sanitizeString(patch.baseUrl).replace(/\/+$/, '');
        }
        if (patch?.apiKey !== undefined) {
            next.apiKey = sanitizeString(patch.apiKey);
        }
        if (patch?.model !== undefined) {
            next.model = sanitizeString(patch.model).trim();
        }
        if (patch?.rememberApiKey !== undefined) {
            next.rememberApiKey = Boolean(patch.rememberApiKey);
        }

        const changed = Object.keys(next).some((key) => next[key] !== this.config[key]);
        if (!changed) {
            return this.get();
        }

        this.config = next;
        this.persist();
        this.listeners.forEach((fn) => fn(this.get()));
        return this.get();
    }

    persist() {
        if (this.secureStorage) {
            if (this.secureStorageEncryptionAvailable !== true && this.config.apiKey) {
                return;
            }
            if (this.secureStorageEncryptionAvailable !== true) {
                try {
                    localStorage.removeItem(this.STORAGE_KEY);
                } catch {
                    // Continue with the safe non-secret fields where possible.
                }
            }
            window.electronAPI.aiConfigSave({ ...this.config }).catch(() => {
                // Persistence failure keeps session config applied.
            });
            return;
        }
        try {
            const storedConfig = {
                ...this.config,
                apiKey: this.config.rememberApiKey ? this.config.apiKey : ''
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(storedConfig));
        } catch {
            // Ignore persistence failures — session config still applies.
        }
    }

    clearApiKey() {
        return this.set({ apiKey: '' });
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.unsubscribe(callback);
    }

    unsubscribe(callback) {
        this.listeners.delete(callback);
    }
}

export const aiConfigManager = new AIConfigManager();
export { DEFAULT_CONFIG, PROVIDER_PRESETS, PROTOCOLS };
