import { describe, expect, it, vi } from 'vitest';
import { buildReaderAiMessages, createReaderAiController } from '../reader-ai-controller.js';

function createController(overrides = {}) {
    const dependencies = {
        getPassage: vi.fn(() => ({ text: 'A selected passage', sourceName: 'Paper.pdf' })),
        aiConfigManager: {
            isConfigured: vi.fn(() => true),
            get: vi.fn(() => ({ provider: 'custom', baseUrl: 'https://ai.example/v1', model: 'reader-model', apiKey: 'secret' })),
            getPresets: vi.fn(() => ({ custom: { label: 'Custom API' } }))
        },
        chatComplete: vi.fn(async () => 'An explanation'),
        confirmSend: vi.fn(async () => true),
        showResult: vi.fn(),
        notify: vi.fn(),
        ...overrides
    };
    return { controller: createReaderAiController(dependencies), dependencies };
}

describe('reader AI controller', () => {
    it('builds a request with only the selected passage and requested action', () => {
        const messages = buildReaderAiMessages('summarize', 'Only this passage');

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ role: 'user' });
        expect(messages[0].content).toContain('Only this passage');
        expect(messages[0].content).not.toContain('Paper.pdf');
        expect(() => buildReaderAiMessages('unknown', 'text')).toThrow('Unsupported reader AI action');
    });

    it('shows the provider, endpoint, model, and exact passage before sending', async () => {
        const { controller, dependencies } = createController();

        await expect(controller.run('explain')).resolves.toBe(true);

        expect(dependencies.confirmSend).toHaveBeenCalledWith(expect.objectContaining({
            provider: 'Custom API',
            endpoint: 'https://ai.example/v1',
            model: 'reader-model',
            passage: 'A selected passage'
        }));
        expect(dependencies.chatComplete).toHaveBeenCalledWith(
            expect.objectContaining({ apiKey: 'secret' }),
            expect.objectContaining({ messages: expect.any(Array) })
        );
        expect(dependencies.showResult).toHaveBeenCalledWith(expect.objectContaining({ answer: 'An explanation' }));
    });

    it('offers source-aware save and map actions after explicit confirmation', async () => {
        const saveResult = vi.fn();
        const createMap = vi.fn();
        const { controller, dependencies } = createController({ saveResult, createMap });

        await expect(controller.run('createMap')).resolves.toBe(true);
        expect(dependencies.confirmSend).toHaveBeenCalledWith(expect.objectContaining({ passage: 'A selected passage' }));
        const result = dependencies.showResult.mock.calls[0][0];
        expect(result.passage.text).toBe('A selected passage');
        result.onSave();
        result.onCreateMap();
        expect(saveResult).toHaveBeenCalledWith(expect.objectContaining({ answer: 'An explanation' }));
        expect(createMap).toHaveBeenCalledWith(expect.objectContaining({ answer: 'An explanation' }));
    });

    it('sends nothing when the user cancels the review dialog', async () => {
        const { controller, dependencies } = createController({
            confirmSend: vi.fn(async () => false)
        });

        await expect(controller.run('summarize')).resolves.toBe(false);
        expect(dependencies.chatComplete).not.toHaveBeenCalled();
        expect(dependencies.showResult).not.toHaveBeenCalled();
    });

    it('does not send when the AI config or passage is missing', async () => {
        const unconfigured = createController({
            aiConfigManager: { isConfigured: vi.fn(() => false), get: vi.fn(), getPresets: vi.fn() }
        });
        await expect(unconfigured.controller.run('explain')).resolves.toBe(false);
        expect(unconfigured.dependencies.chatComplete).not.toHaveBeenCalled();

        const noPassage = createController({ getPassage: vi.fn(() => null) });
        await expect(noPassage.controller.run('explain')).resolves.toBe(false);
        expect(noPassage.dependencies.chatComplete).not.toHaveBeenCalled();
    });

    it('reports provider errors without exposing them as markup', async () => {
        const { controller, dependencies } = createController({
            chatComplete: vi.fn(async () => { throw new Error('network failed'); })
        });

        await expect(controller.run('explain')).resolves.toBe(false);
        expect(dependencies.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
        expect(dependencies.showResult).not.toHaveBeenCalled();
    });
});
