import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchController } from '../search-controller.js';

describe('search-controller', () => {
    let elements;
    let onResultSelected;

    beforeEach(() => {
        document.body.innerHTML = `
            <button id="toolbar-search"></button>
            <div id="search-panel">
              <input id="search-input" />
              <div id="search-empty"></div>
              <div id="search-results"></div>
            </div>
        `;

        elements = {
            toolbarSearchBtn: document.getElementById('toolbar-search'),
            searchPanel: document.getElementById('search-panel'),
            workspaceSearchInput: document.getElementById('search-input'),
            workspaceSearchEmpty: document.getElementById('search-empty'),
            workspaceSearchResults: document.getElementById('search-results')
        };
        onResultSelected = vi.fn();
    });

    it('renders grouped results and routes selected items', () => {
        const controller = createSearchController({
            elements,
            buildIndex: () => [{ id: 'doc-1', type: 'document', title: 'Alpha.pdf', excerpt: 'PDF', actionPayload: { documentId: 'doc-1' } }],
            queryIndex: () => [{ id: 'doc-1', type: 'document', title: 'Alpha.pdf', excerpt: 'PDF', actionPayload: { documentId: 'doc-1' } }],
            getFiles: () => [],
            onResultSelected
        });

        controller.bind();
        elements.toolbarSearchBtn.click();

        expect(elements.searchPanel.classList.contains('visible')).toBe(true);

        elements.workspaceSearchResults.querySelector('[data-search-result-id="doc-1"]').click();

        expect(onResultSelected).toHaveBeenCalledWith(expect.objectContaining({
            id: 'doc-1',
            type: 'document'
        }));
        expect(elements.searchPanel.classList.contains('visible')).toBe(false);
    });

    it('renders untrusted result content as text instead of HTML', () => {
        const result = {
            id: 'doc-1" data-injected="yes',
            type: 'document',
            title: '<img src=x onerror=alert(1)>',
            excerpt: '<svg onload=alert(1)>',
            actionPayload: { documentId: 'doc-1' }
        };
        const controller = createSearchController({
            elements,
            buildIndex: () => [result],
            queryIndex: () => [result],
            getFiles: () => [],
            onResultSelected
        });

        controller.refreshResults();

        expect(elements.workspaceSearchResults.querySelector('img, svg')).toBeNull();
        expect(elements.workspaceSearchResults.querySelector('[data-injected]')).toBeNull();
        expect(elements.workspaceSearchResults.textContent).toContain(result.title);
        expect(elements.workspaceSearchResults.textContent).toContain(result.excerpt);
        expect(elements.workspaceSearchResults.querySelector('.workspace-search-result').getAttribute('data-search-result-id'))
            .toBe(result.id);
    });
});
