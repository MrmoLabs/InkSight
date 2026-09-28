import { getAppContext } from './app-context.js';
import { emitAppNotification } from '../ui/app-notifications.js';
import { t } from '../i18n/index.js';

function sanitizeFileNameSegment(value, fallback = 'workspace') {
    const normalized = String(value || '').trim().replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-');
    const collapsed = normalized.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return collapsed || fallback;
}

function stripDocumentExtension(value) {
    const normalized = String(value || '').trim();
    return normalized.replace(/\.(pdf|epub|md|markdown|txt)$/i, '');
}

function getCardsCollection(cardSystem) {
    if (cardSystem?.cards instanceof Map) {
        return Array.from(cardSystem.cards.values()).filter((card) => !card?.deleted);
    }

    return Object.values(cardSystem?.cards || {}).filter((card) => !card?.deleted);
}

function getDocumentsCollection(appContext) {
    const registered = appContext.documentManager?.getAllDocuments?.() ?? [];
    return registered.map((document) => ({
        id: document.id,
        name: document.name || 'Untitled document',
        type: document.type || 'unknown',
        loaded: document.loaded !== false
    }));
}

function formatLocation(highlight = {}) {
    const location = highlight.location || {};
    if (Number.isFinite(location.page)) {
        return `Page ${location.page}`;
    }
    if (Number.isFinite(location.lineStart)) {
        if (Number.isFinite(location.lineEnd) && location.lineEnd > location.lineStart) {
            return `Lines ${location.lineStart}-${location.lineEnd}`;
        }
        return `Line ${location.lineStart}`;
    }
    if (location.cfi) {
        return `CFI ${location.cfi}`;
    }
    if (Number.isFinite(location.index)) {
        return `Offset ${location.index}`;
    }
    return 'Location unavailable';
}

function getUnsavedImageCards(appContext) {
    return getCardsCollection(appContext.cardSystem).filter((card) => (
        card?.type === 'image' &&
        typeof card.imageData === 'string' &&
        card.imageData &&
        !(typeof card.projectAssetPath === 'string' && card.projectAssetPath)
    ));
}

