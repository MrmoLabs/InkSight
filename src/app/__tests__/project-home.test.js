import { describe, expect, it } from 'vitest';
import { buildProjectHomeModel, renderProjectHome } from '../project-home.js';

describe('project-home', () => {
    it('builds a home model with recent projects and snapshots', () => {
        const model = buildProjectHomeModel(
            { currentBook: { name: 'Research Workspace' } },
            {
                lastSavedAt: Date.now(),
                recentProjects: [{ projectId: 'project-1', projectName: 'Alpha', lastOpenedAt: 123 }],
                snapshotHistory: [{ snapshotId: 'snapshot-1', projectName: 'Alpha', bookName: 'Book.pdf', savedAt: '2026-04-17T10:00:00.000Z' }]
            }
        );

        expect(model.title).toBe('Research Workspace');
        expect(model.canContinueWorkspace).toBe(true);
        expect(model.recentProjects).toHaveLength(1);
        expect(model.recentSnapshots).toHaveLength(1);
    });

    it('renders home actions and recent project hooks', () => {
        const markup = renderProjectHome({
            title: 'Workspace',
            canContinueWorkspace: true,
            continueSummary: '1 snapshot ready',
            recentProjects: [{ projectId: 'project-1', projectName: 'Alpha', directoryName: 'AlphaDir', lastOpenedAt: 123 }],
            recentSnapshots: [{ snapshotId: 'snapshot-1', projectName: 'Alpha', bookName: 'Book.pdf', savedAt: '2026-04-17T10:00:00.000Z' }]
        });

        expect(markup).toContain('data-home-action="continue-workspace"');
        expect(markup).toContain('data-recent-project-id="project-1"');
        expect(markup).toContain('data-home-snapshot-id="snapshot-1"');
    });

    it('puts usable entry actions first when the workspace has no saved state', () => {
        const markup = renderProjectHome({ canContinueWorkspace: false });

        expect(markup).not.toContain('data-home-action="continue-workspace"');
        expect(markup).toContain('class="project-home-btn project-home-import primary" data-home-action="import"');
        expect(markup).toContain('data-home-action="open-project"');
    });
});
