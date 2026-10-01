const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { assertSafePathSegment, resolvePathWithin } = require('./path-security.cjs');
const { buildAiConfigWrite, readAiConfigFile } = require('./ai-config-storage.cjs');

const DEV_RENDERER_URL = 'http://localhost:5173/';

const isAllowedRendererUrl = (rawUrl) => {
    try {
        const url = new URL(rawUrl);
        if (!app.isPackaged) {
            return url.protocol === 'http:'
                && ['localhost', '127.0.0.1'].includes(url.hostname)
                && url.port === '5173';
        }
        return url.protocol === 'file:' && url.pathname.endsWith('/dist/index.html');
    } catch {
        return false;
    }
};

const isSafeExternalUrl = (rawUrl) => {
    try {
        return ['http:', 'https:'].includes(new URL(rawUrl).protocol);
    } catch {
        return false;
    }
};

const assertTrustedIpcEvent = (event) => {
    const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
    if (!isAllowedRendererUrl(senderUrl)) {
        throw new Error('IPC request rejected from an untrusted renderer');
    }
};

const handleTrustedIpc = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
        assertTrustedIpcEvent(event);
        return handler(event, ...args);
    });
};

function createWindow() {
    const preloadPath = path.join(__dirname, 'preload.cjs');
    console.log('[Main] Preload path:', preloadPath);
    console.log('[Main] Preload exists:', fs.existsSync(preloadPath));

    const win = new BrowserWindow({
        width: 1280,
        height: 800,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: preloadPath
        }
    });

    console.log('[Main] Window created');

    win.webContents.setVisualZoomLevelLimits(1, 1).catch((error) => {
        console.error('[Main] Failed to lock visual zoom level:', error);
    });
    win.webContents.setZoomFactor(1);
    win.webContents.on('before-input-event', (event, input) => {
        if (!(input.control || input.meta)) {
            return;
        }

        if (['+', '-', '=', '0'].includes(input.key)) {
            event.preventDefault();
        }
    });

    const isDev = !app.isPackaged;
    const entryUrl = isDev
        ? DEV_RENDERER_URL
        : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;

    win.webContents.on('will-navigate', (event, targetUrl) => {
        if (!isAllowedRendererUrl(targetUrl)) {
            event.preventDefault();
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) {
            shell.openExternal(url).catch((error) => {
                console.error('[Main] Failed to open external URL:', error);
            });
        }
        return { action: 'deny' };
    });

    win.loadURL(entryUrl);

    // Remove the default menu bar
    win.setMenu(null);
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- IPC Handlers for Auto-Save ---

const RUNTIME_PROJECT_MANIFEST = 'project.json';
const RUNTIME_PROJECT_META = 'meta.json';
const RUNTIME_PROJECT_HISTORY_DIR = 'history';
const RUNTIME_PROJECT_HISTORY_LIMIT = 10;

// Get the save directory path (Project Root/files/saves)
const getSaveDir = () => {
    if (!getSaveDir.cache) {
        // In dev: process.cwd() is project root
        // In prod: process.cwd() might be app dir.
        // User preference: "d:\Programs\Projects\InkSight\files\saves" style
        // (process.cwd()), kept whenever it is writable. When the install
        // location is read-only (e.g. Program Files), fall back to userData.
        const preferredDir = path.join(process.cwd(), 'files', 'saves');
        getSaveDir.cache = app.isPackaged && !isDirWritable(preferredDir)
            ? path.join(app.getPath('userData'), 'files', 'saves')
            : preferredDir;
    }
    return getSaveDir.cache;
};

const ensureDir = (dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
};

// Write to a sibling temp file first so a crash mid-save never leaves a
// truncated target; rename within the same directory is atomic.
const writeFileAtomic = (filePath, data) => {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            // best-effort cleanup
        }
        throw error;
    }
};