function deriveCardTitle(card) {
    if (card?.type === 'image') {
        const shapeLabel = card.highlightType === 'ellipse' ? 'Ellipse capture' : 'Rectangle capture';
        const pageLabel = Number.isFinite(card.location?.page) ? ` (Page ${card.location.page})` : '';
        const sourceLabel = stripDocumentExtension(card.sourceName || '');
        return sourceLabel
            ? `${shapeLabel}${pageLabel} - ${sourceLabel}`
            : `${shapeLabel}${pageLabel}`;
    }

    const source = String(card.note || card.content || 'Untitled card').trim();
    const firstLine = source.split(/\r?\n/, 1)[0].trim();
    return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

function isCitationCard(card) {
    return Boolean(card?.highlightId && card?.sourceName && card?.content?.trim());
}

function getCitationSummaryLines(card, indent = '') {
    const quote = card.content.trim();
    const sourceName = stripDocumentExtension(card.sourceName);
    const lines = [
        `${indent}- ${quote}`,
        `${indent}  --《${sourceName}》`
    ];

    if (card.note?.trim()) {
        lines.push(`${indent}  - Note: ${card.note.trim()}`);
    }

    return lines;
}

function getImageCardLines(card, indent = '') {
    const lines = [`${indent}- ${deriveCardTitle(card)}`];

    if (typeof card.projectAssetPath === 'string' && card.projectAssetPath) {
        lines.push(`${indent}  ![](.\/${card.projectAssetPath})`);
        lines.push(`${indent}  - Image link works when this Markdown file is placed in the project root folder.`);
    } else {
        lines.push(`${indent}  - Image omitted from Markdown export to keep the file compact.`);
    }
    if (card.note?.trim()) {
        lines.push(`${indent}  - Note: ${card.note.trim()}`);
    }
    if (card.sourceName) {
        lines.push(`${indent}  - Source: ${stripDocumentExtension(card.sourceName)}`);
    }

    return lines;
}

function buildGraphData(cards, connections = []) {
    const adjacency = new Map();
    const inbound = new Set();
    const cardIds = new Set(cards.map((card) => card.id));

    cards.forEach((card) => adjacency.set(card.id, []));
    connections.forEach((connection) => {
        if (!cardIds.has(connection.sourceId) || !cardIds.has(connection.targetId)) {
            return;
        }

        adjacency.get(connection.sourceId)?.push(connection.targetId);
        inbound.add(connection.targetId);
    });

    const roots = cards.filter((card) => adjacency.get(card.id)?.length && !inbound.has(card.id));
    const looseCards = cards.filter((card) => !adjacency.get(card.id)?.length && !inbound.has(card.id));

    return { adjacency, roots, looseCards };
}

function renderCardTree(card, cardMap, adjacency, depth = 0, visited = new Set()) {
    if (visited.has(card.id)) {
        return [];
    }

    visited.add(card.id);
    const lines = [];
    const indent = '  '.repeat(depth);
    if (isCitationCard(card)) {
        lines.push(...getCitationSummaryLines(card, indent));
    } else if (card?.type === 'image') {
        lines.push(...getImageCardLines(card, indent));
    } else {
        lines.push(`${indent}- ${deriveCardTitle(card)}`);

        if (card.content && card.content.trim() && card.content.trim() !== deriveCardTitle(card)) {
            lines.push(`${indent}  - Excerpt: ${card.content.trim()}`);
        }
        if (card.note?.trim()) {
            lines.push(`${indent}  - Note: ${card.note.trim()}`);
        }
        if (card.sourceName) {
            lines.push(`${indent}  - Source: ${card.sourceName}`);
        }
    }

    (adjacency.get(card.id) || []).forEach((childId) => {
        const child = cardMap.get(childId);
        if (child) {
            lines.push(...renderCardTree(child, cardMap, adjacency, depth + 1, visited));
        }
    });

    return lines;
}

function buildCitationEntries(appContext = getAppContext()) {
    const cards = getCardsCollection(appContext.cardSystem);
    const cardsByHighlightId = new Map(cards.filter((card) => card.highlightId).map((card) => [card.highlightId, card]));
    const activeHighlightIds = new Set(cards.map((card) => card.highlightId).filter(Boolean));

    return (appContext.highlightManager?.highlights || [])
        .filter((highlight) => activeHighlightIds.has(highlight.id))
        .map((highlight) => {
        const linkedCard = cardsByHighlightId.get(highlight.id) || null;
        return {
            id: highlight.id,
            text: (highlight.text || linkedCard?.content || '').trim(),
            sourceName: stripDocumentExtension(
                highlight.sourceName || appContext.documentManager?.getDocumentInfo?.(highlight.sourceId)?.name || 'Unknown source'
            ),
            locationLabel: formatLocation(highlight),
            cardTitle: linkedCard ? deriveCardTitle(linkedCard) : null,
            needsValidation: Boolean(highlight.needsValidation)
        };
        });
}

export function buildMarkdownOutline(appContext = getAppContext()) {
    const cards = getCardsCollection(appContext.cardSystem);
    const connections = Array.isArray(appContext.cardSystem?.connections) ? appContext.cardSystem.connections : [];
    const cardMap = new Map(cards.map((card) => [card.id, card]));
    const { adjacency, roots, looseCards } = buildGraphData(cards, connections);
    const visited = new Set();
    const lines = ['# Markdown Outline', ''];

    if (!cards.length) {
        lines.push('No cards are available in the current workspace.');
        return lines.join('\n');
    }

    lines.push('## Connected Map', '');
    const rootCards = roots.length ? roots : cards.filter((card) => adjacency.get(card.id)?.length);
    rootCards.forEach((card) => {
        lines.push(...renderCardTree(card, cardMap, adjacency, 0, visited));
    });

    const unresolvedLoose = looseCards.filter((card) => !visited.has(card.id));
    if (unresolvedLoose.length) {
        lines.push('', '## Loose Cards', '');
        unresolvedLoose.forEach((card) => {
            if (isCitationCard(card)) {
                lines.push(...getCitationSummaryLines(card));
            } else if (card?.type === 'image') {
                lines.push(...getImageCardLines(card));
            } else {
                lines.push(`- ${deriveCardTitle(card)}`);
                if (card.content?.trim()) {
                    lines.push(`  - Excerpt: ${card.content.trim()}`);
                }
                if (card.note?.trim()) {
                    lines.push(`  - Note: ${card.note.trim()}`);
                }
                if (card.sourceName) {
                    lines.push(`  - Source: ${card.sourceName}`);
                }
            }
        });
    }

    return lines.join('\n');
}

export function buildCitationList(appContext = getAppContext()) {
    const entries = buildCitationEntries(appContext);
    const lines = ['# Citation List', ''];

    if (!entries.length) {
        lines.push('No highlights are available in the current workspace.');
        return lines.join('\n');
    }

    entries.forEach((entry, index) => {
        lines.push(`${index + 1}. ${entry.text || '[Empty highlight]'}`);
        lines.push(`   --《${entry.sourceName}》`);
        if (entry.needsValidation) {
            lines.push(`   - Status: Needs validation (${entry.locationLabel})`);
        }
        lines.push('');
    });

    return lines.join('\n').trimEnd();
}

export function buildReadingNotesPackage(appContext = getAppContext()) {
    const cards = getCardsCollection(appContext.cardSystem);
    const documents = getDocumentsCollection(appContext);
    const citations = buildCitationEntries(appContext);
    const unmappedCards = cards.filter((card) => !card.isOnBoard);
    const lines = ['# Reading Notes Package', ''];

    lines.push('## Project Overview', '');
    lines.push(`- Documents: ${documents.length}`);
    lines.push(`- Cards: ${cards.length}`);
    lines.push(`- Highlights: ${citations.length}`);
    lines.push('');

    lines.push('## Documents', '');
    if (documents.length) {
        documents.forEach((document) => {
            lines.push(`- ${document.name} (${document.type})${document.loaded ? '' : ' - missing source'}`);
        });
    } else {
        lines.push('No documents are loaded.');
    }

    lines.push('', buildMarkdownOutline(appContext), '', buildCitationList(appContext), '', '## Unmapped Notes', '');
    if (unmappedCards.length) {
        unmappedCards.forEach((card) => {
            if (isCitationCard(card)) {
                lines.push(...getCitationSummaryLines(card));
            } else if (card?.type === 'image') {
                lines.push(...getImageCardLines(card));
            } else {
                lines.push(`- ${deriveCardTitle(card)}`);
                if (card.note?.trim()) {
                    lines.push(`  - Note: ${card.note.trim()}`);
                }
                if (card.sourceName) {
                    lines.push(`  - Source: ${card.sourceName}`);
                }
            }
        });
    } else {
        lines.push('No unmapped notes.');
    }

    return lines.join('\n');
}

function downloadMarkdown(content, fileName) {
    const blob = new Blob([content], {
        type: 'text/markdown;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${fileName}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function countWorkspaceContent(appContext) {
    return {
        documents: getDocumentsCollection(appContext).length,
        cards: getCardsCollection(appContext.cardSystem).length,
        highlights: (appContext.highlightManager?.highlights || []).length
    };
}

export function exportWorkspaceArtifact({
    type,
    appContext = getAppContext(),
    notify = emitAppNotification
} = {}) {
    const counts = countWorkspaceContent(appContext);
    if (counts.documents === 0 && counts.cards === 0 && counts.highlights === 0) {
        notify?.({
            title: t('export.skipped.title'),
            message: t('export.skipped.message'),
            level: 'warning'
        });
        return false;
    }

    const projectName = sanitizeFileNameSegment(appContext.currentBook?.name || 'inksight-workspace');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const artifactBuilders = {
        outline: {
            label: t('export.outline'),
            fileSuffix: 'outline',
            build: () => buildMarkdownOutline(appContext)
        },
        citations: {
            label: t('export.citations'),
            fileSuffix: 'citations',
            build: () => buildCitationList(appContext)
        },
        'notes-package': {
            label: t('export.notesPackage'),
            fileSuffix: 'notes-package',
            build: () => buildReadingNotesPackage(appContext)
        }
    };

    const artifact = artifactBuilders[type];
    if (!artifact) {
        return false;
    }

    const unsavedImageCards = getUnsavedImageCards(appContext);
    if (unsavedImageCards.length) {
        notify?.({
            title: t('export.saveFirst.title'),
            message: t('export.saveFirst.message'),
            level: 'warning'
        });
        return false;
    }

    downloadMarkdown(artifact.build(), `${projectName}-${artifact.fileSuffix}-${timestamp}`);
    notify?.({
        title: t('export.ready.title'),
        message: t('export.ready.message', { label: artifact.label }),
        level: 'success'
    });
    return true;
}
