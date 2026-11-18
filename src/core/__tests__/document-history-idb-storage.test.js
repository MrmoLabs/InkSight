import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory, IDBRequest, IDBObjectStore } from 'fake-indexeddb';
import { createIdbFallbackIpc } from '../document-history-idb.js';

const requestResult = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

async function inspect(storeName, key) {
    const db = await requestResult(indexedDB.open('inksight-runtime'));
    try {
        const store = db.transaction(storeName).objectStore(storeName);
        return await requestResult(key === undefined ? store.getAll() : store.get(key));
    } finally {
        db.close();
    }
}

const makePayload = (projectId = 'project-a', bytes = [1, 2, 3]) => ({
    projectId,
    projectName: 'Test project',
    manifest: { payload: { elements: [{ id: 'node' }] }, documents: [], assets: [] },
    documentEntries: bytes ? [{ path: 'documents/test.pdf', mimeType: 'application/pdf', bytes: new Uint8Array(bytes), size: bytes.length }] : []
});

async function seedLegacy(records) {
    const request = indexedDB.open('inksight-runtime', 1);
    request.onupgradeneeded = () => {
        for (const name of ['files', 'md5-index', 'runtime-snapshots']) request.result.createObjectStore(name);
    };
    const db = await requestResult(request);
    await new Promise((resolve, reject) => {
        const tx = db.transaction('runtime-snapshots', 'readwrite');
        for (const [key, record] of records) tx.objectStore('runtime-snapshots').put(record, key);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
    });
    db.close();
}

