import { decryptProjectRevision, encryptProjectRevision } from './encrypted-revision.js';

function validateDependencies(provider, localStore) {
    for (const method of ['getHead', 'getRevision', 'putRevision', 'compareAndSwapHead']) {
        if (typeof provider?.[method] !== 'function') {
            throw new Error(`Sync provider is missing ${method}().`);
        }
    }
    for (const method of ['read', 'setCursor', 'importSnapshot', 'saveConflictCopy']) {
        if (typeof localStore?.[method] !== 'function') {
            throw new Error(`Local sync store is missing ${method}().`);
        }
    }
}

async function readRemoteRevision(provider, projectId, revisionId, passphrase, cryptoProvider) {
    const revision = await provider.getRevision(projectId, revisionId);
    if (!revision) throw new Error(`Remote revision ${revisionId} is missing.`);
    const snapshot = await decryptProjectRevision(revision, { projectId, passphrase, cryptoProvider });
    return { revision, snapshot };
}

/**
 * Provider contract: immutable putRevision(projectId, revision), getRevision,
 * getHead and atomic compareAndSwapHead(projectId, expected, next). Local store
 * contract: read() returns { snapshot, cursor, dirty }; cursor updates only
 * after a successful import or compare-and-swap.
 */
export async function syncProject({
    projectId,
    provider,
    localStore,
    passphrase,
    cryptoProvider = globalThis.crypto,
    idFactory = () => cryptoProvider.randomUUID(),
    createdAt = () => new Date().toISOString()
}) {
    if (!projectId) throw new Error('Project id is required.');
    validateDependencies(provider, localStore);

    const local = await localStore.read(projectId);
    const remoteHead = await provider.getHead(projectId);

    if (remoteHead && remoteHead !== local.cursor) {
        const remote = await readRemoteRevision(provider, projectId, remoteHead, passphrase, cryptoProvider);
        if (local.dirty || local.snapshot != null) {
            await localStore.saveConflictCopy(projectId, remote.snapshot, remoteHead);
            return { status: 'conflict', remoteRevisionId: remoteHead };
        }
        await localStore.importSnapshot(projectId, remote.snapshot);
        await localStore.setCursor(projectId, remoteHead);
        return { status: 'pulled', revisionId: remoteHead };
    }

    if (!remoteHead && local.cursor) {
        return { status: 'remote-reset', revisionId: local.cursor };
    }

    if (!local.dirty || local.snapshot == null) {
        return { status: remoteHead ? 'up-to-date' : 'empty' };
    }

    const revisionId = idFactory();
    const revision = await encryptProjectRevision({
        projectId,
        revisionId,
        parentRevisionId: remoteHead || null,
        payload: local.snapshot,
        passphrase,
        cryptoProvider,
        createdAt: createdAt()
    });
    await provider.putRevision(projectId, revision);

    const moved = await provider.compareAndSwapHead(projectId, remoteHead || null, revisionId);
    if (!moved) {
        const racedHead = await provider.getHead(projectId);
        if (racedHead) {
            const raced = await readRemoteRevision(provider, projectId, racedHead, passphrase, cryptoProvider);
            await localStore.saveConflictCopy(projectId, raced.snapshot, racedHead);
            return { status: 'conflict', remoteRevisionId: racedHead, uploadedRevisionId: revisionId };
        }
        return { status: 'head-changed', uploadedRevisionId: revisionId };
    }

    await localStore.setCursor(projectId, revisionId);
    return { status: 'pushed', revisionId };
}
