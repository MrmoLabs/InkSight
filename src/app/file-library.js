import { getAppContext } from './app-context.js';
import { renderRecoveryWorkbenchMarkup, buildRecoveryWorkbenchModel } from './recovery-workbench.js';
import { getLocale, t } from '../i18n/index.js';
import { escapeHtml } from '../utils/escape-html.js';

function describeDocumentStatus(file, index) {
    if (file.loaded) {
        const typeLabel = String(file.type || '')
            .replace('application/', '')
            .replace('text/', '')
            .toUpperCase();
        return typeLabel || `DOC ${index + 1}`;
    }

    return t('library.missing');
}

function documentTypeBadge(file) {
    const fromMime = String(file.type || '').toLowerCase();
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    if (fromMime.includes('pdf') || extension === 'pdf') {
        return { icon: 'picture_as_pdf', modifier: 'pdf' };
    }
    if (fromMime.includes('epub') || extension === 'epub') {
        return { icon: 'menu_book', modifier: 'epub' };
    }
    if (extension === 'md' || fromMime.includes('markdown')) {
        return { icon: 'article', modifier: 'md' };
    }
    return { icon: 'description', modifier: 'txt' };
}

function formatSnapshotTime(savedAt) {
    const timestamp = Date.parse(savedAt || 0);
    if (!timestamp) {
        return t('library.notSaved');
    }

    try {
        return new Intl.DateTimeFormat(getLocale(), {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleString();
    }
}

export function getCardsCollection(cardSystem = getAppContext().cardSystem) {
    const cards = cardSystem?.cards;
    if (cards instanceof Map) {
        return Array.from(cards.values());
    }

    return Object.values(cards || {});
}

export function getVisibleDocuments(files, documentManager = getAppContext().documentManager) {
    const registeredDocuments = documentManager?.getAllDocuments?.() ?? [];
    const importedFileIds = new Set(files.map((file) => file.id));
    const visibleDocuments = files.map((file) => ({
        id: file.id,
        name: file.name,
        type: file.type,
        loaded: true,
        fileData: file
    }));

    registeredDocuments.forEach((doc) => {
        if (importedFileIds.has(doc.id)) {
            return;
        }

        visibleDocuments.push({
            ...doc,
            fileData: null
        });
    });

    return visibleDocuments;
}

export function getDocumentReferenceDetails(documentId, {
    cardSystem = getAppContext().cardSystem,
    highlightManager = getAppContext().highlightManager
} = {}) {
    const cardCount = getCardsCollection(cardSystem).filter((card) => card.sourceId === documentId).length;
    const highlightCount = highlightManager?.highlights?.filter((highlight) => highlight.sourceId === documentId).length ?? 0;

    return {
        cardCount,
        highlightCount,
        referenceCount: cardCount + highlightCount
    };
}

export function createFileLibraryRenderer({
    fileListElement,
    getFiles,
    getCurrentFileId,
    getProjectStatus
}) {
    return function renderFileList() {
        const files = getFiles();
        const visibleDocuments = getVisibleDocuments(files);
        const workbench = buildRecoveryWorkbenchModel(getAppContext());
        const projectStatus = getProjectStatus();
        const snapshotHistory = Array.isArray(projectStatus.snapshotHistory) ? projectStatus.snapshotHistory : [];
        const latestSnapshot = snapshotHistory[0] ?? null;
        const projectStatusLabel = projectStatus.linkedToDirectory ? t('library.linked') : t('library.autosave');

        const projectPanelMarkup = `
        <section class="library-project-panel workspace-card compact-footer" aria-label="${escapeHtml(t('a11y.projectActions'))}">
          <div class="library-project-header">
            <div class="library-project-copy">
              <strong class="text-single-line">${escapeHtml(projectStatus.title)}</strong>
              <span class="library-project-status text-single-line">${projectStatusLabel}</span>
            </div>
            <button type="button" class="library-project-refresh-btn" data-project-action="history" title="${escapeHtml(t('library.refreshHistory'))}" aria-label="${escapeHtml(t('library.refreshHistory'))}">
              <span class="material-icons-round">refresh</span>
            </button>
          </div>
          <div class="library-project-actions">
            <button type="button" class="library-project-btn labeled" data-project-action="snapshot" title="${escapeHtml(t('library.snapshotTitle'))}">
              <span class="material-icons-round">bookmark_add</span><span>${escapeHtml(t('library.snapshot'))}</span>
            </button>
            <button type="button" class="library-project-btn labeled" data-project-action="open" title="${escapeHtml(t('library.openFolderTitle'))}">
              <span class="material-icons-round">folder_open</span><span>${escapeHtml(t('app.open'))}</span>
            </button>
            <button type="button" class="library-project-btn labeled" data-project-action="save" title="${escapeHtml(t('library.saveFolderTitle'))}">
              <span class="material-icons-round">save</span><span>${escapeHtml(t('app.save'))}</span>
            </button>
            <button type="button" class="library-project-btn labeled" data-project-action="import" title="${escapeHtml(t('home.importDocuments'))}">
              <span class="material-icons-round">library_add</span><span>${escapeHtml(t('app.import'))}</span>
            </button>
          </div>
          ${latestSnapshot ? `
          <button type="button" class="library-project-snapshot-row" data-project-history-id="${escapeHtml(latestSnapshot.snapshotId)}" title="${escapeHtml(t('library.restoreSnapshotTitle'))}">
            <span class="material-icons-round">restore</span>
            <span class="library-project-snapshot-copy">
              <span class="text-single-line">${escapeHtml(t('library.lastSnapshot'))}</span>
              <span class="text-single-line">${formatSnapshotTime(latestSnapshot.savedAt)}</span>
            </span>
            <span class="library-project-snapshot-restore">${escapeHtml(t('library.restore'))}</span>
          </button>` : ''}
        </section>
    `;

        if (!visibleDocuments.length) {
            fileListElement.innerHTML = `
            <div class="library-empty-state">
              <span class="material-icons-round">upload_file</span>
              <h3>${escapeHtml(t('library.empty'))}</h3>
              <p>${escapeHtml(t('library.importOrOpen'))}</p>
            </div>
        `;
            return;
        }

        const recoveryMarkup = renderRecoveryWorkbenchMarkup(workbench);

        fileListElement.innerHTML = `
        <div class="library-documents">
        ${visibleDocuments.map((file, index) => `
        <div class="file-item ${getCurrentFileId() === file.id ? 'active' : ''} ${file.loaded ? '' : 'disabled'}"
             data-open-file-id="${escapeHtml(file.id)}"
             data-file-index="${index}"
             draggable="${file.loaded ? 'true' : 'false'}"
             title="${escapeHtml(file.loaded ? file.name : t('library.relinkHint', { name: file.name }))}">
          ${(() => {
              const badge = documentTypeBadge(file);
              return `<span class="material-icons-round file-item-icon file-item-icon--${badge.modifier}">${badge.icon}</span>`;
          })()}
          <span class="file-item-body">
            <span class="file-item-name text-two-line">${escapeHtml(file.name)}</span>
            <span class="file-item-meta text-single-line">${escapeHtml(describeDocumentStatus(file, index))}</span>
          </span>
          ${file.loaded ? `
          <span class="file-item-actions">
            <button type="button" class="file-item-action-btn" data-file-action="move-up" data-file-id="${escapeHtml(file.id)}" title="${escapeHtml(t('library.moveUp'))}" ${index === 0 ? 'disabled' : ''}>
              <span class="material-icons-round">keyboard_arrow_up</span>
            </button>
            <button type="button" class="file-item-action-btn" data-file-action="move-down" data-file-id="${escapeHtml(file.id)}" title="${escapeHtml(t('library.moveDown'))}" ${index === files.length - 1 ? 'disabled' : ''}>
              <span class="material-icons-round">keyboard_arrow_down</span>
            </button>
            <button type="button" class="file-item-action-btn danger" data-file-action="remove" data-file-id="${escapeHtml(file.id)}" title="${escapeHtml(t('library.removeFromLibrary'))}">
              <span class="material-icons-round">delete</span>
            </button>
          </span>
          ` : ''}
        </div>
    `).join('')}
        </div>
        ${recoveryMarkup}
        ${projectPanelMarkup}
    `;
    };
}
