import { describe, expect, it } from 'vitest';
import { encryptProjectRevision } from '../encrypted-revision.js';
import { syncProject } from '../sync-engine.js';

const passphrase = 'correct horse battery staple';

function createProvider() {
    const revisions = new Map();
    const heads = new Map();
    return {
        revisions,
        heads,
        async getHead(projectId) { return heads.get(projectId) ?? null; },
        async getRevision(projectId, revisionId) { return revisions.get(`${projectId}:${revisionId}`) ?? null; },
        async putRevision(projectId, revision) {
            const key = `${projectId}:${revision.revisionId}`;
            if (revisions.has(key)) throw new Error('Immutable revision already exists.');
            revisions.set(key, revision);
        },
        async compareAndSwapHead(projectId, expected, next) {
            if ((heads.get(projectId) ?? null) !== expected) return false;
            heads.set(projectId, next);
            return true;
        }
    };
}

function createLocalStore(state) {
    return {
        state,
        conflicts: [],
        async read() { return { ...state }; },
        async setCursor(_projectId, cursor) { state.cursor = cursor; state.dirty = false; },
        async importSnapshot(_projectId, snapshot) { state.snapshot = snapshot; state.dirty = false; },
        async saveConflictCopy(_projectId, snapshot, revisionId) { this.conflicts.push({ snapshot, revisionId }); }
    };
}

describe('syncProject', () => {
    it('pushes an encrypted immutable revision with an atomic head update', async () => {
        const provider = createProvider();
        const localStore = createLocalStore({ snapshot: { notes: ['private'] }, cursor: null, dirty: true });
        const result = await syncProject({
            projectId: 'project-1', provider, localStore, passphrase,
            idFactory: () => 'revision-1', createdAt: () => '2026-10-01T00:00:00.000Z'
        });

        expect(result).toEqual({ status: 'pushed', revisionId: 'revision-1' });
        expect(provider.heads.get('project-1')).toBe('revision-1');
        expect(localStore.state).toMatchObject({ cursor: 'revision-1', dirty: false });
        expect(JSON.stringify(provider.revisions.get('project-1:revision-1'))).not.toContain('private');
    });

    it('pulls a remote revision into an empty local store', async () => {
        const provider = createProvider();
        const revision = await encryptProjectRevision({
            projectId: 'project-1', revisionId: 'remote-1', payload: { notes: ['remote'] }, passphrase
        });
        provider.revisions.set('project-1:remote-1', revision);
        provider.heads.set('project-1', 'remote-1');
        const localStore = createLocalStore({ snapshot: null, cursor: null, dirty: false });

        await expect(syncProject({ projectId: 'project-1', provider, localStore, passphrase }))
            .resolves.toEqual({ status: 'pulled', revisionId: 'remote-1' });
        expect(localStore.state).toMatchObject({ snapshot: { notes: ['remote'] }, cursor: 'remote-1' });
    });

    it('preserves concurrent local work as a recoverable conflict copy', async () => {
        const provider = createProvider();
        const revision = await encryptProjectRevision({
            projectId: 'project-1', revisionId: 'remote-1', payload: { notes: ['remote'] }, passphrase
        });
        provider.revisions.set('project-1:remote-1', revision);
        provider.heads.set('project-1', 'remote-1');
        const localStore = createLocalStore({ snapshot: { notes: ['local'] }, cursor: null, dirty: true });

        await expect(syncProject({ projectId: 'project-1', provider, localStore, passphrase }))
            .resolves.toEqual({ status: 'conflict', remoteRevisionId: 'remote-1' });
        expect(localStore.state.snapshot).toEqual({ notes: ['local'] });
        expect(localStore.conflicts).toEqual([{ snapshot: { notes: ['remote'] }, revisionId: 'remote-1' }]);
    });
});
