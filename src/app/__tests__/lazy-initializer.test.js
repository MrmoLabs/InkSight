import { describe, expect, it, vi } from 'vitest';
import { createLazyInitializer } from '../lazy-initializer.js';

describe('createLazyInitializer', () => {
    it('starts on first use and shares its initialization promise', async () => {
        const value = {};
        const initialize = vi.fn(async () => value);
        const getValue = createLazyInitializer(initialize);

        expect(initialize).not.toHaveBeenCalled();
        const first = getValue();
        const second = getValue();
        expect(first).toBe(second);
        await expect(first).resolves.toBe(value);
        await expect(getValue()).resolves.toBe(value);
        expect(initialize).toHaveBeenCalledTimes(1);
    });

    it('allows retry when initialization fails', async () => {
        const initialize = vi.fn()
            .mockRejectedValueOnce(new Error('load failed'))
            .mockResolvedValueOnce('ready');
        const getValue = createLazyInitializer(initialize);

        await expect(getValue()).rejects.toThrow('load failed');
        await expect(getValue()).resolves.toBe('ready');
        expect(initialize).toHaveBeenCalledTimes(2);
    });
});
