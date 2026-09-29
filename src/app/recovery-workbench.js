import { getAppContext } from './app-context.js';
import { buildRecoveryDiagnostics, findLoadedDocumentMatch } from './document-relink.js';
import { t } from '../i18n/index.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getCardsCollection(cardSystem) {
    if (cardSystem?.cards instanceof Map) {
        return Array.from(cardSystem.cards.values());
    }

    return Object.values(cardSystem?.cards || {});
}

function getDocumentImpact(documentId, diagnostics) {
    const cardCount = diagnostics.unresolvedCards.filter((card) => card.sourceId === documentId).length;
    const highlightCount = diagnostics.unresolvedHighlights.filter((highlight) => highlight.sourceId === documentId).length;

    return {
        cardCount,
        highlightCount,
        referenceCount: cardCount + highlightCount
    };
}

function buildAffectedPreview(documentId, diagnostics) {
    const cardPreview = diagnostics.unresolvedCards
        .filter((card) => card.sourceId === documentId)
        .slice(0, 2)
        .map((card) => card.content || card.note || card.id);
    const highlightPreview = diagnostics.unresolvedHighlights
        .filter((highlight) => highlight.sourceId === documentId)
        .slice(0, 2)
        .map((highlight) => highlight.text || highlight.id);

    return [...cardPreview, ...highlightPreview].slice(0, 3);
}

export function relinkRecoveredDocument({
    documentId,
    loadedDocumentId,
    appContext = getAppContext()
} = {}) {
    if (!documentId || !loadedDocumentId) {
        return false;
    }

    const missingDocument = appContext.documentManager?.getDocumentInfo?.(documentId);
    const loadedDocument = appContext.documentManager?.getDocumentInfo?.(loadedDocumentId);

    if (!missingDocument || missingDocument.loaded || !loadedDocument?.loaded) {
        return false;
    }

    appContext.highlightManager?.remapSourceIds?.(loadedDocument.id, missingDocument.id);
    appContext.cardSystem?.remapSourceIds?.(loadedDocument.id, missingDocument.id);
    appContext.cardSystem?.updateSourceNames?.(loadedDocument.id, loadedDocument.name);
    appContext.highlightManager?.updateSourceNames?.(loadedDocument.id, loadedDocument.name);
    appContext.documentManager?.unregisterDocument?.(missingDocument.id);

    return true;
}

export function buildRecoveryWorkbenchModel(appContext = getAppContext()) {
    const diagnostics = buildRecoveryDiagnostics(appContext);
    const loadedDocuments = diagnostics.loadedDocuments;
    const lastSummary = appContext.recoveryWorkbenchSummary || null;
    const documents = diagnostics.missingDocuments.map((document) => {
        const impact = getDocumentImpact(document.id, diagnostics);
        const loadedMatch = findLoadedDocumentMatch({
            document,
            loadedDocuments,
            documentManager: appContext.documentManager
        });

        return {
            ...document,
            ...impact,
            affectedPreview: buildAffectedPreview(document.id, diagnostics),
            loadedMatch,
            autoMatchReady: Boolean(loadedMatch),
            status: loadedMatch ? 'needs_validation' : 'needs_import',
            statusLabel: loadedMatch ? t('recovery.needsValidation') : t('recovery.needsImport')
        };
    });

    const readyMatches = documents.filter((document) => document.autoMatchReady).length;

    return {
        ...diagnostics,
        documents,
        readyMatches,
        impactedDocuments: documents.filter((document) => document.referenceCount > 0).length,
        lastSummary
    };
}

