import { createLogger } from './logger.js';

const logger = createLogger('DocumentHistoryIdb');

const DB_NAME = 'inksight-runtime';
const DB_VERSION = 2;
const STORE_FILES = 'files';
const STORE_MD5_INDEX = 'md5-index';
const STORE_SNAPSHOTS = 'runtime-snapshots';
const STORE_META = 'snapshot-meta';
const STORE_BINARIES = 'snapshot-binaries';
const SNAPSHOT_HISTORY_LIMIT = 20;
const binaryHashes = new WeakMap();

function createSnapshotId(projectName) {
    const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 10);
    return `${Date.now()}-${slugify(projectName)}-${suffix}`;
}

/**
 * Extract the book md5 from an auto-save payload so findSaveByMd5 can
 * discover the file later. Exported for testing.
 */
export function extractMd5FromContent(content) {
    try {
        const parsed = JSON.parse(content);
        return parsed?.bookMd5 || parsed?.md5 || null;
    } catch {
        return null;
    }
}

function slugify(value, fallback = 'workspace') {
    const slug = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || fallback;
}

function openDb() {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB is not available'));
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_FILES)) {
                db.createObjectStore(STORE_FILES);
            }
            if (!db.objectStoreNames.contains(STORE_MD5_INDEX)) {
                db.createObjectStore(STORE_MD5_INDEX);
            }
            if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
                db.createObjectStore(STORE_SNAPSHOTS);
            }
            if (!db.objectStoreNames.contains(STORE_BINARIES)) {
                db.createObjectStore(STORE_BINARIES);
            }
            if (!db.objectStoreNames.contains(STORE_META)) {
                const metadata = db.createObjectStore(STORE_META);
                // Index v1 snapshots one at a time, without async hashing in the
                // upgrade transaction. Normalize old inline current entries too.
                const snapshots = request.transaction.objectStore(STORE_SNAPSHOTS);
                const cursor = snapshots.openCursor();
                cursor.onsuccess = () => {
                    const row = cursor.result;
                    if (!row) return;
                    if (row.value?.meta?.snapshotId) {
                        const { meta } = row.value;
                        const recordKey = `history:${meta.snapshotId}`;
                        const canonical = row.key === recordKey;
                        if (String(row.key).startsWith('current:')) {
                            const oldRecord = row.value;
                            const history = snapshots.get(recordKey);
                            history.onsuccess = () => {
                                if (!history.result) snapshots.put(oldRecord, recordKey);
                                snapshots.put({ snapshotId: meta.snapshotId, projectId: meta.projectId }, row.key);
                            };
                        }
                        const existing = metadata.get(meta.snapshotId);
                        existing.onsuccess = () => {
                            if (canonical || !existing.result) {
                                metadata.put({ ...meta, recordKey: String(row.key).startsWith('current:') ? recordKey : row.key, legacy: true }, meta.snapshotId);
                            }
                        };
                    }
                    row.continue();
                };
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStores(storeNames, mode, run) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeNames, mode);
            let result;
            try {
                result = run(tx);
            } catch (error) {
                tx.abort();
                reject(error);
                return;
            }
            tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

const withStore = (storeName, mode, run) => withStores([storeName], mode, (tx) => run(tx.objectStore(storeName)));

const idbGet = (storeName, key) => withStore(storeName, 'readonly', (store) => store.get(key));
const idbPut = (storeName, key, value) => withStore(storeName, 'readwrite', (store) => store.put(value, key));
const idbGetAll = (storeName) => withStore(storeName, 'readonly', (store) => store.getAll());

async function prepareEntries(entries) {
    const references = [];
    const binaries = new Map();
    for (const entry of entries) {
        const source = entry.blob || entry.bytes;
        if (!source) throw new Error(`Missing binary content: ${entry.path}`);
        // Only immutable Blobs/Files are cached. Typed arrays may be mutated.
        const immutable = typeof source.arrayBuffer === 'function';
        let hash = immutable ? binaryHashes.get(source) : null;
        if (!hash) {
            const buffer = immutable ? await source.arrayBuffer() : source;
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
            if (immutable) binaryHashes.set(source, hash);
        }
        const { bytes, blob, ...reference } = entry;
        references.push({ ...reference, binaryKey: hash });
        // Normalize legacy typed arrays too: reading shared Blobs does not
        // allocate a fresh full byte array for each snapshot reference.
        binaries.set(hash, immutable ? source : new Blob([source]));
    }
    return { references, binaries };
}

