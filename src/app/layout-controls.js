import { registerEventListeners } from './event-listeners.js';
import { settingsModal } from '../ui/settings-modal.js';

export function setupLayoutToggles({
    elements,
    registerCleanup,
    splitView,
    outlineSidebar,
    setWorkspaceMode,
    updatePanelControls,
    setMobileToolbarExpanded,
    setMobileNotesViewHandler
}) {
    const toggleAnnotationsBtn = document.getElementById('toggle-annotations');
    const annotationListContainer = document.getElementById('annotation-list');
    const showAnnotationsBtn = document.getElementById('show-annotations');
    const showMindmapBtn = document.getElementById('show-mindmap');

    // Notes panel view state, shared by every layout: 'annotations' and
    // 'mindmap' focus a single pane, 'split' keeps both with the resizer.
    // Workspace modes preset this value; the panel switcher refines it.
    const setNotesView = (view) => {
        const nextView = view === 'mindmap' || view === 'split' ? view : 'annotations';
        document.body.dataset.notesView = nextView;
        showAnnotationsBtn?.classList.toggle('active', nextView === 'annotations');
        showAnnotationsBtn?.setAttribute('aria-selected', String(nextView === 'annotations'));
        showMindmapBtn?.classList.toggle('active', nextView === 'mindmap');
        showMindmapBtn?.setAttribute('aria-selected', String(nextView === 'mindmap'));
    };

    setMobileNotesViewHandler(setNotesView);

    const syncNotesLayoutMode = () => {
        if (document.body.classList.contains('mobile-layout')) {
            annotationListContainer?.classList.remove('collapsed');
            toggleAnnotationsBtn?.classList.add('active');
        }

        setNotesView(document.body.dataset.notesView || 'split');
    };

    if (toggleAnnotationsBtn && annotationListContainer) {
        registerCleanup(registerEventListeners([
            {
                target: toggleAnnotationsBtn,
                event: 'click',
                handler: () => {
                    if (document.body.classList.contains('mobile-layout')) {
                        setMobileNotesView('annotations');
                        return;
                    }

                    const isCollapsed = annotationListContainer.classList.toggle('collapsed');
                    toggleAnnotationsBtn.classList.toggle('active', !isCollapsed);
                }
            }
        ]));
    }

    registerCleanup(registerEventListeners([
        {
            target: showAnnotationsBtn,
            event: 'click',
            handler: () => {
                // View switcher only: picking the active view again returns to
                // the split layout. Workspace modes are not changed here.
                setNotesView(document.body.dataset.notesView === 'annotations' ? 'split' : 'annotations');
            }
        },
        {
            target: showMindmapBtn,
            event: 'click',
            handler: () => {
                setNotesView(document.body.dataset.notesView === 'mindmap' ? 'split' : 'mindmap');
            }
        },
        {
            target: window,
            event: 'resize',
            handler: syncNotesLayoutMode
        }
    ].filter(({ target }) => target)));

    syncNotesLayoutMode();

    if (elements.toggleSidebarBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.toggleSidebarBtn,
                event: 'click',
                handler: () => {
                    splitView?.toggleLeft();
                    setWorkspaceMode('reading');
                }
            }
        ]));
    }

    const settingsButtons = [...document.querySelectorAll('[data-open-settings]')];
    if (settingsButtons.length) {
        registerCleanup(registerEventListeners(settingsButtons.map((target) => ({
            target,
            event: 'click',
            handler: () => settingsModal.open()
        }))));
    }

    const toolbarMenus = [...document.querySelectorAll('.toolbar-menu')];
    if (toolbarMenus.length) {
        const closeMenus = ({ restoreFocus = false } = {}) => {
            toolbarMenus.forEach((menu) => {
                if (!menu.open) return;
                menu.open = false;
                if (restoreFocus) {
                    menu.querySelector(':scope > summary')?.focus();
                }
            });
        };

        registerCleanup(registerEventListeners([
            ...toolbarMenus.map((menu) => ({
                target: menu,
                event: 'toggle',
                handler: () => {
                    if (!menu.open) return;
                    toolbarMenus.forEach((otherMenu) => {
                        if (otherMenu !== menu) otherMenu.open = false;
                    });
                }
            })),
            ...toolbarMenus.map((menu) => ({
                target: menu,
                event: 'click',
                handler: (event) => {
                    if (event.target.closest?.('button')) {
                        menu.open = false;
                    }
                }
            })),
            {
                target: document,
                event: 'click',
                handler: (event) => {
                    if (!toolbarMenus.some((menu) => menu.contains(event.target))) {
                        closeMenus();
                    }
                }
            },
            {
                target: document,
                event: 'keydown',
                handler: (event) => {
                    if (event.key === 'Escape') {
                        closeMenus({ restoreFocus: true });
                    }
                }
            }
        ]));
    }

    if (elements.closeSidebarPanelBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.closeSidebarPanelBtn,
                event: 'click',
                handler: () => {
                    splitView?.setLeftCollapsed(true);
                    updatePanelControls();
                }
            }
        ]));
    }

    if (elements.toggleNotesBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.toggleNotesBtn,
                event: 'click',
                handler: () => {
                    // Pure visibility toggle. Forcing a mode switch here used to
                    // re-apply the mode layout, which instantly re-expanded the
                    // panel — the notes panel could never stay collapsed.
                    splitView?.toggleRight();
                }
            }
        ]));
    }

    if (elements.closeNotesPanelBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.closeNotesPanelBtn,
                event: 'click',
                handler: () => {
                    splitView?.setRightCollapsed(true);
                    setMobileToolbarExpanded(false);
                    updatePanelControls();
                }
            }
        ]));
    }

    if (elements.closeOutlinePanelBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.closeOutlinePanelBtn,
                event: 'click',
                handler: () => {
                    outlineSidebar?.close();
                    updatePanelControls();
                }
            }
        ]));
    }

    registerCleanup(registerEventListeners([
        elements.sidebarWidthPresetBtn && {
            target: elements.sidebarWidthPresetBtn,
            event: 'click',
            handler: () => splitView?.cyclePanelPreset('left')
        },
        elements.toolbarSidebarWidthPresetBtn && {
            target: elements.toolbarSidebarWidthPresetBtn,
            event: 'click',
            handler: () => splitView?.cyclePanelPreset('left')
        },
        elements.notesWidthPresetBtn && {
            target: elements.notesWidthPresetBtn,
            event: 'click',
            handler: () => splitView?.cyclePanelPreset('right')
        },
        elements.toolbarNotesWidthPresetBtn && {
            target: elements.toolbarNotesWidthPresetBtn,
            event: 'click',
            handler: () => splitView?.cyclePanelPreset('right')
        }
    ].filter(Boolean)));

    if (elements.toggleMobileToolsBtn) {
        registerCleanup(registerEventListeners([
            {
                target: elements.toggleMobileToolsBtn,
                event: 'click',
                handler: () => {
                    const nextExpanded = !elements.readerToolbar?.classList.contains('mobile-tools-open');
                    setMobileToolbarExpanded(nextExpanded);
                }
            },
            {
                target: document,
                event: 'click',
                handler: (e) => {
                    if (!document.body.classList.contains('mobile-layout')) {
                        return;
                    }

                    if (!elements.readerToolbar?.contains(e.target)) {
                        setMobileToolbarExpanded(false);
                    }
                }
            }
        ]));
    }

    registerCleanup(registerEventListeners([
        elements.workspaceModeReadingBtn && {
            target: elements.workspaceModeReadingBtn,
            event: 'click',
            handler: () => setWorkspaceMode('reading')
        },
        elements.workspaceModeCaptureBtn && {
            target: elements.workspaceModeCaptureBtn,
            event: 'click',
            handler: () => setWorkspaceMode('capture')
        },
        elements.workspaceModeMapBtn && {
            target: elements.workspaceModeMapBtn,
            event: 'click',
            handler: () => setWorkspaceMode('map')
        },
        elements.mobileWorkspaceModeReadingBtn && {
            target: elements.mobileWorkspaceModeReadingBtn,
            event: 'click',
            handler: () => setWorkspaceMode('reading')
        },
        elements.mobileWorkspaceModeCaptureBtn && {
            target: elements.mobileWorkspaceModeCaptureBtn,
            event: 'click',
            handler: () => setWorkspaceMode('capture')
        },
        elements.mobileWorkspaceModeMapBtn && {
            target: elements.mobileWorkspaceModeMapBtn,
            event: 'click',
            handler: () => setWorkspaceMode('map')
        }
    ].filter(Boolean)));
}
