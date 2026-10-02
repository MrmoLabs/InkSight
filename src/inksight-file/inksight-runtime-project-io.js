import { buildInksightFilePayload } from './inksight-file-snapshot.js';
import { bundleProjectData, hydrateProjectData } from './inksight-project-bundle.js';
import { resolveDocumentHistoryIpc } from '../core/document-history-ipc.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('RuntimeProjectIO');

async function serializeBinaryEntries(entries = [], fileKey) {
    const results = [];

    for (const entry of entries) {
        const source = entry?.[fileKey];
        if (!source || typeof source.arrayBuffer !== 'function') {
            continue;
        }

        const buffer = await source.arrayBuffer();
        results.push({
            path: entry.path,
            mimeType: entry.mimeType || entry.type || source.type || 'application/octet-stream',
            size: entry.size || source.size || 0,
            lastModified: entry.lastModified || source.lastModified || 0,
            bytes: new Uint8Array(buffer)
        });
    }

    return results;
}

export async function getRuntimeStorageInfo() {
    const ipc = resolveDocumentHistoryIpc();
    if (!ipc?.getRuntimeStorageInfo) {
        return null;
    }

    return ipc.getRuntimeStorageInfo();
}

export async function listRuntimeProjectSnapshots({ runtimeIdentity = {} } = {}) {
    const ipc = resolveDocumentHistoryIpc();
    if (!ipc?.listRuntimeProjectSnapshots) {
        return null;
    }

    return ipc.listRuntimeProjectSnapshots(runtimeIdentity);
}

export async function saveRuntimeProjectSnapshot({
    board,
    appContext = {},
    projectFiles = [],
    runtimeIdentity = {},
    projectName,
    note,
    lastPage
} = {}) {
    const ipc = resolveDocumentHistoryIpc();
    if (!ipc?.saveRuntimeProject) {
        throw new Error('Runtime project storage is not available.');
    }

    const payload = buildInksightFilePayload({ appContext, board, lastPage });
    const { manifest, assetEntries, documentEntries } = await bundleProjectData({
        payload,
        projectFiles
    });

    const result = await ipc.saveRuntimeProject({
        ...runtimeIdentity,
        projectName: projectName || appContext.currentBook?.name || 'workspace',
        note: note || null,
        manifest,
        assetEntries: await serializeBinaryEntries(assetEntries, 'blob'),
        documentEntries: await serializeBinaryEntries(documentEntries, 'file')
    });

    return {
        ...result,
        manifest,
        payload: manifest.payload
    };
}

async function hydrateRuntimeSnapshotResult(result) {
    const binaryMap = new Map((result.files || []).map((entry) => [entry.path, entry]));
    const hydrated = await hydrateProjectData({
        manifest: result.manifest,
        readBlob: async (relativePath) => {
            const entry = binaryMap.get(relativePath);
            if (!entry) {
                throw new Error(`Missing runtime project file: ${relativePath}`);
            }

            return new Blob([entry.bytes], { type: entry.mimeType || 'application/octet-stream' });
        }
    });

    return {
        ...result,
        payload: hydrated.payload,
        projectFiles: hydrated.projectFiles,
        cleanup: hydrated.cleanup
    };
}

export async function loadRuntimeProjectSnapshot({ runtimeIdentity = {}, snapshotId = null } = {}) {
    const ipc = resolveDocumentHistoryIpc();
    if (!ipc?.loadRuntimeProject) {
        return { success: false, notFound: false, error: 'Runtime project storage is not available.' };
    }

    const result = await ipc.loadRuntimeProject({
        ...runtimeIdentity,
        snapshotId
    });
    if (result?.success && result?.manifest) {
        try {
            return await hydrateRuntimeSnapshotResult(result);
        } catch (error) {
            if (snapshotId) {
                throw error;
            }
            logger.warn('Latest runtime snapshot is invalid; trying retained history', error);
        }
    } else if (snapshotId || result?.notFound === true) {
        return {
            success: false,
            notFound: result?.notFound === true,
            error: result?.error || 'Runtime project could not be loaded.'
        };
    }

    if (!snapshotId && ipc.listRuntimeProjectSnapshots) {
        const historyResult = await ipc.listRuntimeProjectSnapshots(runtimeIdentity);
        const candidates = (historyResult?.snapshots || [])
            .filter((entry) => entry?.snapshotId && entry.snapshotId !== result?.snapshotId);
        for (const candidate of candidates) {
            try {
                const historySnapshot = await ipc.loadRuntimeProject({
                    ...runtimeIdentity,
                    snapshotId: candidate.snapshotId
                });
                if (historySnapshot?.success && historySnapshot.manifest) {
                    return {
                        ...await hydrateRuntimeSnapshotResult(historySnapshot),
                        recoveredFromHistory: true
                    };
                }
            } catch (error) {
                logger.warn(`Retained runtime snapshot ${candidate.snapshotId} could not be hydrated`, error);
            }
        }
    }

    return {
        success: false,
        notFound: false,
        error: result?.error || 'No valid runtime project snapshot could be recovered.'
    };
}
