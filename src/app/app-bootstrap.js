import { SplitView } from '../ui/split-view.js';
import { OutlineSidebar } from '../ui/outline-sidebar.js';
import { AnnotationList } from '../ui/annotation-list.js';
import { mountAppNotifications } from '../ui/app-notifications.js';
import { getAppContext, setAppService } from './app-context.js';
import { getRuntimeStorageInfo } from '../inksight-file/inksight-runtime-project-io.js';
import { registerEventListeners } from './event-listeners.js';
import { setupSelectionSync } from './selection-sync.js';
import { setupLayoutToggles as setupLayoutControls } from './layout-controls.js';
import { setupReaderToolbarEvents } from './reader-toolbar-events.js';
import { createWorkspaceEventListeners } from './workspace-events.js';
import { APP_EVENTS } from '../core/event-names.js';

export function setupAppEventListeners({
    registerCleanup,
    elements,
    projectWorkspace,
    workspaceDocuments,
    ui,
    navigation,
    dragState,
    selectionSync,
    toolbar
}) {
    registerCleanup(registerEventListeners(createWorkspaceEventListeners({
        elements,
        projectWorkspace,
        workspaceDocuments,
        ui,
        navigation,
        dragState
    })));

    registerCleanup(setupSelectionSync({
        ...selectionSync
    }));

    setupReaderToolbarEvents({
        registerCleanup,
        ...toolbar,
        setAppService
    });
}

export async function initAppBootstrap({
    elements,
    registerCleanup,
    services,
    hooks
}) {
    try {
        services.projectWorkspace.ensureProjectIdentity();
        const runtimeStorageInfo = await getRuntimeStorageInfo().catch(() => null);
        if (runtimeStorageInfo) {
            setAppService('runtimeStorageInfo', runtimeStorageInfo);
        }

        hooks.updateToolbarSummary();

        const splitView = new SplitView({
            leftId: 'sidebar',
            centerId: 'reader-container',
            rightId: 'notes-panel',
            resizerLeftId: 'resizer-left',
            resizerRightId: 'resizer-right'
        });

        const outlineSidebar = new OutlineSidebar('outline-sidebar', 'outline-content', 'toggle-outline');
        setAppService('outlineSidebar', outlineSidebar);

        const annotationList = new AnnotationList('annotation-list', getAppContext().cardSystem);
        setAppService('annotationList', annotationList);

        hooks.setupEventListeners({ splitView, outlineSidebar, annotationList });
        hooks.currentToolModeSync();

        setupLayoutControls({
            elements,
            registerCleanup,
            splitView,
            outlineSidebar,
            setWorkspaceMode: hooks.setWorkspaceMode,
            updatePanelControls: hooks.getSplitViewDeps().updatePanelControls,
            setMobileToolbarExpanded: hooks.getSplitViewDeps().setMobileToolbarExpanded,
            setMobileNotesViewHandler: hooks.setMobileNotesViewHandler
        });

        hooks.setupResponsiveLayout({ splitView, outlineSidebar });
        hooks.setupFloatingSelectionToolbar();
        registerCleanup(mountAppNotifications(elements.appNotifications));
        services.projectWorkspace.restartProjectAutosave();
        hooks.workspaceModeReadingInit();
        await services.projectWorkspace.restoreRuntimeWorkspace();

        registerCleanup(registerEventListeners([
            {
                target: window,
                event: APP_EVENTS.RESTORE_PAGE_POSITION,
                handler: hooks.handleRestorePagePosition
            }
        ]));

        return { splitView, outlineSidebar, annotationList };
    } catch (error) {
        services.logger.error('Error opening file', error);
        return null;
    }
}
