const REVISION_SCHEMA = 1;
const KDF_ITERATIONS = 210_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function fromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function revisionAad(revision) {
    return encoder.encode(JSON.stringify({
        schema: revision.schema,
        projectId: revision.projectId,
        revisionId: revision.revisionId,
        parentRevisionId: revision.parentRevisionId,
        createdAt: revision.createdAt
    }));
}

async function deriveKey(passphrase, salt, cryptoProvider) {
    if (typeof passphrase !== 'string' || passphrase.length < 12) {
        throw new Error('Sync passphrase must be at least 12 characters.');
    }
    const material = await cryptoProvider.subtle.importKey(
        'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return cryptoProvider.subtle.deriveKey({
        name: 'PBKDF2',
        salt,
        iterations: KDF_ITERATIONS,
        hash: 'SHA-256'
    }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptProjectRevision({
    projectId,
    revisionId,
    parentRevisionId = null,
    payload,
    passphrase,
    cryptoProvider = globalThis.crypto,
    createdAt = new Date().toISOString()
}) {
    if (!projectId || !revisionId || payload === undefined) {
        throw new Error('Project id, revision id, and payload are required.');
    }
    if (!cryptoProvider?.subtle || !cryptoProvider?.getRandomValues) {
        throw new Error('Web Crypto is unavailable in this environment.');
    }

    const salt = cryptoProvider.getRandomValues(new Uint8Array(16));
    const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
    const revision = {
        schema: REVISION_SCHEMA,
        projectId,
        revisionId,
        parentRevisionId,
        createdAt,
        kdf: 'PBKDF2-SHA-256',
        iterations: KDF_ITERATIONS,
        cipher: 'AES-256-GCM',
        salt: toBase64(salt),
        iv: toBase64(iv)
    };
    const key = await deriveKey(passphrase, salt, cryptoProvider);
    const ciphertext = await cryptoProvider.subtle.encrypt({
        name: 'AES-GCM',
        iv,
        additionalData: revisionAad(revision)
    }, key, encoder.encode(JSON.stringify(payload)));
    return { ...revision, ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptProjectRevision(revision, {
    projectId,
    passphrase,
    cryptoProvider = globalThis.crypto
} = {}) {
    if (!revision || revision.schema !== REVISION_SCHEMA || revision.cipher !== 'AES-256-GCM'
        || revision.kdf !== 'PBKDF2-SHA-256' || revision.iterations !== KDF_ITERATIONS) {
        throw new Error('Unsupported or invalid encrypted project revision.');
    }
    if (projectId && revision.projectId !== projectId) {
        throw new Error('Encrypted project revision belongs to another project.');
    }
    const key = await deriveKey(passphrase, fromBase64(revision.salt), cryptoProvider);
    try {
        const plaintext = await cryptoProvider.subtle.decrypt({
            name: 'AES-GCM',
            iv: fromBase64(revision.iv),
            additionalData: revisionAad(revision)
        }, key, fromBase64(revision.ciphertext));
        return JSON.parse(decoder.decode(plaintext));
    } catch {
        throw new Error('Could not decrypt the project revision; check the passphrase or revision integrity.');
    }
}
