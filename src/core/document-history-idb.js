import { createLogger } from './logger.js';

const logger = createLogger('DocumentHistoryIdb');

const DB_NAME = 'inksight-runtime';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_MD5_INDEX = 'md5-index';
const STORE_SNAPSHOTS = 'runtime-snapshots';
const SNAPSHOT_HISTORY_LIMIT = 20;

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
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore(storeName, mode, run) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            try {
                result = run(store);
            } catch (error) {
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

const idbGet = (storeName, key) => withStore(storeName, 'readonly', (store) => store.get(key));
const idbPut = (storeName, key, value) => withStore(storeName, 'readwrite', (store) => store.put(value, key));
const idbGetAll = (storeName) => withStore(storeName, 'readonly', (store) => store.getAll());

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
                const record = { meta, manifest, assetEntries, documentEntries, identity: meta };

                const projectKey = meta.projectId || 'default';
                await withStore(STORE_SNAPSHOTS, 'readwrite', (store) => {
                    // Keep the full (potentially large) snapshot once. The current
                    // workspace entry is only a pointer into history.
                    store.put(record, `history:${snapshotId}`);
                    store.put({ snapshotId, projectId: meta.projectId }, `current:${projectKey}`);

                    // Prune within the same transaction so the configured history
                    // limit also bounds IndexedDB usage, rather than only the UI.
                    const request = store.getAll();
                    request.onsuccess = () => {
                        const history = request.result
                            .filter((item) => item?.meta?.snapshotId && item.meta.projectId === meta.projectId)
                            .sort((left, right) => {
                                if (left.meta.snapshotId === snapshotId) return -1;
                                if (right.meta.snapshotId === snapshotId) return 1;
                                return String(right.meta.savedAt).localeCompare(String(left.meta.savedAt));
                            });
                        history.slice(SNAPSHOT_HISTORY_LIMIT).forEach((item) => {
                            store.delete(`history:${item.meta.snapshotId}`);
                        });
                    };
                });

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
                const records = await idbGetAll(STORE_SNAPSHOTS);
                const uniqueSnapshots = new Map();
                records
                    .filter((record) => record?.meta?.snapshotId)
                    .filter((record) => !identity?.projectId || record.meta.projectId === identity.projectId)
                    .forEach((record) => {
                        if (!uniqueSnapshots.has(record.meta.snapshotId)) {
                            uniqueSnapshots.set(record.meta.snapshotId, record.meta);
                        }
                    });

                return {
                    success: true,
                    snapshots: [...uniqueSnapshots.values()]
                        .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)))
                        .slice(0, SNAPSHOT_HISTORY_LIMIT)
                        .map((meta) => ({ ...meta }))
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
                let hadCurrentPointer = false;
                if (payload.snapshotId) {
                    record = await idbGet(STORE_SNAPSHOTS, `history:${payload.snapshotId}`);
                    if (!record) {
                        return { success: false, notFound: true, error: 'No runtime snapshot found' };
                    }
                } else {
                    record = await idbGet(STORE_SNAPSHOTS, `current:${identity?.projectId || 'default'}`);
                    hadCurrentPointer = Boolean(record);
                    if (record?.snapshotId) {
                        const snapshot = await idbGet(STORE_SNAPSHOTS, `history:${record.snapshotId}`);
                        record = snapshot?.manifest ? snapshot : null;
                    }
                    if (!record?.manifest) {
                        const records = await idbGetAll(STORE_SNAPSHOTS);
                        record = records
                            .filter((item) => item?.meta?.snapshotId)
                            .filter((item) => !identity?.projectId || item.meta.projectId === identity.projectId)
                            .sort((left, right) => String(right.meta.savedAt).localeCompare(String(left.meta.savedAt)))[0];
                    }
                }
                if (!record?.manifest) {
                    const hasProjectRecords = (await idbGetAll(STORE_SNAPSHOTS)).some((item) => (
                        item?.meta?.snapshotId
                        && (!identity?.projectId || item.meta.projectId === identity.projectId)
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
                    files: [...(record.assetEntries || []), ...(record.documentEntries || [])]
                };
            } catch (error) {
                logger.error('loadRuntimeProject failed', error);
                return { success: false, error: error.message };
            }
        }
    };
}