const isDirWritable = (dirPath) => {
    try {
        ensureDir(dirPath);
        const probePath = path.join(dirPath, `.write-probe-${process.pid}`);
        fs.writeFileSync(probePath, '1');
        fs.rmSync(probePath, { force: true });
        return true;
    } catch {
        return false;
    }
};

const getInstallRuntimeDir = () => {
    if (!getInstallRuntimeDir.cache) {
        const baseDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
        const installDir = path.join(baseDir, 'runtime-data');
        // Packaged installs under read-only locations (e.g. Program Files)
        // cannot persist next to the executable; route those to userData so
        // auto-save keeps working. Writable/portable installs keep the old
        // location so existing runtime data is not orphaned.
        getInstallRuntimeDir.cache = app.isPackaged && !isDirWritable(installDir)
            ? path.join(app.getPath('userData'), 'runtime-data')
            : installDir;
    }
    return getInstallRuntimeDir.cache;
};

const normalizeRuntimeSegment = (value, fallback) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const sanitized = normalized.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 80);
    return sanitized || fallback;
};

const getRuntimeProjectDir = ({ userId, sessionId, projectId }) => {
    return path.join(
        getInstallRuntimeDir(),
        'users',
        normalizeRuntimeSegment(userId, 'anonymous'),
        'sessions',
        normalizeRuntimeSegment(sessionId, 'default'),
        'projects',
        normalizeRuntimeSegment(projectId, 'workspace')
    );
};

const getRuntimeProjectHistoryDir = ({ userId, sessionId, projectId }) => {
    return path.join(getRuntimeProjectDir({ userId, sessionId, projectId }), RUNTIME_PROJECT_HISTORY_DIR);
};

const getRuntimeUserSessionsDir = (userId) => {
    return path.join(
        getInstallRuntimeDir(),
        'users',
        normalizeRuntimeSegment(userId, 'anonymous'),
        'sessions'
    );
};

const toBuffer = (value) => {
    if (Buffer.isBuffer(value)) {
        return value;
    }

    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }

    if (value instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(value));
    }

    if (Array.isArray(value)) {
        return Buffer.from(value);
    }

    throw new Error('Unsupported binary payload');
};

const writeRuntimeBinaryFile = (rootDir, relativePath, bytes) => {
    const absolutePath = resolvePathWithin(rootDir, relativePath, 'Runtime file path');
    ensureDir(path.dirname(absolutePath));
    writeFileAtomic(absolutePath, toBuffer(bytes));
};

const slugifyRuntimeName = (value, fallback) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const sanitized = normalized.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60);
    return sanitized || fallback;
};

const createSnapshotSummary = (manifest, meta = {}) => {
    const payload = manifest?.payload || {};
    return {
        projectName: meta.projectName || 'workspace',
        bookName: payload.bookName || payload.bookId || 'Workspace',
        elementCount: Array.isArray(payload.elements) ? payload.elements.length : 0,
        cardCount: Array.isArray(payload.cards) ? payload.cards.length : 0,
        highlightCount: Array.isArray(payload.highlights) ? payload.highlights.length : 0,
        documentCount: Array.isArray(payload.documents) ? payload.documents.length : 0
    };
};

const trimSnapshotHistory = (historyRoot) => {
    if (!fs.existsSync(historyRoot)) {
        return;
    }

    const snapshotDirs = fs.readdirSync(historyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
            const snapshotDir = path.join(historyRoot, entry.name);
            const metaPath = path.join(snapshotDir, RUNTIME_PROJECT_META);
            let savedAt = 0;
            if (fs.existsSync(metaPath)) {
                try {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    savedAt = Date.parse(meta.savedAt || 0) || 0;
                } catch {
                    savedAt = 0;
                }
            }
            return { snapshotDir, savedAt };
        })
        .sort((left, right) => right.savedAt - left.savedAt);

    snapshotDirs.slice(RUNTIME_PROJECT_HISTORY_LIMIT).forEach(({ snapshotDir }) => {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
    });
};

