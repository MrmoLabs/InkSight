import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { buildAiConfigWrite, readAiConfigFile } = require('../ai-config-storage.cjs');

function createSafeStorage({ available = true } = {}) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
        decryptString: vi.fn((value) => {
            const content = value.toString('utf-8');
            if (!content.startsWith('encrypted:')) {
                throw new Error('not encrypted');
            }
            return content.slice('encrypted:'.length);
        })
    };
}

describe('Electron AI config storage', () => {
    it('refuses to persist a non-empty API key without OS encryption', () => {
        const result = buildAiConfigWrite({ provider: 'custom', apiKey: 'secret' }, createSafeStorage({ available: false }));

        expect(result).toMatchObject({ success: false, encrypted: false, persisted: false });
        expect(result.bytes).toBeUndefined();
    });

    it('stores non-secret AI settings when OS encryption is unavailable', () => {
        const result = buildAiConfigWrite({ provider: 'custom', baseUrl: 'https://api.example', apiKey: '' }, createSafeStorage({ available: false }));

        expect(result).toMatchObject({ success: true, encrypted: false, apiKeyPersisted: false });
        expect(JSON.parse(result.bytes.toString('utf-8'))).toMatchObject({ provider: 'custom', apiKey: '' });
    });

    it('migrates a legacy plaintext config to encrypted bytes when encryption becomes available', () => {
        const safeStorage = createSafeStorage();
        const legacy = Buffer.from(JSON.stringify({ provider: 'custom', apiKey: 'legacy-key', ignored: 'value' }), 'utf-8');

        const result = readAiConfigFile(legacy, safeStorage);

        expect(result.config).toMatchObject({ provider: 'custom', apiKey: 'legacy-key' });
        expect(result.encrypted).toBe(true);
        expect(result.migrationBytes.toString('utf-8')).toContain('encrypted:');
        expect(safeStorage.decryptString).toHaveBeenCalledOnce();
    });

    it('reads an encrypted config without rewriting it', () => {
        const safeStorage = createSafeStorage();
        const encrypted = safeStorage.encryptString(JSON.stringify({ provider: 'openai', apiKey: 'stored-key' }));

        const result = readAiConfigFile(encrypted, safeStorage);

        expect(result.config).toMatchObject({ provider: 'openai', apiKey: 'stored-key' });
        expect(result.migrationBytes).toBeNull();
    });
});
