import { getLocale, t } from '../i18n/index.js';
import { escapeHtml } from '../utils/escape-html.js';

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
            : projectStatus.lastSavedAt
                ? t('home.resumeRuntime')
                : t('home.resumeOpenCapture'),
        recentProjects,
        recentSnapshots
    };
}

export function renderProjectHome(model = {}) {
    const recentProjects = Array.isArray(model.recentProjects) ? model.recentProjects : [];
    const recentSnapshots = Array.isArray(model.recentSnapshots) ? model.recentSnapshots : [];

    const quickActions = [
        { action: 'open-project', icon: 'folder_open', label: t('home.openProject'), hint: t('home.openHint') },
        { action: 'save-project', icon: 'save', label: t('home.saveProject'), hint: t('home.saveHint') },
        { action: 'export-notes', icon: 'note_add', label: t('home.exportNotes'), hint: t('home.exportHint') }
    ];

    return `
        <section class="project-home project-home--immersive" aria-label="${escapeHtml(t('home.title'))}">
          <div class="project-home-shell">
          <div class="project-home-masthead">
            <div class="project-home-wordmark"><span class="project-home-mark">I</span><span>INKSIGHT</span></div>
            <div class="project-home-local"><span class="project-home-live-dot"></span>${escapeHtml(t('home.localFirst'))}</div>
          </div>
          <header class="project-home-hero">
            <div class="project-home-copy">
              <p class="project-home-kicker">${escapeHtml(t('home.kicker'))}</p>
              <h2>${escapeHtml(model.title || t('home.workspace'))}</h2>
              <p class="text-two-line">${escapeHtml(model.continueSummary || t('home.resumeOpenCapture'))}</p>
              <div class="project-home-hero-actions">
                ${model.canContinueWorkspace ? `
                  <button type="button" class="project-home-btn primary" data-home-action="continue-workspace" title="${escapeHtml(t('home.resumeWorkspace'))}">
                    <span class="material-icons-round" aria-hidden="true">play_arrow</span>
                    <span class="project-home-btn-label">${escapeHtml(t('home.resume'))}</span>
                    <span class="material-icons-round project-home-cta-arrow" aria-hidden="true">arrow_forward</span>
                  </button>
                ` : ''}
                <button type="button" class="project-home-btn project-home-import ${model.canContinueWorkspace ? '' : 'primary'}" data-home-action="import">
                  <span class="material-icons-round" aria-hidden="true">library_add</span>
                  <span class="project-home-btn-label">${escapeHtml(t('home.importDocuments'))}</span>
                  ${model.canContinueWorkspace ? '' : '<span class="material-icons-round project-home-cta-arrow" aria-hidden="true">arrow_forward</span>'}
                </button>
                ${model.canContinueWorkspace ? '' : `
                  <button type="button" class="project-home-btn" data-home-action="open-project">
                    <span class="material-icons-round" aria-hidden="true">folder_open</span>
                    <span class="project-home-btn-label">${escapeHtml(t('home.openProject'))}</span>
                  </button>
                `}
              </div>
            </div>
            <div class="project-home-scene" aria-hidden="true">
              <div class="project-home-scene-glow"></div>
              <div class="project-home-orbit project-home-orbit--outer"></div>
              <div class="project-home-orbit project-home-orbit--middle"></div>
              <div class="project-home-orbit project-home-orbit--inner"></div>
              <span class="project-home-star project-home-star--one"></span>
              <span class="project-home-star project-home-star--two"></span>
              <span class="project-home-star project-home-star--three"></span>
              <span class="project-home-star project-home-star--four"></span>
              <div class="project-home-book">
                <span class="project-home-book-glow"></span>
                <span class="material-icons-round">auto_stories</span>
                <span class="project-home-book-line project-home-book-line--one"></span>
                <span class="project-home-book-line project-home-book-line--two"></span>
              </div>
              <span class="project-home-orbit-node project-home-orbit-node--notes"><span class="material-icons-round">edit_note</span></span>
              <span class="project-home-orbit-node project-home-orbit-node--map"><span class="material-icons-round">account_tree</span></span>
              <span class="project-home-orbit-node project-home-orbit-node--search"><span class="material-icons-round">travel_explore</span></span>
              <span class="project-home-scene-caption">${escapeHtml(t('home.sceneCaption'))}</span>
              <span class="project-home-scene-index">01 / INK</span>
            </div>
          </header>
          <section class="project-home-quick" aria-label="${escapeHtml(t('home.quickActions'))}">
            <div class="project-home-section-heading"><span>${escapeHtml(t('home.quickActions'))}</span><span class="project-home-heading-rule"></span><span class="project-home-heading-index">${escapeHtml(t('home.actionsIndex'))}</span></div>
            <div class="project-home-quick-grid">
              ${quickActions.map((item, index) => `
                <button type="button" class="project-home-quick-card" data-home-action="${item.action}" style="--home-card-index:${index}">
                  <span class="project-home-quick-top"><span class="project-home-quick-icon material-icons-round" aria-hidden="true">${item.icon}</span><span class="project-home-quick-number" aria-hidden="true">0${index + 1}</span></span>
                  <span class="project-home-quick-title">${escapeHtml(item.label)}</span>
                  <span class="project-home-quick-hint">${escapeHtml(item.hint)}</span>
                  <span class="material-icons-round project-home-quick-arrow" aria-hidden="true">arrow_outward</span>
                </button>
              `).join('')}
            </div>
          </section>
          <div class="project-home-grid">
            <section class="project-home-section project-home-section-recent">
              <div class="project-home-section-heading"><span>${escapeHtml(t('home.recentProjects'))}</span><span class="project-home-heading-rule"></span><span class="project-home-heading-index">01</span></div>
              <div class="project-home-list">
                ${recentProjects.length ? recentProjects.map((project) => `
                  <button type="button" class="project-home-list-item" data-recent-project-id="${escapeHtml(project.projectId)}">
                    <span class="material-icons-round project-home-list-icon" aria-hidden="true">${project.source === 'project-folder' ? 'folder' : 'history'}</span>
                    <span class="project-home-list-copy">
                      <span class="text-two-line">${escapeHtml(project.projectName)}</span>
                      <span class="text-single-line">${escapeHtml(project.directoryName || (project.source === 'project-folder' ? t('home.projectFolder') : t('home.serverWorkspace')))} · ${formatTimestamp(project.lastOpenedAt)}</span>
                    </span>
                    <span class="material-icons-round project-home-list-arrow" aria-hidden="true">arrow_forward</span>
                  </button>
                `).join('') : `<div class="project-home-list-empty">${escapeHtml(t('home.noRecentProjects'))}</div>`}
              </div>
            </section>
            <section class="project-home-section project-home-section-snapshots">
              <div class="project-home-section-heading"><span>${escapeHtml(t('home.snapshots'))}</span><span class="project-home-heading-rule"></span><span class="project-home-heading-index">02</span></div>
              <div class="project-home-list">
                ${recentSnapshots.length ? recentSnapshots.map((snapshot) => `
                  <button type="button" class="project-home-list-item" data-home-snapshot-id="${escapeHtml(snapshot.snapshotId)}">
                    <span class="material-icons-round project-home-list-icon" aria-hidden="true">restore</span>
                    <span class="project-home-list-copy">
                      <span class="text-two-line">${escapeHtml(snapshot.projectName || t('home.workspaceSnapshot'))}</span>
                      <span class="text-single-line">${escapeHtml(snapshot.note ? `${snapshot.note} · ` : '')}${escapeHtml(snapshot.bookName || t('settings.workspace'))} · ${formatTimestamp(Date.parse(snapshot.savedAt || 0))}</span>
                    </span>
                    <span class="material-icons-round project-home-list-arrow" aria-hidden="true">arrow_forward</span>
                  </button>
                `).join('') : `<div class="project-home-list-empty">${escapeHtml(t('home.noSnapshots'))}</div>`}
              </div>
            </section>
          </div>
          <footer class="project-home-footer"><span>${escapeHtml(t('home.footer'))}</span><span class="project-home-footer-pulse"></span><span>${escapeHtml(t('home.localFirst'))}</span></footer>
          </div>
        </section>
    `;
}