const writeRuntimeSnapshot = ({ rootDir, payload = {}, projectMeta = {}, historyMeta = null }) => {
    const { manifest, assetEntries = [], documentEntries = [] } = payload;
    const manifestPath = path.join(rootDir, RUNTIME_PROJECT_MANIFEST);
    const metaPath = path.join(rootDir, RUNTIME_PROJECT_META);

    ensureDir(rootDir);
    writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));

    for (const assetEntry of assetEntries) {
        writeRuntimeBinaryFile(rootDir, assetEntry.path, assetEntry.bytes);
    }

    for (const documentEntry of documentEntries) {
        writeRuntimeBinaryFile(rootDir, documentEntry.path, documentEntry.bytes);
    }

    cleanupRuntimeSubdir(rootDir, 'assets', assetEntries.map((entry) => entry.path));
    cleanupRuntimeSubdir(rootDir, 'documents', documentEntries.map((entry) => entry.path));

    const summary = createSnapshotSummary(manifest, projectMeta);
    const meta = {
        ...projectMeta,
        ...summary,
        ...historyMeta,
        manifest: RUNTIME_PROJECT_MANIFEST
    };
    writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));

    return {
        manifestPath,
        metaPath,
        summary,
        meta
    };
};

const listRelativeFiles = (rootDir, currentDir = rootDir) => {
    if (!fs.existsSync(currentDir)) {
        return [];
    }

    const items = fs.readdirSync(currentDir, { withFileTypes: true });
    const results = [];

    for (const item of items) {
        const absolutePath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
            results.push(...listRelativeFiles(rootDir, absolutePath));
        } else if (item.isFile()) {
            results.push(path.relative(rootDir, absolutePath).replace(/\\/g, '/'));
        }
    }

    return results;
};

const cleanupRuntimeSubdir = (projectDir, subdirName, expectedPaths) => {
    const targetDir = path.join(projectDir, subdirName);
    if (!fs.existsSync(targetDir)) {
        return;
    }

    const expected = new Set(expectedPaths);
    const existing = listRelativeFiles(projectDir, targetDir);
    for (const relativePath of existing) {
        if (expected.has(relativePath)) {
            continue;
        }

        fs.rmSync(path.join(projectDir, relativePath), { force: true });
    }
};

const resolveLatestRuntimeProjectDir = ({ userId, sessionId, projectId }) => {
    const preferredDir = getRuntimeProjectDir({ userId, sessionId, projectId });
    if (fs.existsSync(path.join(preferredDir, RUNTIME_PROJECT_MANIFEST))) {
        return preferredDir;
    }

    const sessionsDir = getRuntimeUserSessionsDir(userId);
    if (!fs.existsSync(sessionsDir)) {
        return null;
    }

    const sessionEntries = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    let bestMatch = null;

    for (const sessionEntry of sessionEntries) {
        const candidateDir = getRuntimeProjectDir({
            userId,
            sessionId: sessionEntry.name,
            projectId
        });
        const metaPath = path.join(candidateDir, RUNTIME_PROJECT_META);
        const manifestPath = path.join(candidateDir, RUNTIME_PROJECT_MANIFEST);
        if (!fs.existsSync(metaPath) || !fs.existsSync(manifestPath)) {
            continue;
        }

        try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            const savedAt = Date.parse(meta.savedAt || 0) || 0;
            if (!bestMatch || savedAt > bestMatch.savedAt) {
                bestMatch = {
                    dir: candidateDir,
                    savedAt
                };
            }
        } catch {
            // ignore malformed metadata
        }
    }

    return bestMatch?.dir || null;
};

handleTrustedIpc('ensure-save-dir', async () => {
    const dir = getSaveDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
});

handleTrustedIpc('save-file', async (event, filename, content) => {
    try {
        const dir = getSaveDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = resolvePathWithin(dir, filename, 'Save filename');
        writeFileAtomic(filePath, content);
        return { success: true, path: filePath };
    } catch (e) {
        console.error('IPC save-file error:', e);
        return { success: false, error: e.message };
    }
});