describe('IndexedDB snapshot storage', () => {
    beforeEach(() => {
        vi.stubGlobal('indexedDB', new IDBFactory());
        vi.stubGlobal('IDBRequest', IDBRequest);
        vi.stubGlobal('crypto', webcrypto);
        vi.stubGlobal('Blob', NodeBlob);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('deduplicates binary contents across snapshots, projects and entry types', async () => {
        const ipc = createIdbFallbackIpc();
        const first = await ipc.saveRuntimeProject(makePayload());
        const second = makePayload('project-b');
        second.assetEntries = [{ ...second.documentEntries[0], path: 'assets/picture.png', mimeType: 'image/png' }];
        expect((await ipc.saveRuntimeProject(second)).success).toBe(true);
        expect((await inspect('snapshot-binaries')).length).toBe(1);
        const records = (await inspect('runtime-snapshots')).filter((entry) => entry.manifest);
        expect(records).toHaveLength(2);
        expect(records[0].documentEntries[0].bytes).toBeUndefined();
        const restored = await ipc.loadRuntimeProject({ snapshotId: first.snapshotId });
        expect(restored.success).toBe(true);
        expect([...new Uint8Array(await restored.files[0].blob.arrayBuffer())]).toEqual([1, 2, 3]);
        const other = await ipc.loadRuntimeProject({ projectId: 'project-b' });
        expect(other.files.map((entry) => entry.mimeType)).toEqual(['image/png', 'application/pdf']);
    });

    it('reuses immutable file hashes without rereading their contents', async () => {
        const file = new NodeBlob(['large document']);
        const read = vi.spyOn(file, 'arrayBuffer');
        const payload = makePayload();
        payload.documentEntries = [{ path: 'documents/test.pdf', blob: file, size: file.size }];
        const ipc = createIdbFallbackIpc();
        const first = await ipc.saveRuntimeProject(payload);
        expect(first.success).toBe(true);
        expect((await ipc.saveRuntimeProject(payload)).success).toBe(true);
        expect(read).toHaveBeenCalledTimes(1);
        const restored = await ipc.loadRuntimeProject({ snapshotId: first.snapshotId });
        expect(await restored.files[0].blob.text()).toBe('large document');
    });

    it('does not cache hashes of mutable byte arrays', async () => {
        const ipc = createIdbFallbackIpc();
        const payload = makePayload();
        const first = await ipc.saveRuntimeProject(payload);
        payload.documentEntries[0].bytes[0] = 9;
        expect((await ipc.saveRuntimeProject(payload)).success).toBe(true);
        expect(await inspect('snapshot-binaries')).toHaveLength(2);
        const restored = await ipc.loadRuntimeProject({ snapshotId: first.snapshotId });
        expect(new Uint8Array(await restored.files[0].blob.arrayBuffer())[0]).toBe(1);
    });

    it('retains complete file references when saves overlap across tabs', async () => {
        const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
            createIdbFallbackIpc().saveRuntimeProject(makePayload('project-a', [index]))));
        expect(results.every((result) => result.success)).toBe(true);
        const ipc = createIdbFallbackIpc();
        const { snapshots } = await ipc.listRuntimeProjectSnapshots({ projectId: 'project-a' });
        expect(snapshots).toHaveLength(20);
        for (const snapshot of snapshots) {
            const restored = await ipc.loadRuntimeProject({ snapshotId: snapshot.snapshotId });
            expect(restored.success).toBe(true);
            const index = results.findIndex((result) => result.snapshotId === snapshot.snapshotId);
            expect([...new Uint8Array(await restored.files[0].blob.arrayBuffer())]).toEqual([index]);
        }
        expect(await inspect('snapshot-binaries')).toHaveLength(20);
    });

    it('lists and prunes using metadata without bulk loading snapshot bodies or binaries', async () => {
        const original = IDBObjectStore.prototype.getAll;
        const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (...args) {
            expect(this.name).not.toBe('runtime-snapshots');
            expect(this.name).not.toBe('snapshot-binaries');
            return original.apply(this, args);
        });
        const ipc = createIdbFallbackIpc();
        expect((await ipc.saveRuntimeProject(makePayload())).success).toBe(true);
        const result = await ipc.listRuntimeProjectSnapshots({ projectId: 'project-a' });
        expect(result.snapshots).toHaveLength(1);
        expect(result.snapshots[0].binaryKeys).toBeUndefined();
        expect(reads).toHaveBeenCalled();
    });

    it('prunes history while preserving files referenced by other projects', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01'));
        const ipc = createIdbFallbackIpc();
        const old = await ipc.saveRuntimeProject(makePayload());
        await ipc.saveRuntimeProject(makePayload('project-b'));
        for (let i = 0; i < 20; i++) {
            vi.setSystemTime(Date.now() + 1000);
            expect((await ipc.saveRuntimeProject(makePayload('project-a', null))).success).toBe(true);
        }
        expect((await ipc.listRuntimeProjectSnapshots({ projectId: 'project-a' })).snapshots).toHaveLength(20);
        expect((await ipc.loadRuntimeProject({ snapshotId: old.snapshotId })).notFound).toBe(true);
        expect(await inspect('snapshot-binaries')).toHaveLength(1);
        expect((await ipc.loadRuntimeProject({ projectId: 'project-b' })).files).toHaveLength(1);
        for (let i = 0; i < 20; i++) {
            vi.setSystemTime(Date.now() + 1000);
            await ipc.saveRuntimeProject(makePayload('project-b', null));
        }
        expect(await inspect('snapshot-binaries')).toHaveLength(0);
    });

    it('atomically rolls back failed writes and retains the previous current snapshot', async () => {
        const ipc = createIdbFallbackIpc();
        const first = await ipc.saveRuntimeProject(makePayload());
        const original = IDBObjectStore.prototype.put;
        const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
            if (this.name === 'snapshot-meta') throw new DOMException('Storage full', 'QuotaExceededError');
            return original.apply(this, args);
        });
        expect((await ipc.saveRuntimeProject(makePayload('project-a', [9]))).success).toBe(false);
        write.mockRestore();
        expect((await ipc.loadRuntimeProject({ projectId: 'project-a' })).meta.snapshotId).toBe(first.snapshotId);
        expect(await inspect('snapshot-binaries')).toHaveLength(1);
        expect(await inspect('snapshot-meta')).toHaveLength(1);
    });

    it('indexes v1 history, preserves current-only saves and migrates duplicate files', async () => {
        const payload = makePayload();
        const legacy = {
            ...payload,
            meta: { projectId: 'project-a', snapshotId: 'old', savedAt: '2025-01-01' },
            assetEntries: []
        };
        const currentOnly = { ...legacy, meta: { ...legacy.meta, projectId: 'project-b', snapshotId: 'current-only' } };
        await seedLegacy([
            ['history:old', legacy], ['current:project-a', legacy], ['current:project-b', currentOnly]
        ]);
        const ipc = createIdbFallbackIpc();
        expect((await ipc.listRuntimeProjectSnapshots()).snapshots).toHaveLength(2);
        expect((await ipc.loadRuntimeProject({ projectId: 'project-b' })).meta.snapshotId).toBe('current-only');
        expect((await ipc.saveRuntimeProject(makePayload())).success).toBe(true);
        expect(await inspect('snapshot-binaries')).toHaveLength(1);
        expect((await inspect('snapshot-meta')).every((entry) => !entry.legacy)).toBe(true);
        const records = await inspect('runtime-snapshots');
        expect(records.filter((entry) => entry.meta)).toHaveLength(3);
        expect(records.filter((entry) => entry.manifest).every((entry) => !entry.documentEntries[0].bytes)).toBe(true);
        const restored = await ipc.loadRuntimeProject({ snapshotId: 'old' });
        expect([...new Uint8Array(await restored.files[0].blob.arrayBuffer())]).toEqual([1, 2, 3]);
        expect((await ipc.loadRuntimeProject({ snapshotId: 'current-only' })).success).toBe(true);
    });

    it('keeps v1 records recoverable if binary compaction fails, then retries', async () => {
        const legacy = { ...makePayload(), meta: { projectId: 'project-a', snapshotId: 'old', savedAt: '2025-01-01' }, assetEntries: [] };
        await seedLegacy([['history:old', legacy]]);
        const ipc = createIdbFallbackIpc();
        const hash = vi.spyOn(webcrypto.subtle, 'digest').mockRejectedValue(new Error('Hash unavailable'));
        expect((await ipc.saveRuntimeProject(makePayload('project-a', null))).success).toBe(true);
        expect((await ipc.loadRuntimeProject({ snapshotId: 'old' })).success).toBe(true);
        expect((await inspect('snapshot-meta', 'old')).legacy).toBe(true);
        hash.mockRestore();
        expect((await ipc.saveRuntimeProject(makePayload('project-a', null))).success).toBe(true);
        expect((await inspect('snapshot-meta', 'old')).legacy).toBeUndefined();
    });

    it('does not let a damaged legacy record block other migrations', async () => {
        const legacy = { ...makePayload(), meta: { projectId: 'project-a', snapshotId: 'valid', savedAt: '2025-01-01' }, assetEntries: [] };
        const broken = { ...legacy, meta: { ...legacy.meta, snapshotId: 'broken' }, documentEntries: [{ path: 'missing.pdf' }] };
        await seedLegacy([['history:broken', broken], ['history:valid', legacy]]);
        expect((await createIdbFallbackIpc().saveRuntimeProject(makePayload())).success).toBe(true);
        expect((await inspect('snapshot-meta', 'valid')).legacy).toBeUndefined();
        expect((await inspect('snapshot-meta', 'broken')).legacy).toBe(true);
    });

    it('keeps current protected when legacy timestamps are in the future', async () => {
        const records = Array.from({ length: 20 }, (_, index) => {
            const snapshotId = `old-${index}`;
            return [`history:${snapshotId}`, { ...makePayload(), assetEntries: [], meta: { snapshotId, projectId: 'project-a', savedAt: '2099-01-01' } }];
        });
        await seedLegacy(records);
        const ipc = createIdbFallbackIpc();
        const saved = await ipc.saveRuntimeProject(makePayload());
        expect(saved.success).toBe(true);
        expect((await ipc.loadRuntimeProject({ projectId: 'project-a' })).meta.snapshotId).toBe(saved.snapshotId);
        expect(await inspect('snapshot-meta')).toHaveLength(20);
    });
});
