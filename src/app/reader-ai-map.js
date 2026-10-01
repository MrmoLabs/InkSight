function parseOutline(answer) {
    const entries = [];
    const stack = [];
    let headingDepth = -1;

    for (const line of String(answer ?? '').split(/\r?\n/)) {
        const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
        const bullet = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/);
        if (!heading && !bullet) continue;

        const depth = heading
            ? Math.min(2, heading[1].length - 1)
            : Math.min(2, headingDepth + 1 + Math.floor(bullet[1].replace(/\t/g, '  ').length / 2));
        if (heading) headingDepth = depth;
        const title = (heading ? heading[2] : bullet[2])
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/`([^`]*)`/g, '$1')
            .trim();
        if (!title) continue;

        const entry = { title, depth, children: [] };
        while (stack.length && stack.at(-1).depth >= depth) stack.pop();
        if (stack.length) stack.at(-1).entry.children.push(entry);
        else entries.push(entry);
        stack.push({ depth, entry });
    }

    if (entries.length === 0) {
        const fallback = String(answer ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (fallback) entries.push({ title: fallback.slice(0, 160), depth: 0, children: [] });
    }
    return entries;
}

export function createReaderAiMap({ passage, answer, cardSystem, graphNodesStore, idFactory }) {
    const card = Array.from(cardSystem?.cards?.values?.() ?? [])
        .find((item) => item.highlightId === passage?.id);
    if (!card || !String(answer ?? '').trim()) return null;

    const roots = parseOutline(answer);
    if (roots.length === 0) return null;

    const created = [];
    const addChildren = (entries, parentId) => {
        for (const entry of entries) {
            const id = idFactory();
            graphNodesStore.upsert({
                id,
                parentId,
                rootCardId: card.id,
                kind: 'ai',
                title: entry.title,
                question: entry.title,
                content: ''
            });
            created.push(id);
            addChildren(entry.children, id);
        }
    };
    addChildren(roots, card.id);
    return { card, rootCardId: card.id, nodeIds: created };
}