handleTrustedIpc('load-file', async (event, filename) => {
    try {
        const dir = getSaveDir();
        const filePath = resolvePathWithin(dir, filename, 'Save filename');
        console.log('[Main] IPC load-file request:', filename);
        console.log('[Main] Resolved path:', filePath);
        if (!fs.existsSync(filePath)) {
            console.warn('[Main] File not found at:', filePath);
            return { success: false, error: 'File not found' };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return { success: true, content };
    } catch (e) {
        console.error('IPC load-file error:', e);
        return { success: false, error: e.message };
    }
});

handleTrustedIpc('find-save-by-md5', async (event, targetMd5) => {
    try {
        const dir = getSaveDir();
        if (!fs.existsSync(dir)) return { success: false, error: 'Save directory not found' };

        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (!file.endsWith('.inksight')) continue;

            try {
                const filePath = path.join(dir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                // Simple substring check first
                if (content.includes(`"bookMd5": "${targetMd5}"`)) {
                    console.log('[Main] Found save file by MD5 match:', file);
                    return { success: true, filename: file };
                }
            } catch (err) {
                // Ignore read errors
            }
        }
        return { success: false, error: 'No matching save file found' };
    } catch (e) {
        console.error('IPC find-save-by-md5 error:', e);
        return { success: false, error: e.message };
    }
});

// --- AI config: OS-encrypted credential storage (safeStorage) ---

const AI_CONFIG_FILE = 'ai-config.bin';

handleTrustedIpc('ai-config-load', async () => {
    try {
        const filePath = path.join(app.getPath('userData'), AI_CONFIG_FILE);
        if (!fs.existsSync(filePath)) {
            return { success: true, config: null, encrypted: safeStorage.isEncryptionAvailable() };
        }
        const raw = fs.readFileSync(filePath);
        const stored = readAiConfigFile(raw, safeStorage);
        if (stored.migrationBytes) {
            writeFileAtomic(filePath, stored.migrationBytes);
        }
        return { success: true, config: stored.config, encrypted: stored.encrypted };
    } catch (error) {
        console.error('IPC ai-config-load error:', error);
        return { success: false, error: error.message, config: null };
    }
});

handleTrustedIpc('ai-config-save', async (event, config) => {
    try {
        const filePath = path.join(app.getPath('userData'), AI_CONFIG_FILE);
        ensureDir(path.dirname(filePath));
        const write = buildAiConfigWrite(config, safeStorage);
        if (!write.success) {
            return write;
        }
        writeFileAtomic(filePath, write.bytes);
        const { bytes: _bytes, ...result } = write;
        return result;
    } catch (error) {
        console.error('IPC ai-config-save error:', error);
        return { success: false, error: error.message };
    }
});

handleTrustedIpc('get-runtime-storage-info', async () => {
    const rootPath = ensureDir(getInstallRuntimeDir());
    return {
        rootPath,
        mode: 'runtime-data'
    };
});

handleTrustedIpc('save-runtime-project', async (event, payload = {}) => {
    try {
        const {
            userId,
            sessionId,
            projectId,
            projectName,
            manifest,
            assetEntries = [],
            documentEntries = []
        } = payload;

        const projectDir = ensureDir(getRuntimeProjectDir({ userId, sessionId, projectId }));
        const historyRoot = ensureDir(getRuntimeProjectHistoryDir({ userId, sessionId, projectId }));
        const baseMeta = {
            userId,
            sessionId,
            projectId,
            projectName,
            note: payload.note || null,
            savedAt: new Date().toISOString(),
            assetCount: assetEntries.length,
            documentCount: documentEntries.length
        };
        const writePayload = { manifest, assetEntries, documentEntries };
        const { manifestPath, metaPath, summary, meta } = writeRuntimeSnapshot({
            rootDir: projectDir,
            payload: writePayload,
            projectMeta: baseMeta
        });

        const snapshotId = `${Date.now()}-${slugifyRuntimeName(projectName, 'workspace')}`;
        const snapshotDir = path.join(historyRoot, snapshotId);
        writeRuntimeSnapshot({
            rootDir: snapshotDir,
            payload: writePayload,
            projectMeta: baseMeta,
            historyMeta: {
                snapshotId
            }
        });
        trimSnapshotHistory(historyRoot);

        return {
            success: true,
            projectDir,
            manifestPath,
            metaPath,
            savedAt: meta.savedAt,
            mode: 'runtime-data',
            snapshotId,
            summary
        };
    } catch (error) {
        console.error('IPC save-runtime-project error:', error);
        return {
            success: false,
            error: error.message
        };
    }
});

handleTrustedIpc('list-runtime-project-snapshots', async (event, payload = {}) => {
    try {
        const { userId, sessionId, projectId } = payload.runtimeIdentity || payload;
        const historyRoot = getRuntimeProjectHistoryDir({ userId, sessionId, projectId });
        if (!fs.existsSync(historyRoot)) {
            return {
                success: true,
                snapshots: []
            };
        }

        const snapshots = fs.readdirSync(historyRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const snapshotDir = path.join(historyRoot, entry.name);
                const metaPath = path.join(snapshotDir, RUNTIME_PROJECT_META);
                if (!fs.existsSync(metaPath)) {
                    return null;
                }

                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                return {
                    snapshotId: meta.snapshotId || entry.name,
                    savedAt: meta.savedAt || null,
                    projectName: meta.projectName || null,
                    bookName: meta.bookName || null,
                    elementCount: meta.elementCount || 0,
                    cardCount: meta.cardCount || 0,
                    highlightCount: meta.highlightCount || 0,
                    documentCount: meta.documentCount || 0
                };
            })
            .filter(Boolean)
            .sort((left, right) => Date.parse(right.savedAt || 0) - Date.parse(left.savedAt || 0));

        return {
            success: true,
            snapshots
        };
    } catch (error) {
        console.error('IPC list-runtime-project-snapshots error:', error);
        return {
            success: false,
            error: error.message,
            snapshots: []
        };
    }
});

