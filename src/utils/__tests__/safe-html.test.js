import { describe, expect, it } from 'vitest';
import { isSafeExternalUrl, renderSafeMarkdown, sanitizeHtml } from '../safe-html.js';
import { escapeHtml } from '../escape-html.js';

describe('safe HTML rendering', () => {
    it('escapes user text for HTML text and attribute contexts', () => {
        expect(escapeHtml(`<note data-x="1" title='&'>`))
            .toBe('&lt;note data-x=&quot;1&quot; title=&#39;&amp;&#39;&gt;');
    });

    it('removes executable markup and unsafe URLs', () => {
        const html = sanitizeHtml(`
            <img src="x" onerror="window.pwned = true">
            <a href="javascript:window.pwned=true">bad</a>
            <form><input name="payload"></form>
        `);

        expect(html).not.toContain('onerror');
        expect(html).not.toContain('javascript:');
        expect(html).not.toContain('<form');
        expect(html).not.toContain('<input');
    });

    it('keeps ordinary Markdown while securing links', () => {
        const html = renderSafeMarkdown('[InkSight](https://example.com)\n\n**Safe**');

        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('<strong>Safe</strong>');
    });

    it('only permits web protocols for external navigation', () => {
        expect(isSafeExternalUrl('https://example.com')).toBe(true);
        expect(isSafeExternalUrl('http://example.com')).toBe(true);
        expect(isSafeExternalUrl('file:///C:/Windows/win.ini')).toBe(false);
        expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    });
});
