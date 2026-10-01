/** Guard corrupted zoom and pan values before they enter a save/restore cycle. */
export function sanitizeViewport(viewport) {
    if (!viewport || typeof viewport !== 'object') {
        return null;
    }

    const next = { ...viewport };
    const zoom = Number(next.zoom);
    if (!Number.isFinite(zoom) || zoom <= 0.01 || zoom >= 20) {
        next.zoom = 1;
    }
    for (const key of Object.keys(next)) {
        if (key === 'zoom') continue;
        const value = Number(next[key]);
        if (typeof next[key] === 'number' && !Number.isFinite(value)) {
            next[key] = 0;
        }
    }
    return next;
}