handleTrustedIpc('load-runtime-project', async (event, payload = {}) => {
    try {
        const { userId, sessionId, projectId, snapshotId } = payload;
        const projectDir = snapshotId
            ? resolvePathWithin(
                getRuntimeProjectHistoryDir({ userId, sessionId, projectId }),
                assertSafePathSegment(snapshotId, 'Snapshot ID'),
                'Snapshot path'
            )
            : resolveLatestRuntimeProjectDir({ userId, sessionId, projectId });
        if (!projectDir) {
            return {
                success: false,
                error: 'Runtime project not found'
            };
        }

        const manifestPath = path.join(projectDir, RUNTIME_PROJECT_MANIFEST);
        const metaPath = path.join(projectDir, RUNTIME_PROJECT_META);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const meta = fs.existsSync(metaPath)
            ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
            : null;

        const referencedPaths = new Set();
        for (const asset of manifest.assets || []) {
            if (asset?.path) {
                referencedPaths.add(asset.path);
            }
        }
        for (const document of manifest.documents || []) {
            if (document?.path) {
                referencedPaths.add(document.path);
            }
        }

        const files = Array.from(referencedPaths).map((relativePath) => {
            const absolutePath = resolvePathWithin(projectDir, relativePath, 'Manifest file path');
            const bytes = fs.readFileSync(absolutePath);
            return {
                path: relativePath,
                bytes: new Uint8Array(bytes),
                mimeType: ''
            };
        });

        return {
            success: true,
            manifest,
            files,
            projectDir,
            projectId: meta?.projectId || projectId,
            projectName: meta?.projectName || null,
            savedAt: meta?.savedAt || null,
            snapshotId: meta?.snapshotId || null
        };
    } catch (error) {
        console.error('IPC load-runtime-project error:', error);
        return {
            success: false,
            error: error.message
        };
    }
});