// All writes, retention and orphan removal share one transaction. Failed saves
// cannot remove the previous recoverable snapshot or its file contents.
async function writeSnapshot(record, binaries, { makeCurrent = false, legacyKey = null } = {}) {
    const { meta } = record;
    const binaryKeys = [...new Set([...record.assetEntries, ...record.documentEntries].map((entry) => entry.binaryKey))];
    await withStores([STORE_SNAPSHOTS, STORE_META, STORE_BINARIES], 'readwrite', (tx) => {
        const snapshots = tx.objectStore(STORE_SNAPSHOTS);
        const metadata = tx.objectStore(STORE_META);
        const files = tx.objectStore(STORE_BINARIES);
        // Another tab may have pruned a legacy snapshot while it was hashed.
        const guard = legacyKey ? metadata.get(meta.snapshotId) : null;
        const write = () => {
            if (guard && (!guard.result?.legacy || guard.result.recordKey !== legacyKey)) return;
            for (const [key, source] of binaries) {
                const exists = files.getKey(key);
                exists.onsuccess = () => {
                    if (exists.result === undefined) files.put(source, key);
                };
            }
            const recordKey = `history:${meta.snapshotId}`;
            snapshots.put(record, recordKey);
            metadata.put({ ...meta, recordKey, binaryKeys }, meta.snapshotId);
            if (makeCurrent) snapshots.put({ snapshotId: meta.snapshotId, projectId: meta.projectId }, `current:${meta.projectId || 'default'}`);
            if (legacyKey && legacyKey !== recordKey) {
                // Old current entries contained an extra full copy.
                snapshots.put({ snapshotId: meta.snapshotId, projectId: meta.projectId }, legacyKey);
            }
            if (!makeCurrent) {
                const currentKey = `current:${meta.projectId || 'default'}`;
                const current = snapshots.get(currentKey);
                current.onsuccess = () => {
                    if (current.result?.meta?.snapshotId === meta.snapshotId) {
                        snapshots.put({ snapshotId: meta.snapshotId, projectId: meta.projectId }, currentKey);
                    }
                };
            }
            const request = metadata.getAll();
            request.onsuccess = () => {
                const all = request.result;
                const history = all.filter((item) => item.projectId === meta.projectId)
                    .sort((a, b) => {
                        if (makeCurrent && a.snapshotId === meta.snapshotId) return -1;
                        if (makeCurrent && b.snapshotId === meta.snapshotId) return 1;
                        return String(b.savedAt).localeCompare(String(a.savedAt)) || String(b.snapshotId).localeCompare(String(a.snapshotId));
                    });
                // Migration must not reorder/prune history or advance current.
                const expired = makeCurrent ? history.slice(SNAPSHOT_HISTORY_LIMIT) : [];
                const removed = new Set(expired.map((item) => item.snapshotId));
                for (const item of expired) {
                    snapshots.delete(item.recordKey);
                    metadata.delete(item.snapshotId);
                }
                const used = new Set(all.filter((item) => !removed.has(item.snapshotId)).flatMap((item) => item.binaryKeys || []));
                const cursor = files.openKeyCursor();
                cursor.onsuccess = () => {
                    const row = cursor.result;
                    if (!row) return;
                    if (!used.has(row.key)) files.delete(row.key);
                    row.continue();
                };
            };
        };
        if (guard) guard.onsuccess = write;
        else write();
    });
}

