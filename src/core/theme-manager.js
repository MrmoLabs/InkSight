/**
 * ThemeManager - Centralized theme management for the entire application
 * Syncs with Drawnix Mind Map theme changes
 */

class ThemeManager {
    constructor() {
        this.currentTheme = 'default'; // default, colorful, soft, retro, dark, starry, yorha-light, yorha-dark (legacy "yorha" aliases to dark)
        this.listeners = new Set();
        this.STORAGE_KEY = 'inksight:theme';
        this.init();
    }

    init() {
        // Restore the persisted choice so the toolbar select stays in sync.
        try {
            const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(this.STORAGE_KEY) : null;
            if (stored && stored !== this.currentTheme) {
                this.currentTheme = stored;
            }
        } catch {
            // localStorage unavailable (private mode) — keep default.
        }
        document.documentElement.dataset.theme = this.currentTheme;
    }

    setTheme(themeName) {
        if (this.currentTheme === themeName) return;

        this.currentTheme = themeName;
        document.documentElement.dataset.theme = themeName;

        try {
            localStorage.setItem(this.STORAGE_KEY, themeName);
        } catch {
            // Ignore persistence failures — the session theme still applies.
        }

        // Notify all listeners
        this.listeners.forEach(fn => fn(themeName));

        console.log(`Theme changed to: ${themeName}`);
    }

    getTheme() {
        return this.currentTheme;
    }

    subscribe(callback) {
        this.listeners.add(callback);
        return () => this.unsubscribe(callback);
    }

    unsubscribe(callback) {
        this.listeners.delete(callback);
    }
}

export const themeManager = new ThemeManager();
