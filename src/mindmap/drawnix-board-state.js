import { Transforms, getSelectedElements } from '@plait/core';
import { v4 as uuidv4 } from 'uuid';
import { getAppContext } from '../app/app-context.js';
import { APP_EVENTS } from '../core/event-names.js';
import { sanitizeViewport } from './viewport-state.js';

export { sanitizeViewport } from './viewport-state.js';

export function emitMindmapSelectionChanged(detail) {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.MINDMAP_SELECTION_CHANGED, {
        detail
    }));
}

export function syncMindmapSelection(currentBoard, cardSystem, logger) {
    if (!currentBoard?.selection) {
        emitMindmapSelectionChanged({ sourceId: null });
        return;
    }

    const selectedElements = getSelectedElements(currentBoard);
    if (selectedElements.length !== 1) {
        emitMindmapSelectionChanged({ sourceId: null });
        return;
    }

    const node = selectedElements[0];
    if (!node.data?.cardId) {
        emitMindmapSelectionChanged({ sourceId: null });
        return;
    }

    const card = cardSystem.cards.get(node.data.cardId);
    if (!card) {
        logger?.warn?.('Card not found in cardSystem for ID', node.data.cardId);
        emitMindmapSelectionChanged({ sourceId: null });
        return;
    }

    emitMindmapSelectionChanged({
        sourceId: card.sourceId,
        sourceName: card.sourceName || node.data.sourceName
    });
}

function duplicateCardForBoard(card, node) {
    return {
        ...card,
        id: uuidv4(),
        sourceId: null,
        sourceName: null,
        highlightId: null,
        position: {
            x: node.points ? node.points[0][0] : 100,
            y: node.points ? node.points[0][1] : 100
        },
        createdAt: new Date().toISOString()
    };
}

function handleInsertedNode({ data, op, boardRef, processingCardIds, cardSystem, logger }) {
    const node = op.node;
    if (!node.data?.cardId) {
        return;
    }

    const card = cardSystem.cards.get(node.data.cardId);
    if (!card) {
        logger?.warn?.('Card not found for node', node.data.cardId);
        return;
    }

    const occurrenceCount = data.children.filter((child) => child.data?.cardId === node.data.cardId).length;
    if (occurrenceCount > 1) {
        const newCard = duplicateCardForBoard(card, node);
        processingCardIds.current.add(newCard.id);
        cardSystem.addCard(newCard);

        setTimeout(() => {
            const currentBoard = boardRef.current;
            if (!currentBoard) {
                return;
            }

            Transforms.setNode(currentBoard, {
                data: {
                    ...node.data,
                    cardId: newCard.id,
                    sourceName: null
                }
            }, op.path);
        }, 0);
        return;
    }

    if (card.deleted) {
        cardSystem.markCardAsDeleted(node.data.cardId, false);
    }
}

function handleRemovedNode(op, cardSystem, logger) {
    const node = op.node;
    if (!node.data?.cardId) {
        logger?.warn?.('Removed node missing cardId', node);
        return;
    }

    const card = cardSystem.cards.get(node.data.cardId);
    const highlightManager = getAppContext().highlightManager;
    if (card?.highlightId && card.location && !highlightManager?.getHighlight?.(card.highlightId)) {
        highlightManager?.upsertHighlight?.({
            id: card.highlightId,
            text: card.content || '',
            location: card.location,
            sourceId: card.sourceId,
            sourceName: card.sourceName,
            type: card.highlightType || card.type || 'text',
            createdAt: card.createdAt,
            color: card.color
        });
    }

    cardSystem.updateCard(node.data.cardId, { isOnBoard: false });
}

function handleUpdatedNode(data, op, cardSystem, logger) {
    const props = op.newProperties;
    const path = op.path;
    if (!props || (!props.strokeColor && !props.stroke)) {
        return;
    }

    const newColor = props.strokeColor || props.stroke;
    if (!data?.children || !path || path.length === 0) {
        logger?.warn?.('Invalid data state or path', { hasData: !!data, hasChildren: !!data?.children, path });
        return;
    }

    const targetNode = data.children[path[0]];
    if (!targetNode?.data?.cardId) {
        logger?.warn?.('No valid target node found at path', path);
        return;
    }

    const card = cardSystem.cards.get(targetNode.data.cardId);
    if (!card?.highlightId) {
        logger?.warn?.('Card or highlightId not found for cardId', targetNode.data.cardId);
        return;
    }

    window.dispatchEvent(new CustomEvent(APP_EVENTS.MINDMAP_NODE_UPDATED, {
        detail: {
            highlightId: card.highlightId,
            color: newColor
        }
    }));
}

export function handleBoardOperations({ data, boardRef, processingCardIds, cardSystem, logger }) {
    if (!data?.operations) {
        return;
    }

    data.operations.forEach((op) => {
        if (op.type === 'insert_node') {
            handleInsertedNode({ data, op, boardRef, processingCardIds, cardSystem, logger });
            return;
        }

        if (op.type === 'remove_node') {
            handleRemovedNode(op, cardSystem, logger);
            return;
        }

        if (op.type === 'set_node') {
            handleUpdatedNode(data, op, cardSystem, logger);
        }
    });
}
