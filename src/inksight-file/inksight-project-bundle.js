import { isInksightPayload } from './inksight-file-types.js';

export const INKSIGHT_PROJECT_KIND = 'inksight-project';
export const INKSIGHT_PROJECT_VERSION = 1;
export const INKSIGHT_PROJECT_MANIFEST = 'project.json';
export const PROJECT_ASSETS_DIR = 'assets';
export const PROJECT_DOCUMENTS_DIR = 'documents';

function cloneSerializable(value) {
    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function sanitizeSegment(value, fallback = 'item') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    const sanitized = normalized
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .replace(/\.+$/, '')
        .slice(0, 80);

    return sanitized || fallback;
}

function inferExtension({ mimeType = '', fileName = '', fallback = 'bin' } = {}) {
    const normalizedMimeType = typeof mimeType === 'string'
        ? mimeType.split(';')[0].trim().toLowerCase()
        : '';

    const mimeMap = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/svg+xml': 'svg',
        'application/pdf': 'pdf',
        'application/epub+zip': 'epub',
        'application/epub': 'epub',
        'text/plain': 'txt',
        'text/markdown': 'md'
    };

    if (mimeMap[normalizedMimeType]) {
        return mimeMap[normalizedMimeType];
    }

    const match = typeof fileName === 'string'
        ? fileName.toLowerCase().match(/\.([a-z0-9]+)$/)
        : null;
    if (match?.[1]) {
        return match[1];
    }

    return fallback;
}

function splitDataUrl(dataUrl) {
    const match = typeof dataUrl === 'string'
        ? dataUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s)
        : null;

    if (!match) {
        return null;
    }

    return {
        mimeType: match[1] || 'application/octet-stream',
        isBase64: Boolean(match[2]),
        data: match[3] || ''
    };
}

function dataUrlToBlob(dataUrl) {
    const parts = splitDataUrl(dataUrl);
    if (!parts) {
        throw new Error('Unsupported data URL');
    }

    const raw = parts.isBase64
        ? atob(parts.data)
        : decodeURIComponent(parts.data);
    const bytes = new Uint8Array(raw.length);

    for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
    }

    return new Blob([bytes], { type: parts.mimeType });
}

async function defaultReadBlobFromReference(reference) {
    if (typeof reference !== 'string' || !reference) {
        throw new Error('Unsupported asset reference');
    }

    if (reference.startsWith('data:')) {
        return dataUrlToBlob(reference);
    }

    if (reference.startsWith('blob:')) {
        const response = await fetch(reference);
        if (!response.ok) {
            throw new Error(`Unable to read blob asset: ${response.status}`);
        }
        return response.blob();
    }

    throw new Error(`Unsupported asset reference: ${reference}`);
}

function visitProjectElements(elements, visitor) {
    if (!Array.isArray(elements)) {
        return;
    }

    elements.forEach((element) => {
        if (!element || typeof element !== 'object') {
            return;
        }

        visitor(element);

        if (Array.isArray(element.children)) {
            visitProjectElements(element.children, visitor);
        }
    });
}

function isAssetReference(value) {
    return typeof value === 'string'
        && (value.startsWith('data:') || value.startsWith('blob:') || value.startsWith(`${PROJECT_ASSETS_DIR}/`));
}

function buildAssetPath(index, extension, label) {
    const safeLabel = sanitizeSegment(label, `asset-${index}`);
    return `${PROJECT_ASSETS_DIR}/${String(index).padStart(4, '0')}-${safeLabel}.${extension}`;
}

export function createProjectManifest({ payload, documents = [], assets = [] } = {}) {
    return {
        kind: INKSIGHT_PROJECT_KIND,
        version: INKSIGHT_PROJECT_VERSION,
        savedAt: new Date().toISOString(),
        payload,
        documents,
        assets
    };
}

export function isInksightProjectManifest(value) {
    return Boolean(
        value
        && value.kind === INKSIGHT_PROJECT_KIND
        && value.version === INKSIGHT_PROJECT_VERSION
        && isInksightPayload(value.payload)
    );
}

