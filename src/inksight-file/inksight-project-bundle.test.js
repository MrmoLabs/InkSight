import { describe, expect, it, vi } from 'vitest';
import { hydrateProjectData, INKSIGHT_PROJECT_KIND, INKSIGHT_PROJECT_VERSION } from './inksight-project-bundle.js';
import { DRAWNIX_FILE_VERSION } from './inksight-file-types.js';

describe('hydrateProjectData', () => {
    it('rejects incomplete or truncated project assets before returning hydrated state', async () => {
        const manifest = {
            kind: INKSIGHT_PROJECT_KIND,
            version: INKSIGHT_PROJECT_VERSION,
            payload: {
                type: 'drawnix',
                version: DRAWNIX_FILE_VERSION,
                viewport: { zoom: 1 },
                elements: [{ id: 'image-1', type: 'image', url: 'assets/image.png' }]
            },
            assets: [{ path: 'assets/image.png', size: 4 }],
            documents: []
        };

        await expect(hydrateProjectData({
            manifest,
            readBlob: async () => new Blob(['bad']),
            createObjectURL: vi.fn(() => 'blob:asset'),
            revokeObjectURL: vi.fn()
        })).rejects.toThrow('Invalid project asset size: assets/image.png');
    });

    it('rejects truncated project documents before exposing them as restored files', async () => {
        const manifest = {
            kind: INKSIGHT_PROJECT_KIND,
            version: INKSIGHT_PROJECT_VERSION,
            payload: { type: 'drawnix', version: DRAWNIX_FILE_VERSION, viewport: { zoom: 1 }, elements: [], documents: [] },
            assets: [],
            documents: [{ id: 'doc-1', name: 'Book.pdf', path: 'documents/book.pdf', size: 8 }]
        };

        await expect(hydrateProjectData({
            manifest,
            readBlob: async () => new Blob(['short'])
        })).rejects.toThrow('Invalid project document size: documents/book.pdf');
    });
});
