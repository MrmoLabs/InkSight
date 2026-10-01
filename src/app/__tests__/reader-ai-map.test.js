import { describe, expect, it, vi } from 'vitest';
import { createReaderAiMap } from '../reader-ai-map.js';

describe('createReaderAiMap', () => {
    it('stores nested outline items under the source annotation card', () => {
        const card = { id: 'card-1', highlightId: 'highlight-1' };
        const upsert = vi.fn((node) => node);
        let id = 0;
        const result = createReaderAiMap({
            passage: { id: 'highlight-1' },
            answer: '# Main idea\n- First point\n  - Detail\n- Second point',
            cardSystem: { cards: new Map([[card.id, card]]) },
            graphNodesStore: { upsert },
            idFactory: () => `node-${++id}`
        });

        expect(result).toMatchObject({ rootCardId: 'card-1', nodeIds: ['node-1', 'node-2', 'node-3', 'node-4'] });
        expect(upsert.mock.calls.map(([node]) => [node.id, node.parentId, node.rootCardId, node.title])).toEqual([
            ['node-1', 'card-1', 'card-1', 'Main idea'],
            ['node-2', 'node-1', 'card-1', 'First point'],
            ['node-3', 'node-2', 'card-1', 'Detail'],
            ['node-4', 'node-1', 'card-1', 'Second point']
        ]);
    });

    it('does not create nodes when the source card or answer is missing', () => {
        const upsert = vi.fn();
        const options = {
            passage: { id: 'missing' },
            answer: '- Point',
            cardSystem: { cards: new Map() },
            graphNodesStore: { upsert },
            idFactory: () => 'node'
        };
        expect(createReaderAiMap(options)).toBeNull();
        expect(createReaderAiMap({ ...options, passage: { id: 'highlight' }, answer: ' ' })).toBeNull();
        expect(upsert).not.toHaveBeenCalled();
    });
});
