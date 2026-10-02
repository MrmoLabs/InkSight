import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeProjectSnapshot } from './inksight-runtime-project-io.js';
import { INKSIGHT_PROJECT_KIND, INKSIGHT_PROJECT_VERSION } from './inksight-project-bundle.js';
import { DRAWNIX_FILE_VERSION } from './inksight-file-types.js';

const makeManifest = (version = INKSIGHT_PROJECT_VERSION) => ({
    kind: INKSIGHT_PROJECT_KIND,
    version,
    payload: {
        type: 'drawnix',
        version: DRAWNIX_FILE_VERSION,
        elements: [{ id: 'recovered-node' }],
        viewport: { zoom: 1 }
    },
    assets: [],
    documents: []
});

describe('loadRuntimeProjectSnapshot', () => {
    const originalElectronApi = window.electronAPI;

    afterEach(() => {
        window.electronAPI = originalElectronApi;
    });

    it('falls back to the newest retained valid snapshot when the current manifest is unsupported', async () => {
        window.electronAPI = {
            loadRuntimeProject: vi.fn(async ({ snapshotId }) => ({
                success: true,
                snapshotId: snapshotId || 'latest',
                manifest: snapshotId ? makeManifest() : makeManifest(99),
                files: []
            })),
            listRuntimeProjectSnapshots: vi.fn().mockResolvedValue({
                success: true,
                snapshots: [{ snapshotId: 'previous-valid' }]
            })
        };

        const result = await loadRuntimeProjectSnapshot({
            runtimeIdentity: { projectId: 'project-1' }
        });

        expect(result.payload.elements).toEqual([{ id: 'recovered-node' }]);
        expect(result.recoveredFromHistory).toBe(true);
        expect(window.electronAPI.loadRuntimeProject).toHaveBeenNthCalledWith(2, {
            projectId: 'project-1',
            snapshotId: 'previous-valid'
        });
    });
});