export function renderRecoveryWorkbenchMarkup(workbench) {
    if (!workbench?.documents?.length) {
        return '';
    }

    return `
        <section class="library-recovery-panel" aria-label="${escapeHtml(t('recovery.panelAria'))}">
          <div class="library-recovery-header">
            <span class="material-icons-round">link_off</span>
            <div class="library-recovery-copy">
              <strong>${escapeHtml(t(workbench.documents.length === 1 ? 'recovery.waiting.one' : 'recovery.waiting.other', { count: workbench.documents.length }))}</strong>
              <p class="text-two-line">${escapeHtml(t('recovery.hint'))}</p>
            </div>
          </div>
          <div class="library-recovery-stats">
            <span><span class="material-icons-round">sticky_note_2</span>${workbench.unresolvedCards.length}</span>
            <span><span class="material-icons-round">format_quote</span>${workbench.unresolvedHighlights.length}</span>
            <span><span class="material-icons-round">merge_type</span>${workbench.readyMatches}</span>
            <span><span class="material-icons-round">description</span>${workbench.totalDocuments}</span>
          </div>
          <div class="library-recovery-actions icon-row">
            <button type="button" class="library-recovery-secondary-btn icon-only-btn" data-recovery-action="auto" title="${escapeHtml(t('recovery.autoMatch'))}" aria-label="${escapeHtml(t('recovery.autoMatch'))}"><span class="material-icons-round">merge_type</span></button>
            <button type="button" class="library-recovery-secondary-btn icon-only-btn" data-recovery-action="bulk" title="${escapeHtml(t('recovery.importSources'))}" aria-label="${escapeHtml(t('recovery.importSources'))}"><span class="material-icons-round">upload_file</span></button>
            <button type="button" class="library-recovery-secondary-btn icon-only-btn" data-recovery-action="validate" title="${escapeHtml(t('recovery.validateLinks'))}" aria-label="${escapeHtml(t('recovery.validateLinks'))}"><span class="material-icons-round">task_alt</span></button>
          </div>
          ${workbench.lastSummary ? `
            <div class="library-recovery-summary">
              <strong>${escapeHtml(t('recovery.summary', { matched: workbench.lastSummary.matched.length, remaining: workbench.lastSummary.remaining.length }))}</strong>
              <p>${escapeHtml(workbench.lastSummary.message)}</p>
            </div>
          ` : ''}
          <div class="library-recovery-list">
            ${workbench.documents.map((document) => `
              <div class="library-recovery-item">
                <div class="library-recovery-item-copy">
                  <span class="library-recovery-name">${escapeHtml(document.name)}</span>
                  <span class="library-recovery-meta">${escapeHtml(document.type || t('recovery.unknownType'))}</span>
                  <div class="library-recovery-tags">
                    <span title="${escapeHtml(t('search.cards'))}"><span class="material-icons-round">sticky_note_2</span>${document.cardCount}</span>
                    <span title="${escapeHtml(t('search.highlights'))}"><span class="material-icons-round">format_quote</span>${document.highlightCount}</span>
                    <span title="${escapeHtml(document.statusLabel)}"><span class="material-icons-round">${document.loadedMatch ? 'task_alt' : 'warning_amber'}</span>${escapeHtml(document.statusLabel)}</span>
                    ${document.loadedMatch ? `<span title="${escapeHtml(document.loadedMatch.name)}"><span class="material-icons-round">link</span>${escapeHtml(document.loadedMatch.name)}</span>` : ''}
                  </div>
                  ${document.affectedPreview.length ? `
                    <div class="library-recovery-preview">
                      ${document.affectedPreview.map((entry) => `<span>${escapeHtml(entry)}</span>`).join('')}
                    </div>
                  ` : ''}
                </div>
                <div class="library-recovery-item-actions">
                  ${document.loadedMatch ? `<button type="button" class="library-recovery-btn icon-only-btn" data-recovery-match-id="${escapeHtml(document.id)}" title="${escapeHtml(t('recovery.matchExisting'))}" aria-label="${escapeHtml(t('recovery.matchExisting'))}"><span class="material-icons-round">link</span></button>` : ''}
                  <button type="button" class="library-recovery-btn secondary icon-only-btn" data-relink-document-id="${escapeHtml(document.id)}" title="${escapeHtml(t('recovery.relinkSource'))}" aria-label="${escapeHtml(t('recovery.relinkSource'))}"><span class="material-icons-round">upload_file</span></button>
                </div>
              </div>
            `).join('')}
          </div>
        </section>
    `;
}