async function compactLegacySnapshots() {
    const metadata = await idbGetAll(STORE_META);
    // Release each old full record before loading the next. Each replacement
    // commits independently so interrupted migrations resume on the next save.
    for (const item of metadata.filter((entry) => entry.legacy)) {
        try {
            const record = await idbGet(STORE_SNAPSHOTS, item.recordKey);
            if (!record?.manifest) continue;
            const assets = await prepareEntries(record.assetEntries || []);
            const documents = await prepareEntries(record.documentEntries || []);
            await writeSnapshot({ ...record, assetEntries: assets.references, documentEntries: documents.references },
                new Map([...assets.binaries, ...documents.binaries]), { legacyKey: item.recordKey });
        } catch (error) {
            logger.warn(`Legacy snapshot ${item.snapshotId} was retained for a later migration retry`, error);
        }
        // Yield between records so migration does not monopolize the page.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

async function readSnapshot(recordKey) {
    // Read the selected body and its binaries in one transaction so concurrent
    // saves in another tab cannot prune its files halfway through restoration.
    const result = await withStores([STORE_SNAPSHOTS, STORE_BINARIES], 'readonly', (tx) => {
        const value = { record: null, files: [], error: null };
        const request = tx.objectStore(STORE_SNAPSHOTS).get(recordKey);
        request.onsuccess = () => {
            value.record = request.result;
            const entries = [...(value.record?.assetEntries || []), ...(value.record?.documentEntries || [])];
            entries.forEach((entry, index) => {
                if (!entry.binaryKey) {
                    value.files[index] = entry; // Unconverted v1 snapshots.
                    return;
                }
                const binary = tx.objectStore(STORE_BINARIES).get(entry.binaryKey);
                binary.onsuccess = () => {
                    const content = binary.result;
                    if (!content) value.error = `Missing snapshot binary: ${entry.path}`;
                    else value.files[index] = { ...entry, ...(typeof content.arrayBuffer === 'function' ? { blob: content } : { bytes: content }) };
                };
            });
        };
        return value;
    });
    if (result.error) throw new Error(result.error);
    return result;
}

/**
 * IndexedDB-backed replacement for the Electron document-history IPC.
 * Gives the pure-browser build a real persistence backend so auto-save,
 * runtime snapshots and MD5 recovery work without Electron.
 */
export function createIdbFallbackIpc() {
    return {
        storageType: 'indexeddb',

        async saveFile(filename, content) {
            try {
                const md5 = extractMd5FromContent(content);
                const savedAt = new Date().toISOString();
                await idbPut(STORE_FILES, filename, { content, md5, savedAt });
                if (md5) {
                    await idbPut(STORE_MD5_INDEX, md5, { filename, savedAt });
                }
                return { success: true, path: `indexeddb://${filename}` };
            } catch (error) {
                logger.error('saveFile failed', error);
                return { success: false, error: error.message };
            }
        },

        async loadFile(filename) {
            try {
                const record = await idbGet(STORE_FILES, filename);
                if (!record) {
                    return { success: false, error: `No saved file: ${filename}` };
                }
                return { success: true, content: record.content, path: `indexeddb://${filename}` };
            } catch (error) {
                logger.error('loadFile failed', error);
                return { success: false, error: error.message };
            }
        },

        async ensureSaveDir() {
            return { success: true, path: 'indexeddb://' };
        },

        async findSaveByMd5(md5) {
            try {
                const record = await idbGet(STORE_MD5_INDEX, md5);
                if (record?.filename) {
                    return { success: true, filename: record.filename };
                }
                return { success: false };
            } catch (error) {
                logger.error('findSaveByMd5 failed', error);
                return { success: false, error: error.message };
            }
        },

        async getRuntimeStorageInfo() {
            return {
                rootPath: 'IndexedDB (browser local)',
                mode: 'indexeddb',
                storageType: 'indexeddb'
            };
        },

        async saveRuntimeProject(payload = {}) {
            try {
                const { projectName, note, manifest, assetEntries = [], documentEntries = [] } = payload;
                const savedAt = new Date().toISOString();
                const snapshotId = createSnapshotId(projectName);
                const meta = {
                    userId: payload.userId || null,
                    sessionId: payload.sessionId || null,
                    projectId: payload.projectId || null,
                    projectName: projectName || 'workspace',
                    note: note || null,
                    savedAt,
                    snapshotId,
                    bookName: manifest?.payload?.bookName || manifest?.payload?.bookId || 'Workspace',
                    elementCount: Array.isArray(manifest?.payload?.elements) ? manifest.payload.elements.length : 0,
                    cardCount: Array.isArray(manifest?.payload?.cards) ? manifest.payload.cards.length : 0,
                    highlightCount: Array.isArray(manifest?.payload?.highlights) ? manifest.payload.highlights.length : 0,
                    documentCount: documentEntries.length
                };
                const assets = await prepareEntries(assetEntries);
                const documents = await prepareEntries(documentEntries);
                const record = { meta, manifest, assetEntries: assets.references, documentEntries: documents.references };
                await writeSnapshot(record, new Map([...assets.binaries, ...documents.binaries]), { makeCurrent: true });
                try {
                    await compactLegacySnapshots();
                } catch (error) {
                    // New snapshot is committed; keep any unconverted records
                    // recoverable and retry migration on a later successful save.
                    logger.warn('Legacy snapshot compaction deferred', error);
                }

                return {
                    success: true,
                    projectDir: 'indexeddb://runtime',
                    manifestPath: `indexeddb://runtime/${snapshotId}/manifest`,
                    metaPath: `indexeddb://runtime/${snapshotId}/meta`,
                    savedAt: meta.savedAt,
                    mode: 'indexeddb',
                    snapshotId,
                    summary: {
                        assetCount: assetEntries.length,
                        documentCount: documentEntries.length
                    }
                };
            } catch (error) {
                logger.error('saveRuntimeProject failed', error);
                return { success: false, error: error.message };
            }
        },

        async listRuntimeProjectSnapshots(payload = {}) {
            try {
                const identity = payload.runtimeIdentity || payload;
                const records = await idbGetAll(STORE_META);

                return {
                    success: true,
                    snapshots: records
                        .filter((meta) => !identity?.projectId || meta.projectId === identity.projectId)
                        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
                        .slice(0, SNAPSHOT_HISTORY_LIMIT)
                        .map(({ recordKey, binaryKeys, legacy, ...meta }) => meta)
                };
            } catch (error) {
                logger.error('listRuntimeProjectSnapshots failed', error);
                return { success: true, snapshots: [] };
            }
        },

        async loadRuntimeProject(payload = {}) {
            try {
                const identity = payload.runtimeIdentity || payload;
                let record;
                let files = [];
                let hadCurrentPointer = false;
                if (payload.snapshotId) {
                    const meta = await idbGet(STORE_META, payload.snapshotId);
                    ({ record, files } = await readSnapshot(meta?.recordKey || `history:${payload.snapshotId}`));
                    if (!record) {
                        return { success: false, notFound: true, error: 'No runtime snapshot found' };
                    }
                } else {
                    record = await idbGet(STORE_SNAPSHOTS, `current:${identity?.projectId || 'default'}`);
                    hadCurrentPointer = Boolean(record);
                    if (record?.snapshotId) {
                        const snapshot = await readSnapshot(`history:${record.snapshotId}`);
                        record = snapshot.record?.manifest ? snapshot.record : null;
                        files = snapshot.files;
                    }
                    if (!record?.manifest) {
                        const records = await idbGetAll(STORE_META);
                        const latest = records
                            .filter((item) => !identity?.projectId || item.projectId === identity.projectId)
                            .sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)))[0];
                        if (latest) ({ record, files } = await readSnapshot(latest.recordKey));
                    }
                }
                if (!record?.manifest) {
                    const hasProjectRecords = (await idbGetAll(STORE_META)).some((item) => (
                        !identity?.projectId || item.projectId === identity.projectId
                    ));
                    return {
                        success: false,
                        notFound: !hadCurrentPointer && !hasProjectRecords,
                        error: 'No valid runtime snapshot found'
                    };
                }
                return {
                    success: true,
                    manifest: record.manifest,
                    meta: record.meta,
                    files
                };
            } catch (error) {
                logger.error('loadRuntimeProject failed', error);
                return { success: false, error: error.message };
            }
        }
    };
}
