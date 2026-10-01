const AI_CONFIG_FIELDS = ['provider', 'protocol', 'baseUrl', 'apiKey', 'model'];

const sanitizeAiConfig = (value) => {
    const source = value && typeof value === 'object' ? value : {};
    const config = {};
    for (const field of AI_CONFIG_FIELDS) {
        config[field] = typeof source[field] === 'string' ? source[field] : '';
    }
    return config;
};

const readAiConfigFile = (raw, safeStorage) => {
    if (!safeStorage.isEncryptionAvailable()) {
        return {
            config: sanitizeAiConfig(JSON.parse(raw.toString('utf-8'))),
            encrypted: false,
            migrationBytes: null
        };
    }

    try {
        return {
            config: sanitizeAiConfig(JSON.parse(safeStorage.decryptString(raw))),
            encrypted: true,
            migrationBytes: null
        };
    } catch (decryptError) {
        let legacyConfig;
        try {
            legacyConfig = sanitizeAiConfig(JSON.parse(raw.toString('utf-8')));
        } catch {
            throw decryptError;
        }

        return {
            config: legacyConfig,
            encrypted: true,
            migrationBytes: safeStorage.encryptString(JSON.stringify(legacyConfig))
        };
    }
};

const buildAiConfigWrite = (value, safeStorage) => {
    const config = sanitizeAiConfig(value);
    const encrypted = safeStorage.isEncryptionAvailable();
    if (!encrypted && config.apiKey) {
        return {
            success: false,
            encrypted: false,
            persisted: false,
            error: 'OS encryption is unavailable; API keys are kept for this session only.'
        };
    }

    const json = JSON.stringify(config);
    return {
        success: true,
        encrypted,
        persisted: true,
        apiKeyPersisted: encrypted && Boolean(config.apiKey),
        bytes: encrypted ? safeStorage.encryptString(json) : Buffer.from(json, 'utf-8')
    };
};

module.exports = {
    buildAiConfigWrite,
    readAiConfigFile,
    sanitizeAiConfig
};
