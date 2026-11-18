// Real Chromium/IndexedDB acceptance check. Uses a hidden, isolated Electron
// profile and an ephemeral localhost origin; never opens a user's workspace.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profileRoot = path.join(root, '.runtime', 'storage-browser-smoke');
if (!process.versions.electron) {
    fs.mkdirSync(profileRoot, { recursive: true });
    const profile = fs.mkdtempSync(path.join(profileRoot, 'run-'));
    const { spawnSync } = require('node:child_process');
    let status = 1;
    try {
        const child = spawnSync(require('electron'), [__filename, profile], { stdio: 'inherit', timeout: 120000 });
        if (child.error) throw child.error;
        status = child.status ?? 1;
    } finally {
        // Delete only this run's resolved profile, after Chromium has exited
        // and released its file locks. Never accumulate large test databases.
        const resolved = fs.realpathSync(profile);
        if (path.dirname(resolved) !== fs.realpathSync(profileRoot)) throw new Error('Unexpected test profile path');
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    process.exit(status);
}
const { app, BrowserWindow } = require('electron');
const profile = path.resolve(process.argv[2]);
if (path.dirname(profile) !== profileRoot || !path.basename(profile).startsWith('run-')) throw new Error('Unexpected test profile path');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();

const sources = new Map([
    'src/core/document-history-idb.js',
    'src/core/document-history-ipc.js',
    'src/core/logger.js',
    'src/inksight-file/inksight-runtime-project-io.js',
    'src/inksight-file/inksight-file-snapshot.js',
    'src/inksight-file/inksight-file-types.js',
    'src/inksight-file/inksight-project-bundle.js',
    'src/mindmap/viewport-state.js',
    'src/mindmap/graph-view/graph-nodes-store.js'
].map((source) => [`/${source}`, source]));
const server = http.createServer((request, response) => {
    const source = sources.get(request.url);
    response.setHeader('Cache-Control', 'no-store');
    if (source) {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(fs.readFileSync(path.join(root, source)));
    } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>Isolated storage acceptance</title>');
    } else {
        response.writeHead(404).end();
    }
});

async function checkStorage() {
    const assert = (value, message) => { if (!value) throw new Error(message); };
    const requestResult = (request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const bytes = new Uint8Array(32 * 1024 * 1024);
    bytes[0] = 42;
    bytes[bytes.length - 1] = 99;
    const source = new File([bytes], 'large.pdf', { type: 'application/pdf' });
    let reads = 0;
    const read = source.arrayBuffer.bind(source);
    source.arrayBuffer = () => { reads++; return read(); };
    const meta = { snapshotId: 'legacy', projectId: 'smoke', savedAt: '2025-01-01' };
    const legacy = {
        meta, manifest: { payload: { elements: [] } }, assetEntries: [],
        documentEntries: [{ path: 'documents/large.pdf', bytes, size: bytes.length, mimeType: 'application/pdf' }]
    };
    const opening = indexedDB.open('inksight-runtime', 1);
    opening.onupgradeneeded = () => {
        for (const store of ['files', 'md5-index', 'runtime-snapshots']) opening.result.createObjectStore(store);
    };
    const oldDb = await requestResult(opening);
    await new Promise((resolve, reject) => {
        const tx = oldDb.transaction('runtime-snapshots', 'readwrite');
        tx.objectStore('runtime-snapshots').put(legacy, 'history:legacy');
        tx.objectStore('runtime-snapshots').put(legacy, 'current:smoke');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
    });
    oldDb.close();

    const { createIdbFallbackIpc } = await import('/src/core/document-history-idb.js');
    const ipc = createIdbFallbackIpc();
    assert((await ipc.listRuntimeProjectSnapshots()).snapshots.length === 1, 'v1 history index');
    assert((await ipc.loadRuntimeProject({ projectId: 'smoke' })).success, 'v1 restore');
    for (let i = 0; i < 21; i++) {
        const result = await ipc.saveRuntimeProject({
            projectId: 'smoke', projectName: 'Large-file test',
            manifest: { payload: { elements: [{ id: `revision-${i}` }] } },
            documentEntries: [{ path: 'documents/large.pdf', blob: source, size: source.size, mimeType: source.type }]
        });
        assert(result.success, result.error || 'snapshot save');
    }
    assert(reads === 1, `Immutable file read ${reads} times`);
    const db = await requestResult(indexedDB.open('inksight-runtime'));
    const metadata = await requestResult(db.transaction('snapshot-meta').objectStore('snapshot-meta').getAll());
    const binaryCount = await requestResult(db.transaction('snapshot-binaries').objectStore('snapshot-binaries').count());
    const records = await requestResult(db.transaction('runtime-snapshots').objectStore('runtime-snapshots').getAll());
    db.close();
    assert(metadata.length === 20, '20 retained snapshots');
    assert(metadata.every((entry) => !entry.legacy), 'legacy compaction');
    assert(binaryCount === 1, 'one shared binary');
    assert(records.filter((entry) => entry.manifest).every((entry) => entry.documentEntries.every((file) => !file.bytes && !file.blob)), 'reference-only snapshots');
    const { saveRuntimeProjectSnapshot } = await import('/src/inksight-file/inksight-runtime-project-io.js');
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG0cAAAAASUVORK5CYII=';
    const saved = await saveRuntimeProjectSnapshot({
        runtimeIdentity: { projectId: 'io-smoke' },
        board: { children: [{ id: 'image', type: 'image', url: image }], viewport: { zoom: 1 } },
        projectFiles: [{ id: 'book', name: 'large.pdf', type: source.type, fileObj: source }]
    });
    assert(saved.success, saved.error || 'full runtime IO save');
    assert(reads === 1, 'runtime IO must retain immutable File identity');
    return { snapshots: metadata.length, binaryCount, binaryBytes: source.size, fileReads: reads };
}

async function checkReload() {
    const { createIdbFallbackIpc } = await import('/src/core/document-history-idb.js');
    const result = await createIdbFallbackIpc().loadRuntimeProject({ projectId: 'smoke' });
    if (!result.success) throw new Error(result.error);
    const blob = result.files[0].blob;
    const first = new Uint8Array(await blob.slice(0, 1).arrayBuffer())[0];
    const last = new Uint8Array(await blob.slice(-1).arrayBuffer())[0];
    if (blob.size !== 32 * 1024 * 1024 || first !== 42 || last !== 99) throw new Error('Reloaded file contents differ');
    const { loadRuntimeProjectSnapshot } = await import('/src/inksight-file/inksight-runtime-project-io.js');
    const project = await loadRuntimeProjectSnapshot({ runtimeIdentity: { projectId: 'io-smoke' } });
    if (project.projectFiles?.[0]?.fileObj?.size !== blob.size) throw new Error('Full runtime IO document restore');
    const image = await fetch(project.payload.elements[0].url).then((response) => response.blob());
    if (image.type !== 'image/png' || image.size !== 68) throw new Error('Full runtime IO image restore');
    project.cleanup();
    return { restoredAfterReload: true, firstByte: first, lastByte: last, fullProjectRestore: true };
}

app.whenReady().then(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const url = `http://127.0.0.1:${server.address().port}/`;
    await win.loadURL(url);
    const saved = await win.webContents.executeJavaScript(`(${checkStorage.toString()})()`);
    await win.loadURL(url);
    const restored = await win.webContents.executeJavaScript(`(${checkReload.toString()})()`);
    console.log(JSON.stringify({ ...saved, ...restored }));
    win.destroy();
    server.close();
    app.quit();
}).catch((error) => {
    console.error(error);
    server.close();
    app.exit(1);
});