export function createRecoveryWorkbenchController({
    getContext = getAppContext,
    renderFileList,
    refreshAnnotations,
    notify,
    promptBulkRelink,
    showValidation
} = {}) {
    function finalizeRelink() {
        renderFileList?.();
        refreshAnnotations?.();
    }

    function updateSummary(summary) {
        getContext().recoveryWorkbenchSummary = summary;
    }

    function attemptAutoRelinkRecoveredDocuments({ notifyUser = false } = {}) {
        const workbench = buildRecoveryWorkbenchModel(getContext());
        let matchedCount = 0;
        const matched = [];

        workbench.documents.forEach((document) => {
            if (!document.loadedMatch) {
                return;
            }

            if (relinkRecoveredDocument({
                documentId: document.id,
                loadedDocumentId: document.loadedMatch.id,
                appContext: getContext()
            })) {
                matchedCount += 1;
                matched.push({
                    id: document.id,
                    name: document.name,
                    matchedTo: document.loadedMatch.name
                });
            }
        });

        updateSummary({
            matched,
            remaining: workbench.documents.filter((document) => !document.loadedMatch).map((document) => ({
                id: document.id,
                name: document.name
            })),
            message: matchedCount > 0
                ? t('recovery.autoMatchedNames', { names: matched.map((entry) => `"${entry.name}"`).join(', ') })
                : t('recovery.noCandidates')
        });

        if (matchedCount > 0) {
            finalizeRelink();
        }

        if (notifyUser) {
            if (matchedCount > 0) {
                notify?.({
                    title: t('recovery.autoMatchDone.title'),
                    message: t(matchedCount === 1 ? 'recovery.autoMatchDone.message.one' : 'recovery.autoMatchDone.message.other', { count: matchedCount }),
                    level: 'success',
                    actions: [
                        { label: t('recovery.validate'), onClick: () => showValidation?.() }
                    ]
                });
            } else {
                notify?.({
                    title: t('recovery.autoMatch.title'),
                    message: t('recovery.autoMatch.noneLoaded'),
                    level: 'warning',
                    actions: [
                        { label: t('recovery.importSources'), onClick: () => promptBulkRelink?.() }
                    ]
                });
            }
        }

        return matchedCount;
    }

    function matchRecoveredDocument(documentId) {
        const workbench = buildRecoveryWorkbenchModel(getContext());
        const document = workbench.documents.find((item) => item.id === documentId);
        if (!document?.loadedMatch) {
            return false;
        }

        const relinked = relinkRecoveredDocument({
            documentId,
            loadedDocumentId: document.loadedMatch.id,
            appContext: getContext()
        });

        if (!relinked) {
            return false;
        }

        updateSummary({
            matched: [{
                id: document.id,
                name: document.name,
                matchedTo: document.loadedMatch.name
            }],
            remaining: workbench.documents
                .filter((item) => item.id !== document.id)
                .map((item) => ({ id: item.id, name: item.name })),
            message: t('recovery.linkedPair', { name: document.name, match: document.loadedMatch.name })
        });
        finalizeRelink();
        notify?.({
            title: t('recovery.relinked.title'),
            message: t('recovery.relinked.message', { name: document.name, match: document.loadedMatch.name }),
            level: 'success',
            actions: [
                { label: t('recovery.validate'), onClick: () => showValidation?.() }
            ]
        });
        return true;
    }

    function showRecoveryValidation() {
        const workbench = buildRecoveryWorkbenchModel(getContext());
        const unresolvedDocumentCount = workbench.documents.length;

        if (unresolvedDocumentCount === 0) {
            updateSummary({
                matched: [],
                remaining: [],
                message: t('recovery.allReady')
            });
            notify?.({
                title: t('recovery.linksReady.title'),
                message: t('recovery.linksReady.message', {
                    readyCards: workbench.readyCards,
                    totalCards: workbench.totalCards,
                    readyHighlights: workbench.readyHighlights,
                    totalHighlights: workbench.totalHighlights
                }),
                level: 'success',
                duration: 5200
            });
            return workbench;
        }

        notify?.({
            title: t('recovery.linksIncomplete.title'),
            message: t('recovery.linksIncomplete.message', {
                count: unresolvedDocumentCount,
                readyMatches: workbench.readyMatches,
                cards: workbench.unresolvedCards.length,
                highlights: workbench.unresolvedHighlights.length
            }),
            level: 'warning',
            duration: 6200,
            actions: [
                { label: t('recovery.autoMatch'), onClick: () => attemptAutoRelinkRecoveredDocuments({ notifyUser: true }) },
                { label: t('recovery.importSources'), onClick: () => promptBulkRelink?.() }
            ]
        });
        return workbench;
    }

    return {
        attemptAutoRelinkRecoveredDocuments,
        buildRecoveryWorkbenchModel: () => buildRecoveryWorkbenchModel(getContext()),
        matchRecoveredDocument,
        showRecoveryValidation
    };
}
