import { describe, expect, it } from 'vitest';
import { decryptProjectRevision, encryptProjectRevision } from '../encrypted-revision.js';

describe('encrypted project revisions', () => {
    it('encrypts the complete snapshot and authenticates revision metadata', async () => {
        const payload = { documents: ['local passage'], notes: [{ text: 'private' }] };
        const revision = await encryptProjectRevision({
            projectId: 'project-1',
            revisionId: 'revision-1',
            payload,
            passphrase: 'correct horse battery staple',
            createdAt: '2026-10-01T00:00:00.000Z'
        });

        expect(JSON.stringify(revision)).not.toContain('local passage');
        await expect(decryptProjectRevision(revision, {
            projectId: 'project-1',
            passphrase: 'correct horse battery staple'
        })).resolves.toEqual(payload);
        await expect(decryptProjectRevision({ ...revision, revisionId: 'changed' }, {
            projectId: 'project-1',
            passphrase: 'correct horse battery staple'
        })).rejects.toThrow('Could not decrypt');
        await expect(decryptProjectRevision(revision, {
            projectId: 'project-1',
            passphrase: 'wrong passphrase'
        })).rejects.toThrow('Could not decrypt');
    });

    it('rejects weak passphrases before encrypting', async () => {
        await expect(encryptProjectRevision({
            projectId: 'project-1', revisionId: 'revision-1', payload: {}, passphrase: 'short'
        })).rejects.toThrow('at least 12 characters');
    });
});
