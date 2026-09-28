import { getLocale, t } from '../i18n/index.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatTimestamp(timestamp) {
    if (!timestamp) {
        return t('home.notSaved');
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

export function buildProjectHomeModel(appContext = {}, projectStatus = {}) {
    const recentProjects = Array.isArray(projectStatus.recentProjects) ? projectStatus.recentProjects : [];
    const recentSnapshots = Array.isArray(projectStatus.snapshotHistory) ? projectStatus.snapshotHistory.slice(0, 4) : [];

    return {
        title: appContext.currentBook?.name || t('home.workspace'),
        canContinueWorkspace: recentSnapshots.length > 0 || Boolean(projectStatus.lastSavedAt),
        continueSummary: recentSnapshots.length
            ? t(recentSnapshots.length === 1 ? 'home.snapshotReady.one' : 'home.snapshotReady.other', { count: recentSnapshots.length })
            : t('home.resumeRuntime'),
        recentProjects,
        recentSnapshots
    };
}

export function renderProjectHome(model = {}) {
    const recentProjects = Array.isArray(model.recentProjects) ? model.recentProjects : [];
    const recentSnapshots = Array.isArray(model.recentSnapshots) ? model.recentSnapshots : [];

    const quickActions = [
        { action: 'import', icon: 'library_add', label: t('home.importDocuments'), hint: t('home.importHint') },
        { action: 'open-project', icon: 'folder_open', label: t('home.openProject'), hint: t('home.openHint') },
        { action: 'save-project', icon: 'save', label: t('home.saveProject'), hint: t('home.saveHint') },
        { action: 'export-notes', icon: 'note_add', label: t('home.exportNotes'), hint: t('home.exportHint') }
    ];

    return `
        <section class="project-home" aria-label="${escapeHtml(t('home.title'))}">
          <header class="project-home-hero">
            <span class="material-icons-round project-home-icon">auto_stories</span>
            <div class="project-home-copy">
              <h2>${escapeHtml(model.title || t('home.workspace'))}</h2>
              <p class="text-two-line">${escapeHtml(model.continueSummary || t('home.resumeOpenCapture'))}</p>
            </div>
            <div class="project-home-hero-actions">
              <button type="button" class="project-home-btn primary" data-home-action="continue-workspace" ${model.canContinueWorkspace ? '' : 'disabled'} title="${escapeHtml(t('home.resumeWorkspace'))}">
                <span class="material-icons-round">play_arrow</span>
                <span class="project-home-btn-label">${escapeHtml(t('home.resume'))}</span>
              </button>
            </div>
          </header>
          <div class="project-home-grid">
            <section class="project-home-section project-home-section-recent">
              <h3>${escapeHtml(t('home.recentProjects'))}</h3>
              <div class="project-home-list">
                ${recentProjects.length ? recentProjects.map((project) => `
                  <button type="button" class="project-home-list-item" data-recent-project-id="${escapeHtml(project.projectId)}">
                    <span class="material-icons-round project-home-list-icon">${project.source === 'project-folder' ? 'folder' : 'history'}</span>
                    <span class="project-home-list-copy">
                      <span class="text-two-line">${escapeHtml(project.projectName)}</span>
                      <span class="text-single-line">${escapeHtml(project.directoryName || (project.source === 'project-folder' ? t('home.projectFolder') : t('home.serverWorkspace')))} · ${formatTimestamp(project.lastOpenedAt)}</span>
                    </span>
                    <span class="material-icons-round project-home-list-arrow">arrow_forward</span>
                  </button>
                `).join('') : `<div class="project-home-list-empty">${escapeHtml(t('home.noRecentProjects'))}</div>`}
              </div>
            </section>
            <div class="project-home-side">
              <section class="project-home-section">
                <h3>${escapeHtml(t('home.quickActions'))}</h3>
                <div class="project-home-list">
                  ${quickActions.map((item) => `
                    <button type="button" class="project-home-list-item project-home-action-row" data-home-action="${item.action}">
                      <span class="material-icons-round project-home-list-icon">${item.icon}</span>
                      <span class="project-home-list-copy">
                        <span class="text-single-line">${escapeHtml(item.label)}</span>
                        <span class="text-single-line">${escapeHtml(item.hint)}</span>
                      </span>
                    </button>
                  `).join('')}
                </div>
              </section>
              <section class="project-home-section">
                <h3>${escapeHtml(t('home.snapshots'))}</h3>
                <div class="project-home-list">
                  ${recentSnapshots.length ? recentSnapshots.map((snapshot) => `
                    <button type="button" class="project-home-list-item" data-home-snapshot-id="${escapeHtml(snapshot.snapshotId)}">
                      <span class="material-icons-round project-home-list-icon">restore</span>
                      <span class="project-home-list-copy">
                        <span class="text-two-line">${escapeHtml(snapshot.projectName || t('home.workspaceSnapshot'))}</span>
                        <span class="text-single-line">${escapeHtml(snapshot.note ? `${snapshot.note} · ` : '')}${escapeHtml(snapshot.bookName || t('settings.workspace'))} · ${formatTimestamp(Date.parse(snapshot.savedAt || 0))}</span>
                      </span>
                      <span class="material-icons-round project-home-list-arrow">arrow_forward</span>
                    </button>
                  `).join('') : `<div class="project-home-list-empty">${escapeHtml(t('home.noSnapshots'))}</div>`}
                </div>
              </section>
            </div>
          </div>
        </section>
    `;
}