export async function bundleProjectData({
    payload,
    projectFiles = [],
    readBlobFromReference = defaultReadBlobFromReference
} = {}) {
    const bundledPayload = cloneSerializable(payload || {});
    const assetEntries = [];
    const assetLookup = new Map();
    let assetIndex = 0;

    const registerAsset = async (reference, label, preferredMimeType = '') => {
        if (!isAssetReference(reference)) {
            return reference;
        }

        if (reference.startsWith(`${PROJECT_ASSETS_DIR}/`)) {
            return reference;
        }

        if (assetLookup.has(reference)) {
            return assetLookup.get(reference).path;
        }

        const blob = await readBlobFromReference(reference);
        const extension = inferExtension({
            mimeType: blob.type || preferredMimeType,
            fileName: label,
            fallback: 'bin'
        });
        assetIndex += 1;
        const path = buildAssetPath(assetIndex, extension, label);
        const entry = {
            path,
            mimeType: blob.type || preferredMimeType || 'application/octet-stream',
            size: blob.size,
            blob
        };

        assetLookup.set(reference, entry);
        assetEntries.push(entry);
        return path;
    };

    for (const card of bundledPayload.cards || []) {
        if (card?.type === 'image' && typeof card.imageData === 'string') {
            const projectAssetPath = await registerAsset(card.imageData, `card-${card.id}`, 'image/png');
            card.projectAssetPath = projectAssetPath;
            card.imageData = projectAssetPath;
        }
    }

    const imageElements = [];
    visitProjectElements(bundledPayload.elements, (element) => imageElements.push(element));
    for (const element of imageElements) {
        if (element?.type === 'image' && typeof element.url === 'string') {
            element.url = await registerAsset(element.url, `node-${element.id}`, 'image/png');
        }

        if (typeof element?.data?.imageData === 'string') {
            element.data.imageData = await registerAsset(element.data.imageData, `node-data-${element.id}`, 'image/png');
        }
    }

    const documentEntries = (projectFiles || [])
        .filter((fileData) => fileData?.fileObj)
        .map((fileData, index) => {
        const extension = inferExtension({
            mimeType: fileData?.type,
            fileName: fileData?.name,
            fallback: 'bin'
        });
        const safeName = sanitizeSegment(fileData?.name, `document-${index + 1}`);
        const path = `${PROJECT_DOCUMENTS_DIR}/${String(index + 1).padStart(3, '0')}-${safeName}.${extension}`;

        return {
            id: fileData.id,
            name: fileData.name,
            type: fileData.type || '',
            lastModified: fileData.lastModified || 0,
            size: fileData.fileObj?.size ?? 0,
            path,
            file: fileData.fileObj
        };
    });

    const payloadDocuments = Array.isArray(bundledPayload.documents)
        ? bundledPayload.documents
        : [];
    const documentPathMap = new Map(documentEntries.map((entry) => [entry.id, entry.path]));
    bundledPayload.documents = payloadDocuments.map(([id, docInfo]) => ([
        id,
        {
            ...docInfo,
            loaded: documentPathMap.has(id) ? true : docInfo?.loaded ?? false,
            projectPath: documentPathMap.get(id) || docInfo?.projectPath || null
        }
    ]));

    const manifest = createProjectManifest({
        payload: bundledPayload,
        documents: documentEntries.map(({ file, ...entry }) => entry),
        assets: assetEntries.map(({ blob, ...entry }) => entry)
    });

    return {
        manifest,
        assetEntries,
        documentEntries
    };
}

export async function hydrateProjectData({
    manifest,
    readBlob,
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url)
} = {}) {
    if (!isInksightProjectManifest(manifest)) {
        throw new Error('Invalid InkSight project manifest');
    }

    const payload = cloneSerializable(manifest.payload);
    const cleanupUrls = [];
    const assetCache = new Map();
    const assetSizeByPath = new Map((manifest.assets || []).map((entry) => [entry.path, entry.size]));

    const materializeAsset = async (path) => {
        if (typeof path !== 'string' || !path.startsWith(`${PROJECT_ASSETS_DIR}/`)) {
            return path;
        }

        if (assetCache.has(path)) {
            return assetCache.get(path);
        }

        const blob = await readBlob(path);
        const expectedSize = assetSizeByPath.get(path);
        if (Number.isFinite(expectedSize) && blob.size !== expectedSize) {
            throw new Error(`Invalid project asset size: ${path}`);
        }
        const objectUrl = createObjectURL(blob);
        cleanupUrls.push(objectUrl);
        assetCache.set(path, objectUrl);
        return objectUrl;
    };

    for (const card of payload.cards || []) {
        if (card?.type === 'image' && typeof card.imageData === 'string') {
            if (card.imageData.startsWith(`${PROJECT_ASSETS_DIR}/`) && !card.projectAssetPath) {
                card.projectAssetPath = card.imageData;
            }
            card.imageData = await materializeAsset(card.imageData);
        }
    }

    const imageElements = [];
    visitProjectElements(payload.elements, (element) => imageElements.push(element));
    for (const element of imageElements) {
        if (element?.type === 'image' && typeof element.url === 'string') {
            element.url = await materializeAsset(element.url);
        }

        if (typeof element?.data?.imageData === 'string') {
            element.data.imageData = await materializeAsset(element.data.imageData);
        }
    }

    const projectFiles = await Promise.all((manifest.documents || []).map(async (entry) => {
        const blob = await readBlob(entry.path);
        if (Number.isFinite(entry.size) && blob.size !== entry.size) {
            throw new Error(`Invalid project document size: ${entry.path}`);
        }
        const file = new File([blob], entry.name, {
            type: entry.type || blob.type || '',
            lastModified: entry.lastModified || Date.now()
        });

        return {
            id: entry.id,
            name: entry.name,
            type: entry.type || file.type,
            lastModified: entry.lastModified || file.lastModified,
            fileObj: file,
            projectPath: entry.path,
            size: entry.size ?? file.size
        };
    }));

    return {
        payload,
        projectFiles,
        cleanup() {
            cleanupUrls.forEach((url) => revokeObjectURL(url));
        }
    };
}
