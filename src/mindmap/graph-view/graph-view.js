import { hierarchy, tree as d3tree } from 'd3-hierarchy';
import {
    forceCollide,
    forceManyBody,
    forceSimulation,
    forceX,
    forceY
} from 'd3-force';
import { buildGraphTree } from './graph-tree.js';
import { graphNodesStore } from './graph-nodes-store.js';
import { GraphAiController } from './graph-ai-controller.js';
import { cancelBoardCardFlash } from '../drawnix-board-interactions.js';
import { getAppContext } from '../../app/app-context.js';
import { chatStream } from '../../core/ai-client.js';
import { modalManager } from '../../ui/modal-manager.js';
import { emitAppNotification } from '../../ui/app-notifications.js';
import { t } from '../../i18n/index.js';
import { isSafeExternalUrl, renderSafeMarkdown } from '../../utils/safe-html.js';
import './graph-view.css';

const NS = 'http://www.w3.org/2000/svg';

function escapelessText(parent, text) {
    parent.appendChild(document.createTextNode(text));
}

export class GraphViewController {
    constructor() {
        this.isOpen = false;
        this.overlay = null;
        this.simulation = null;
        this.nodes = [];
        this.links = [];
        this.rawTree = null;
        this.childNodesByNodeId = null;
        this.transform = { x: 0, y: 0, scale: 1 };
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.selectedTextContext = null;
        this.selectedNodeId = null;
        this.selectedNodeAt = 0;
        this.lastSelectionGesture = null;
        this.suppressSelectionPillUntil = 0;
        this.justClickedMarkTimestamp = 0;
        this.edgeItems = new Map();
        this.hoverTimer = null;
        this.chatStream = chatStream;
        this.aiController = new GraphAiController({
            getNodeById: (nodeId) => this.nodeById?.get(nodeId),
            getBubbleElement: (nodeId) => document.getElementById(this.domId(nodeId)),
            buildConversation: (parentId, question) => this.buildConversation(parentId, question),
            updateNodeContent: (nodeId, text) => this.updateNodeContent(nodeId, text),
            renderNodeBody: (nodeId, text) => this.renderNodeBody(nodeId, text),
            chatStream: (...args) => this.chatStream(...args)
        });
    }

    mount() {
        if (this.overlay) {
            return;
        }

        const container = document.getElementById('mindmap-container');
        if (!container) {
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'graph-view';
        overlay.innerHTML = `
            <div class="graph-view__hud">
                <button type="button" class="graph-view__back">
                    ${t('graph.back')}
                </button>
                <div class="graph-view__title"></div>
            </div>
            <div class="graph-view__controls">
                <button type="button" class="graph-view__btn graph-view__center">
                    ${t('graph.center')}
                </button>
            </div>
            <div class="graph-view__viewport">
                <div class="graph-view__world">
                    <svg class="graph-view__svg"><g class="graph-view__edges"></g></svg>
                    <div class="graph-view__nodes"></div>
                </div>
            </div>
            <div class="graph-view__dialog" hidden>
                <div class="graph-view__dialog-card">
                    <div class="graph-view__dialog-title">${t('graph.extend')}</div>
                    <textarea class="graph-view__dialog-input" rows="3"
                        placeholder="${t('graph.promptPlaceholder')}"></textarea>
                    <div class="graph-view__dialog-actions">
                        <button type="button" class="graph-view__dialog-btn" data-action="cancel">${t('common.cancel')}</button>
                        <button type="button" class="graph-view__dialog-btn" data-action="manual">${t('graph.manual')}</button>
                        <button type="button" class="graph-view__dialog-btn graph-view__dialog-btn--primary" data-action="ai">${t('graph.aiAnswer')}</button>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(overlay);
        this.overlay = overlay;

        // 选区胶囊挂到 body：面板祖先链上的 transform 会劫持 fixed 定位
        const selectionPill = document.createElement('div');
        selectionPill.className = 'graph-view__pill';
        selectionPill.textContent = t('graph.extendNode');
        document.body.appendChild(selectionPill);
        this.selectionPill = selectionPill;

        this.viewport = overlay.querySelector('.graph-view__viewport');
        this.world = overlay.querySelector('.graph-view__world');
        this.nodesContainer = overlay.querySelector('.graph-view__nodes');
        this.nodesContainer.setAttribute('role', 'list');
        this.edgesLayer = overlay.querySelector('.graph-view__edges');
        this.titleEl = overlay.querySelector('.graph-view__title');
        this.dialogEl = overlay.querySelector('.graph-view__dialog');
        this.dialogInput = overlay.querySelector('.graph-view__dialog-input');
        this.dialogTitleEl = overlay.querySelector('.graph-view__dialog-title');
        this.dialogContext = null;

        overlay.querySelector('.graph-view__back').addEventListener('click', () => this.close());
        overlay.querySelector('.graph-view__center').addEventListener('click', () => {
            const root = this.nodes?.[0];
            if (root) {
                this.focusOnNode(root.id, 'self');
            }
        });

        this.dialogEl.addEventListener('click', (e) => {
            if (e.target === this.dialogEl) {
                this.hideDialog();
                return;
            }
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (!action) {
                return;
            }
            e.stopPropagation();
            if (action === 'cancel') {
                this.hideDialog();
            } else if (action === 'ai') {
                this.submitExtendDialog('ai');
            } else if (action === 'manual') {
                this.submitExtendDialog('manual');
            }
        });
        this.dialogInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // 有选区的上下文默认走 AI 回答，手动添加默认创建普通节点
                this.submitExtendDialog(this.dialogContext?.range ? 'ai' : 'manual');
            }
        });

        this.viewport.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.graph-bubble') || e.target.closest('.graph-view__pill')) return;
            this.setSelectedNode(null);
            this.isPanning = true;
            this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
            this.viewport.classList.add('panning');
        });

        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
        this.viewport.addEventListener('wheel', this.onWheel, { passive: false });
        document.addEventListener('pointerdown', this.onPointerDownCapture, true);
        document.addEventListener('selectionchange', this.onSelectionChange);
        document.addEventListener('keydown', this.onKeyDown);
        this.selectionPill.addEventListener('click', () => this.showExtendDialog());
    }

    onPointerMove = (e) => {
        if (!this.isOpen || !this.isPanning) return;
        this.transform.x = e.clientX - this.panStart.x;
        this.transform.y = e.clientY - this.panStart.y;
        this.applyTransform();
    };

    onPointerUp = () => {
        if (!this.isPanning) return;
        this.isPanning = false;
        this.viewport?.classList.remove('panning');
    };

    onWheel = (e) => {
        if (!this.isOpen) return;
        const bubble = e.target.closest?.('.graph-bubble');
        if (bubble?.dataset.cardId === this.selectedNodeId) {
            e.preventDefault();
            e.stopPropagation();
            const body = bubble.querySelector('.graph-bubble__body');
            const scrollTarget = e.target.closest?.('textarea') || body;
            if (scrollTarget) {
                const multiplier = e.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? 16
                    : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
                        ? Math.max(scrollTarget.clientHeight, 1)
                        : 1;
                scrollTarget.scrollTop += e.deltaY * multiplier;
                scrollTarget.scrollLeft += e.deltaX * multiplier;
            }
            return;
        }
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
        const newScale = Math.min(Math.max(this.transform.scale * zoomFactor, 0.4), 2.2);
        const mouseX = e.clientX;
        const mouseY = e.clientY;
        this.transform.x = mouseX - (mouseX - this.transform.x) * (newScale / this.transform.scale);
        this.transform.y = mouseY - (mouseY - this.transform.y) * (newScale / this.transform.scale);
        this.transform.scale = newScale;
        this.applyTransform();
    };

    onPointerDownCapture = (e) => {
        if (!this.isOpen) return;
        const mark = e.target.closest('mark.graph-mark');
        if (mark) {
            const targetChildId = mark.getAttribute('data-target-id');
            const parentCard = mark.closest('.graph-bubble');
            if (parentCard?.dataset.cardId !== this.selectedNodeId) {
                e.preventDefault();
                e.stopPropagation();
                this.setSelectedNode(parentCard?.dataset.cardId || null);
                return;
            }
            if (targetChildId) {
                e.preventDefault();
                e.stopPropagation();
                this.justClickedMarkTimestamp = Date.now();
                this.triggerJumpToChild(targetChildId, parentCard ? parentCard.dataset.cardId : null);
            }
            return;
        }

        if (!this.selectionPill.contains(e.target) && !e.target.closest('.graph-bubble__body')) {
            this.selectionPill.style.display = 'none';
        }
    };

    onSelectionChange = () => {
        if (!this.isOpen) return;
        const sel = window.getSelection();
        if (Date.now() < this.suppressSelectionPillUntil) {
            this.selectionPill.style.display = 'none';
            this.selectedTextContext = null;
            if (sel && !sel.isCollapsed) {
                sel.removeAllRanges();
            }
            return;
        }
        if (!sel || sel.isCollapsed || !sel.rangeCount) return;

        const text = sel.toString().trim();
        if (text.length === 0) return;

        const range = sel.getRangeAt(0);
        const containerBubble = range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer.closest('.graph-bubble')
            : range.commonAncestorContainer.parentElement?.closest('.graph-bubble');

        if (!containerBubble || containerBubble.dataset.cardId !== this.selectedNodeId) {
            this.selectionPill.style.display = 'none';
            if (containerBubble) {
                sel.removeAllRanges();
            }
            return;
        }

        const rect = range.getBoundingClientRect();
        const answerContent = containerBubble.querySelector('.graph-bubble__answer-content');
        this.selectedTextContext = {
            text,
            parentId: containerBubble.dataset.cardId,
            range: range.cloneRange(),
            textAnchor: this.getRangeTextAnchor(answerContent, range)
        };

        this.selectionPill.style.display = 'flex';
        this.selectionPill.style.left = `${rect.left + rect.width / 2}px`;
        this.selectionPill.style.top = `${rect.top - 12}px`;
    };

    onKeyDown = (e) => {
        if (!this.isOpen || e.key !== 'Escape') return;
        if (this.dialogEl && !this.dialogEl.hidden) {
            this.hideDialog();
            return;
        }
        if (this.selectedNodeId) {
            this.setSelectedNode(null);
            return;
        }
        if (document.querySelector('.modal-overlay.active')) return;
        this.close();
    };

    open({ rootCardId }) {
        return this._open(rootCardId);
    }

    _open(rootCardId) {
        this.mount();
        if (!this.overlay) return false;

        const context = getAppContext();
        const board = context?.board;
        const getCardById = (id) => context?.cardSystem?.cards.get(id) || null;

        const result = buildGraphTree({ board, getCardById, rootCardId });
        if (!result) {
            return false;
        }

        this.rawTree = result.tree;
        this.rebuildTreeIndex();
        this.mergePersistedNodes();
        this.nodes = [];
        this.links = [];
        this.transform = { x: 0, y: 0, scale: 1 };
        this.selectedNodeId = null;
        this.selectedNodeAt = 0;
        this.suppressSelectionPillUntil = 0;
        this.clearGraphDom();

        this.titleEl.textContent = this.rawTree.tag;
        this.calculateLayout();
        this.renderGraph();
        this.restoreViewState();
        this.setupSimulation();

        // 根气泡居中。容器可能刚从隐藏切换为可见（尺寸仍为 0 或在过渡中），
        // 用 rAF 循环等尺寸就绪后再定位，尺寸稳定后停止。
        this._centered = false;
        this._lastViewportSize = null;
        requestAnimationFrame(() => this.centerRootLoop());

        this.isOpen = true;
        this.overlay.classList.add('active');
        // 双击标注会先触发单击的节点闪烁定位，开图后它毫无意义，取消之
        cancelBoardCardFlash(context?.board);
        return true;
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.overlay.classList.remove('active');
        this.selectionPill.style.display = 'none';
        this.hideDialog();
        this.simulation?.stop();
        this.simulation = null;
        this.rawTree = null;
        this.childNodesByNodeId = null;
        this.nodeById = null;
        this.parentByNodeId = null;
        this.nodes = [];
        this.links = [];
        this.selectedTextContext = null;
        this.selectedNodeId = null;
        this.selectedNodeAt = 0;
        this.lastSelectionGesture = null;
        this.suppressSelectionPillUntil = 0;
        this.aiController.clearPending();
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;
        this.clearGraphDom();
        window.getSelection()?.removeAllRanges();
    }

    clearGraphDom() {
        if (!this.overlay) return;
        this.nodesContainer.innerHTML = '';
        this.edgesLayer.innerHTML = '';
        this.edgeItems.clear();
    }

    /**
     * Rebuilds lookup indexes (children / parent / node maps) from rawTree.
     * Card-derived nodes are marked kind 'card'; persisted nodes merged in
     * afterwards carry their own kind.
     */
    rebuildTreeIndex() {
        this.childNodesByNodeId = new Map();
        this.nodeById = new Map();
        this.parentByNodeId = new Map();
        const walk = (node, parentId) => {
            node.kind = node.kind || 'card';
            this.nodeById.set(node.id, node);
            this.parentByNodeId.set(node.id, parentId);
            this.childNodesByNodeId.set(node.id, node.children || []);
            (node.children || []).forEach((child) => walk(child, node.id));
        };
        walk(this.rawTree, null);
    }

    /**
     * Merges persisted graph-view nodes (manual/AI) into the freshly derived
     * card tree. Nodes are scoped to the root annotation they were created
     * under — nodes without an explicit root (legacy data) stay hidden
     * instead of being adopted by whichever view opens next, which used to
     * surface "ghost" children. Orphans whose parent chain broke reattach to
     * their own root so their content is never lost.
     */
    mergePersistedNodes() {
        if (!graphNodesStore.hasData()) {
            return;
        }

        const rootId = this.rawTree.id;
        const persisted = graphNodesStore.getAll().filter((n) => n.rootCardId === rootId);
        if (persisted.length === 0) {
            return;
        }
        const persistedIds = new Set(persisted.map((n) => n.id));
        const toTreeNode = (n) => ({
            id: n.id,
            tag: n.title,
            question: n.question,
            titleCustomized: n.titleCustomized,
            text: !n.content || n.content === '（无内容）' ? t('graph.empty') : n.content,
            color: n.kind === 'ai' ? '#a855f7' : '#38bdf8',
            kind: n.kind,
            children: []
        });

        const childrenByParent = new Map();
        persisted.forEach((n) => {
            const list = childrenByParent.get(n.parentId) || [];
            list.push(n);
            childrenByParent.set(n.parentId, list);
        });

        const attach = (storeNode, parentTreeNode) => {
            const treeNode = toTreeNode(storeNode);
            parentTreeNode.children.push(treeNode);
            (childrenByParent.get(storeNode.id) || []).forEach((child) => attach(child, treeNode));
        };

        // 父链断裂的孤儿节点只挂回自己归属的根（过滤已保证 rootCardId 匹配），
        // 归属不明的节点不再被任意视图收养
        persisted
            .filter((n) => !persistedIds.has(n.parentId) && !this.nodeById.has(n.parentId))
            .forEach((orphan) => attach(orphan, this.rawTree));

        // parentId 指向树上真实节点（卡片或已挂载的持久化节点）的剩余分支
        const attachExisting = (treeNode) => {
            (childrenByParent.get(treeNode.id) || []).forEach((storeNode) => {
                if (treeNode.children.some((child) => child.id === storeNode.id)) {
                    return;
                }
                attach(storeNode, treeNode);
            });
            (treeNode.children || []).forEach(attachExisting);
        };
        attachExisting(this.rawTree);

        this.rebuildTreeIndex();
    }

    applyTreeChange() {
        this.rebuildTreeIndex();
        this.calculateLayout();
        this.renderGraph();
        this.simulation.nodes(this.nodes);
        this.simulation.alpha(0.7).restart();
    }

    /**
     * Creates a persisted child node under parentId and refreshes the view.
     * Returns the view node.
     */
    createChildNode({ parentId, title, question = '', content = '', kind = 'manual' }) {
        const id = `gv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const storeNode = graphNodesStore.upsert({
            id,
            parentId,
            rootCardId: this.rawTree?.id || null,
            kind,
            title,
            question,
            content
        });
        const parentTreeNode = this.nodeById.get(parentId);
        if (!parentTreeNode) {
            return null;
        }

        const treeNode = {
            id: storeNode.id,
            tag: storeNode.title,
            question: storeNode.question,
            titleCustomized: storeNode.titleCustomized,
            text: !storeNode.content || storeNode.content === '（无内容）' ? t('graph.empty') : storeNode.content,
            color: storeNode.kind === 'ai' ? '#a855f7' : '#38bdf8',
            kind: storeNode.kind,
            children: []
        };
        parentTreeNode.children.push(treeNode);
        this.applyTreeChange();
        return treeNode;
    }

    /**
     * Removes a view node subtree (persisted nodes only — card nodes are
     * owned by the board).
     */
    deleteSubtree(nodeId) {
        const treeNode = this.nodeById.get(nodeId);
        if (!treeNode || treeNode.kind === 'card') {
            return;
        }
        const parentId = this.parentByNodeId.get(nodeId);
        const parentTreeNode = this.parentByNodeId.get(nodeId) ? this.nodeById.get(parentId) : null;
        if (parentTreeNode) {
            parentTreeNode.children = parentTreeNode.children.filter((child) => child.id !== nodeId);
        }
        const removedIds = graphNodesStore.removeSubtree(nodeId);
        if (this.selectedNodeId && removedIds.includes(this.selectedNodeId)) {
            this.setSelectedNode(null);
        }
        this.applyTreeChange();
    }

    /**
     * Builds the AI conversation messages for a new question under parentId:
     * every ancestor up to the root contributes context (card nodes as
     * excerpt context, AI nodes as prior user/assistant turns).
     */
    buildConversation(parentId, question) {
        const chain = [];
        let cursor = parentId;
        while (cursor) {
            const node = this.nodeById.get(cursor);
            if (!node) {
                break;
            }
            chain.unshift(node);
            cursor = this.parentByNodeId.get(cursor);
        }

        const messages = [];
        chain.forEach((node) => {
            if (node.kind === 'ai') {
                messages.push({ role: 'user', content: node.question || node.tag });
                messages.push({ role: 'assistant', content: node.text });
            } else {
                messages.push({ role: 'user', content: `[${t('graph.excerptContext')} | ${node.tag}]\n${node.text}` });
            }
        });
        messages.push({ role: 'user', content: question });

        // Anthropic/Gemini 需要相邻消息角色交替，合并连续同角色消息
        const merged = [];
        messages.forEach((message) => {
            const last = merged[merged.length - 1];
            if (last && last.role === message.role) {
                last.content = `${last.content}\n\n${message.content}`;
            } else {
                merged.push({ ...message });
            }
        });
        return merged;
    }

    calculateLayout() {
        const hierarchyRoot = hierarchy(this.rawTree);
        const treeLayout = d3tree().nodeSize([150, 410]);
        treeLayout(hierarchyRoot);

        const d3Nodes = hierarchyRoot.descendants();
        const d3Links = hierarchyRoot.links();

        let minY = Infinity;
        d3Nodes.forEach((d) => { if (d.x < minY) minY = d.x; });
        const verticalOffset = (this.viewport.clientHeight / 2) - (minY < 0 ? minY : 0);

        const existingMap = new Map(this.nodes.map((n) => [n.id, n]));

        this.nodes = d3Nodes.map((d) => {
            const targetX = 220 + d.y;
            const targetY = verticalOffset + d.x;
            const existing = existingMap.get(d.data.id);

            if (existing) {
                existing.targetX = targetX;
                existing.targetY = targetY;
                existing.tag = d.data.tag;
                existing.question = d.data.question;
                existing.titleCustomized = d.data.titleCustomized;
                existing.text = d.data.text;
                existing.color = d.data.color;
                existing.kind = d.data.kind;
                return existing;
            }

            const parentNode = d.parent ? existingMap.get(d.parent.data.id) : null;
            return {
                id: d.data.id,
                tag: d.data.tag,
                question: d.data.question,
                titleCustomized: d.data.titleCustomized,
                text: d.data.text,
                color: d.data.color,
                kind: d.data.kind,
                targetX,
                targetY,
                x: parentNode ? parentNode.x + 40 : targetX,
                y: parentNode ? parentNode.y : targetY,
                vx: 0,
                vy: 0
            };
        });

        this.links = d3Links.map((d) => ({
            source: d.source.data.id,
            target: d.target.data.id
        }));
    }

    setupSimulation() {
        this.simulation?.stop();
        this.simulation = forceSimulation(this.nodes)
            .force('x', forceX((d) => d.targetX).strength(0.35))
            .force('y', forceY((d) => d.targetY).strength(0.35))
            .force('collide', forceCollide().radius(155).iterations(4))
            .force('charge', forceManyBody().strength(-80))
            .alphaDecay(0.04);

        this.simulation.on('tick', () => this.onSimulationTick());
    }

    onSimulationTick() {
        this.nodes.forEach((node) => {
            const el = document.getElementById(this.domId(node.id));
            if (el) {
                el.style.left = `${node.x}px`;
                el.style.top = `${node.y}px`;
            }
        });
        this.syncBezierEdges();
    }

    domId(cardId) {
        return `graph-node-${cardId}`;
    }

    syncBezierEdges() {
        const nodeMap = new Map(this.nodes.map((n) => [n.id, n]));

        this.edgeItems.forEach((item, key) => {
            const [sourceId, targetId] = key.split('->');
            const sourceNode = nodeMap.get(sourceId);
            const targetNode = nodeMap.get(targetId);
            if (!sourceNode || !targetNode) return;

            const sx = sourceNode.x + 135;
            const sy = sourceNode.y;
            const tx = targetNode.x - 135;
            const ty = targetNode.y;

            const curvature = Math.max((tx - sx) * 0.5, 45);
            const pathData = `M ${sx} ${sy} C ${sx + curvature} ${sy}, ${tx - curvature} ${ty}, ${tx} ${ty}`;

            item.main.setAttribute('d', pathData);
            item.pulse.setAttribute('d', pathData);
        });
    }

    renderGraph() {
        this.links.forEach((link) => {
            const key = `${link.source}->${link.target}`;
            if (this.edgeItems.has(key)) return;

            const g = document.createElementNS(NS, 'g');
            const main = document.createElementNS(NS, 'path');
            main.setAttribute('class', 'graph-link');
            const pulse = document.createElementNS(NS, 'path');
            pulse.setAttribute('class', 'graph-link-pulse');
            g.appendChild(main);
            g.appendChild(pulse);
            this.edgesLayer.appendChild(g);
            this.edgeItems.set(key, { main, pulse });
        });

        this.nodes.forEach((node) => {
            let el = document.getElementById(this.domId(node.id));
            if (!el) {
                el = this.createBubble(node);
                this.nodesContainer.appendChild(el);
            } else {
                el.querySelector('.graph-bubble__tag-title').textContent = node.tag;
                el.setAttribute('aria-label', node.tag);
                const tooltip = el.querySelector('.graph-bubble__title-tooltip');
                if (tooltip) tooltip.textContent = node.tag;
                const questionInput = el.querySelector('.graph-bubble__question-input');
                if (questionInput && document.activeElement !== questionInput) {
                    questionInput.value = node.question || node.tag;
                }
                this.syncBubbleSelection(el, node.id === this.selectedNodeId);
            }
        });

        this.syncBezierEdges();
    }

    createBubble(node) {
        const el = document.createElement('div');
        el.id = this.domId(node.id);
        el.className = 'graph-bubble';
        el.dataset.cardId = node.id;
        el.dataset.kind = node.kind || 'card';
        el.setAttribute('role', 'listitem');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-expanded', 'false');
        el.setAttribute('aria-label', node.tag);

        const header = document.createElement('div');
        header.className = 'graph-bubble__header';

        const tag = document.createElement('div');
        tag.className = 'graph-bubble__tag';
        if (node.color) {
            const dot = document.createElement('span');
            dot.className = 'graph-bubble__color-dot';
            dot.style.backgroundColor = node.color;
            tag.appendChild(dot);
        }
        const tagTitle = document.createElement('span');
        tagTitle.className = 'graph-bubble__tag-title';
        escapelessText(tagTitle, node.tag);
        tag.appendChild(tagTitle);

        const headerActions = document.createElement('div');
        headerActions.className = 'graph-bubble__actions';
        // Selecting a bubble reveals these actions. During a double click the
        // second press can therefore land on a button that did not exist under
        // the first press (most visibly the “add child” button). Treat that
        // same-position second click as the intended bubble double click,
        // rather than executing the newly revealed action.
        headerActions.addEventListener('click', (e) => {
            const gesture = this.lastSelectionGesture;
            const elapsed = gesture ? Date.now() - gesture.at : Infinity;
            const distance = gesture
                ? Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y)
                : Infinity;
            if (
                gesture?.nodeId === node.id
                && gesture.wasSelected === false
                && elapsed <= 360
                && distance <= 10
            ) {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.lastSelectionGesture = null;
                this.setBubbleExpanded(node.id, !el.classList.contains('graph-bubble--expanded'));
                this.setSelectedNode(node.id);
                this.suppressDoubleClickTextSelection();
            }
        }, true);

        const addChildBtn = document.createElement('button');
        addChildBtn.type = 'button';
        addChildBtn.className = 'graph-bubble__action-btn';
        addChildBtn.textContent = '＋';
        addChildBtn.title = t('graph.createChild');
        addChildBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const childNode = this.createChildNode({
                parentId: node.id,
                title: t('graph.newThought'),
                content: t('graph.pending'),
                kind: 'manual'
            });
            if (childNode) {
                setTimeout(() => {
                    this.triggerJumpToChild(childNode.id, node.id);
                    this.setBubbleExpanded(childNode.id, true);
                    document.querySelector(
                        `#${CSS.escape(this.domId(childNode.id))} .graph-bubble__title-input`
                    )?.focus();
                }, 100);
            }
        });
        headerActions.appendChild(addChildBtn);

        // 手动/AI 节点支持用标题作为问题调用 AI 填充内容
        if (node.kind && node.kind !== 'card') {
            const aiFillBtn = document.createElement('button');
            aiFillBtn.type = 'button';
            aiFillBtn.className = 'graph-bubble__action-btn graph-bubble__action-btn--ai';
            aiFillBtn.textContent = '✨';
            aiFillBtn.title = t('graph.editQuestion');
            aiFillBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setBubbleExpanded(node.id, true);
                el.querySelector('.graph-bubble__question-input')?.focus();
            });
            headerActions.appendChild(aiFillBtn);
        }

        if (node.id !== this.rawTree?.id && node.kind !== 'card') {
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'graph-bubble__action-btn graph-bubble__action-btn--danger';
            deleteBtn.textContent = '🗑';
            deleteBtn.title = t('graph.deleteBranch');
            deleteBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const confirmed = await modalManager.confirm({
                    title: t('graph.deleteBranch'),
                    message: t('graph.deleteBranchMessage'),
                    confirmLabel: t('common.delete'),
                    cancelLabel: t('common.cancel'),
                    danger: true
                });
                if (confirmed) {
                    this.deleteSubtree(node.id);
                }
            });
            headerActions.appendChild(deleteBtn);
        }

        const dragIcon = document.createElement('span');
        dragIcon.className = 'graph-bubble__drag-icon';
        dragIcon.textContent = '⠿';

        header.appendChild(tag);
        header.appendChild(headerActions);
        header.appendChild(dragIcon);

        const body = document.createElement('div');
        body.className = 'graph-bubble__body';

        if (node.kind && node.kind !== 'card') {
            const editor = document.createElement('div');
            editor.className = 'graph-bubble__editor';

            const titleLabel = document.createElement('label');
            titleLabel.className = 'graph-bubble__field-label';
            titleLabel.textContent = t('graph.nodeTitle');
            const titleInput = document.createElement('input');
            titleInput.type = 'text';
            titleInput.className = 'graph-bubble__title-input';
            titleInput.value = node.tag;
            titleInput.addEventListener('change', () => this.commitNodeTitle(node.id, titleInput.value));
            titleLabel.appendChild(titleInput);

            const questionLabel = document.createElement('label');
            questionLabel.className = 'graph-bubble__field-label';
            questionLabel.textContent = t('graph.userQuestion');
            const questionInput = document.createElement('textarea');
            questionInput.className = 'graph-bubble__question-input';
            questionInput.rows = 3;
            questionInput.value = node.question || node.tag;
            questionLabel.appendChild(questionInput);

            const editorActions = document.createElement('div');
            editorActions.className = 'graph-bubble__editor-actions';
            const resetTitleBtn = document.createElement('button');
            resetTitleBtn.type = 'button';
            resetTitleBtn.className = 'graph-bubble__editor-btn';
            resetTitleBtn.textContent = t('graph.useQuestionAsTitle');
            resetTitleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetNodeTitle(node.id);
            });
            const regenerateBtn = document.createElement('button');
            regenerateBtn.type = 'button';
            regenerateBtn.className = 'graph-bubble__editor-btn graph-bubble__editor-btn--primary';
            regenerateBtn.textContent = t('graph.regenerate');
            regenerateBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.regenerateNode(node.id);
            });
            editorActions.append(resetTitleBtn, regenerateBtn);
            editor.append(titleLabel, questionLabel, editorActions);
            body.appendChild(editor);
        }

        const answerSection = document.createElement('div');
        answerSection.className = 'graph-bubble__answer';
        if (node.kind && node.kind !== 'card') {
            const answerLabel = document.createElement('div');
            answerLabel.className = 'graph-bubble__section-label';
            answerLabel.textContent = t('graph.aiResponse');
            answerSection.appendChild(answerLabel);
        }
        const answerContent = document.createElement('div');
        answerContent.className = 'graph-bubble__answer-content graph-bubble__body--md';
        answerContent.innerHTML = renderSafeMarkdown(node.text);
        this.applyPersistedLinkMarks(answerContent, node.id);
        answerSection.appendChild(answerContent);
        body.appendChild(answerSection);

        // Markdown 链接在新标签页打开，避免污染画布会话
        body.addEventListener('click', (e) => {
            const anchor = e.target.closest('a');
            if (anchor?.href && isSafeExternalUrl(anchor.href)) {
                e.preventDefault();
                if (this.selectedNodeId === node.id) {
                    window.open(anchor.href, '_blank', 'noopener');
                } else {
                    this.setSelectedNode(node.id);
                }
            }
        });

        const titleTooltip = document.createElement('div');
        titleTooltip.className = 'graph-bubble__title-tooltip';
        titleTooltip.hidden = true;
        titleTooltip.textContent = node.tag;

        el.appendChild(header);
        el.appendChild(body);
        el.appendChild(titleTooltip);

        this.bindNodeInteractions(el, node.id);
        this.bindBubbleTitlePreview(el, tagTitle, titleTooltip);

        // 仅允许从“未选中”状态开始的稳定双击放大；已经选中的节点
        // 不再把两次普通操作误判为展开。正文内双击仍保留原生选词。
        // 放大的气泡更宽，需同步放大其碰撞半径并重启模拟，避免与其他气泡重叠。
        el.addEventListener('dblclick', (e) => {
            if (e.target.closest('button, input, textarea, a, mark')) return;
            const gesture = this.lastSelectionGesture;
            const elapsed = gesture ? Date.now() - gesture.at : Infinity;
            const distance = gesture
                ? Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y)
                : Infinity;
            const deliberateDoubleClick = gesture?.nodeId === node.id
                && gesture.wasSelected === false
                && elapsed <= 360
                && distance <= 10;
            if (!deliberateDoubleClick) {
                return;
            }
            e.preventDefault();
            window.getSelection()?.removeAllRanges();
            this.lastSelectionGesture = null;
            this.setBubbleExpanded(node.id, !el.classList.contains('graph-bubble--expanded'));
            this.setSelectedNode(node.id);
            this.suppressDoubleClickTextSelection();
        });

        el.addEventListener('keydown', (e) => {
            if (e.target !== el) return;
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                this.setSelectedNode(node.id);
                if (e.key === 'Enter') {
                    this.setBubbleExpanded(node.id, true);
                }
            }
        });

        this.syncBubbleSelection(el, node.id === this.selectedNodeId);

        return el;
    }

    syncNodeMetadata(nodeId, storedNode) {
        if (!storedNode) return;
        const treeNode = this.nodeById?.get(nodeId);
        const viewNode = this.nodes.find((item) => item.id === nodeId);
        [treeNode, viewNode].filter(Boolean).forEach((item) => {
            item.tag = storedNode.title;
            item.question = storedNode.question;
            item.titleCustomized = storedNode.titleCustomized;
            item.kind = storedNode.kind;
            item.color = storedNode.kind === 'ai' ? '#a855f7' : '#38bdf8';
        });

        const bubble = document.getElementById(this.domId(nodeId));
        if (!bubble) return;
        bubble.dataset.kind = storedNode.kind;
        bubble.setAttribute('aria-label', storedNode.title);
        const title = bubble.querySelector('.graph-bubble__tag-title');
        const titleInput = bubble.querySelector('.graph-bubble__title-input');
        const questionInput = bubble.querySelector('.graph-bubble__question-input');
        const tooltip = bubble.querySelector('.graph-bubble__title-tooltip');
        const dot = bubble.querySelector('.graph-bubble__color-dot');
        if (title) title.textContent = storedNode.title;
        if (titleInput && document.activeElement !== titleInput) titleInput.value = storedNode.title;
        if (questionInput && document.activeElement !== questionInput) questionInput.value = storedNode.question || storedNode.title;
        if (tooltip) tooltip.textContent = storedNode.title;
        if (dot) dot.style.backgroundColor = storedNode.kind === 'ai' ? '#a855f7' : '#38bdf8';
    }

    commitNodeTitle(nodeId, value) {
        const storedNode = graphNodesStore.setTitle(nodeId, value, { customized: true });
        this.syncNodeMetadata(nodeId, storedNode);
        return storedNode;
    }

    resetNodeTitle(nodeId) {
        const bubble = document.getElementById(this.domId(nodeId));
        const question = bubble?.querySelector('.graph-bubble__question-input')?.value.trim();
        if (question) {
            graphNodesStore.setQuestion(nodeId, question);
        }
        const storedNode = graphNodesStore.resetTitleToQuestion(nodeId);
        this.syncNodeMetadata(nodeId, storedNode);
    }

    async regenerateNode(nodeId) {
        if (this.aiController.pendingNodeIds.has(nodeId)) return;
        const treeNode = this.nodeById?.get(nodeId);
        const bubble = document.getElementById(this.domId(nodeId));
        const questionInput = bubble?.querySelector('.graph-bubble__question-input');
        const titleInput = bubble?.querySelector('.graph-bubble__title-input');
        const question = questionInput?.value.trim() || '';
        if (!treeNode || !question) {
            emitAppNotification({ message: t('graph.questionRequired'), level: 'info' });
            questionInput?.focus();
            return;
        }

        if (titleInput?.value.trim() && titleInput.value.trim() !== treeNode.tag) {
            this.commitNodeTitle(nodeId, titleInput.value);
        }
        const storedNode = graphNodesStore.setQuestion(nodeId, question);
        this.syncNodeMetadata(nodeId, storedNode);
        const parentId = this.parentByNodeId?.get(nodeId) || null;
        const succeeded = await this.aiController.requestAnswer(treeNode, question, parentId, { preserveExisting: true });
        if (succeeded) {
            graphNodesStore.setKind(nodeId, 'ai');
            this.syncNodeMetadata(nodeId, graphNodesStore.get(nodeId));
        }
    }

    setSelectedNode(nodeId) {
        if (nodeId === this.selectedNodeId) return;
        const previousId = this.selectedNodeId;
        this.selectedNodeId = nodeId;
        this.selectedNodeAt = nodeId ? Date.now() : 0;
        graphNodesStore.setSelectedNode(this.rawTree?.id, nodeId);
        clearTimeout(this.hoverTimer);
        this.hoverTimer = null;

        if (previousId) {
            const previous = document.getElementById(this.domId(previousId));
            this.syncBubbleSelection(previous, false);
        }
        if (nodeId) {
            const next = document.getElementById(this.domId(nodeId));
            this.syncBubbleSelection(next, true);
        }
        this.selectionPill.style.display = 'none';
        this.selectedTextContext = null;
        window.getSelection()?.removeAllRanges();
    }

    suppressDoubleClickTextSelection() {
        this.suppressSelectionPillUntil = Date.now() + 300;
        this.selectionPill.style.display = 'none';
        this.selectedTextContext = null;
        const clearSelection = () => {
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed) {
                selection.removeAllRanges();
            }
            if (this.selectionPill) {
                this.selectionPill.style.display = 'none';
            }
        };
        clearSelection();
        setTimeout(clearSelection, 0);
    }

    syncBubbleSelection(bubble, selected) {
        if (!bubble) return;
        bubble.classList.toggle('graph-bubble--selected', selected);
        bubble.dataset.selected = selected ? 'true' : 'false';
        bubble.querySelectorAll('input, textarea').forEach((control) => {
            control.disabled = !selected;
        });
        const tooltip = bubble.querySelector('.graph-bubble__title-tooltip');
        if (tooltip && selected) tooltip.hidden = true;
    }

    setBubbleExpanded(nodeId, expanded) {
        const bubble = document.getElementById(this.domId(nodeId));
        const viewNode = this.nodes.find((item) => item.id === nodeId);
        if (!bubble || !viewNode) return;
        bubble.classList.toggle('graph-bubble--expanded', expanded);
        bubble.setAttribute('aria-expanded', String(expanded));
        viewNode.expanded = expanded;
        graphNodesStore.setExpandedNode(this.rawTree?.id, nodeId, expanded);
        const rect = bubble.getBoundingClientRect();
        viewNode.collideRadius = expanded
            ? Math.hypot(rect.width, rect.height) / 2 + 12
            : 155;
        this.simulation?.force(
            'collide',
            forceCollide().radius((item) => item.collideRadius || 155).iterations(4)
        );
        this.simulation?.alpha(0.6).restart();
    }

    restoreViewState() {
        const rootCardId = this.rawTree?.id;
        if (!rootCardId) return;
        const state = graphNodesStore.getViewState(rootCardId);
        const availableIds = new Set(this.nodes.map((node) => node.id));
        state.expandedNodeIds
            .filter((nodeId) => availableIds.has(nodeId))
            .forEach((nodeId) => this.setBubbleExpanded(nodeId, true));
        if (state.selectedNodeId && availableIds.has(state.selectedNodeId)) {
            this.setSelectedNode(state.selectedNodeId);
        } else if (state.selectedNodeId) {
            graphNodesStore.setSelectedNode(rootCardId, null);
        }
    }

    bindBubbleTitlePreview(bubble, titleElement, tooltip) {
        const hide = () => {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = null;
            tooltip.hidden = true;
        };
        const showIfNeeded = () => {
            if (this.selectedNodeId === bubble.dataset.cardId || bubble.classList.contains('graph-bubble--expanded')) return;
            if (titleElement.scrollWidth <= titleElement.clientWidth) return;
            tooltip.hidden = false;
        };
        bubble.addEventListener('pointerenter', () => {
            hide();
            this.hoverTimer = setTimeout(showIfNeeded, 650);
        });
        bubble.addEventListener('pointerleave', hide);
        bubble.addEventListener('focus', showIfNeeded);
        bubble.addEventListener('blur', hide);
    }

    bindNodeInteractions(bubble, nodeId) {
        bubble.addEventListener('pointerdown', (e) => {
            const interactive = e.target.closest('button, input, textarea, a, mark');
            const selected = this.selectedNodeId === nodeId;
            const inHeader = Boolean(e.target.closest('.graph-bubble__header'));
            if (interactive || (selected && !inHeader)) return;

            e.stopPropagation();
            const activeNode = this.nodes.find((item) => item.id === nodeId);
            if (!activeNode) return;

            let isDragging = false;
            const startScreenX = e.clientX;
            const startScreenY = e.clientY;
            const initialNodeX = activeNode.x;
            const initialNodeY = activeNode.y;

            const onPointerMove = (moveEvent) => {
                const distance = Math.hypot(moveEvent.clientX - startScreenX, moveEvent.clientY - startScreenY);
                if (distance <= 5) return;
                if (!isDragging) {
                    isDragging = true;
                    bubble.classList.add('graph-bubble--dragging');
                    bubble.querySelector('.graph-bubble__title-tooltip')?.setAttribute('hidden', '');
                    this.simulation?.alpha(0.85).alphaTarget(0.35).restart();
                }
                moveEvent.preventDefault();
                const scale = this.transform.scale;
                activeNode.fx = initialNodeX + (moveEvent.clientX - startScreenX) / scale;
                activeNode.fy = initialNodeY + (moveEvent.clientY - startScreenY) / scale;
            };

            const onPointerUp = (upEvent) => {
                if (isDragging) {
                    const droppedX = activeNode.fx ?? activeNode.x;
                    const droppedY = activeNode.fy ?? activeNode.y;
                    activeNode.x = droppedX;
                    activeNode.y = droppedY;
                    activeNode.targetX = droppedX;
                    activeNode.targetY = droppedY;
                    this.simulation?.alphaTarget(0);
                    activeNode.fx = null;
                    activeNode.fy = null;
                    bubble.classList.remove('graph-bubble--dragging');
                } else if (Date.now() - this.justClickedMarkTimestamp >= 350) {
                    if (!selected) {
                        this.lastSelectionGesture = {
                            nodeId,
                            at: Date.now(),
                            x: upEvent?.clientX ?? startScreenX,
                            y: upEvent?.clientY ?? startScreenY,
                            wasSelected: false
                        };
                    }
                    this.setSelectedNode(nodeId);
                }
                window.removeEventListener('pointermove', onPointerMove);
                window.removeEventListener('pointerup', onPointerUp);
            };

            window.addEventListener('pointermove', onPointerMove);
            window.addEventListener('pointerup', onPointerUp);
        });
    }

    triggerJumpToChild(childId, fromParentId) {
        if (fromParentId) {
            const item = this.edgeItems.get(`${fromParentId}->${childId}`);
            if (item) {
                item.main.classList.add('graph-link--active');
                setTimeout(() => item.main.classList.remove('graph-link--active'), 1500);
            }
        }
        this.setSelectedNode(childId);
        this.focusOnNode(childId, 'child');
    }

    /**
     * Wraps the selected range in one or more marks. Unlike
     * range.surroundContents, this also works when the selection spans
     * multiple DOM elements (e.g. markdown-generated <p>/<code> nodes):
     * every participating text node's covered segment gets its own mark
     * clone sharing the same data-target-id.
     */
    wrapRangeWithMark(range, mark) {
        if (!range || range.collapsed) {
            return false;
        }

        const root = range.commonAncestorContainer.nodeType === 1
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentNode;

        const textNodes = [];
        if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
            textNodes.push(range.startContainer);
        } else {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => (range.intersectsNode(node) && node.textContent.length
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT)
            });
            let current;
            while ((current = walker.nextNode())) {
                textNodes.push(current);
            }
        }

        let wrappedAny = false;
        textNodes.forEach((textNode) => {
            const start = textNode === range.startContainer ? range.startOffset : 0;
            const end = textNode === range.endContainer ? range.endOffset : textNode.textContent.length;
            if (end <= start) {
                return;
            }

            const middle = start > 0 ? textNode.splitText(start) : textNode;
            if (end - start < middle.textContent.length) {
                middle.splitText(end - start);
            }

            const wrapped = mark.cloneNode();
            middle.parentNode.insertBefore(wrapped, middle);
            wrapped.appendChild(middle);
            wrappedAny = true;
        });

        return wrappedAny;
    }

    getRangeTextAnchor(container, range) {
        if (
            !container
            || !range
            || range.collapsed
            || !container.contains(range.startContainer)
            || !container.contains(range.endContainer)
        ) {
            return null;
        }
        // Native browser selections may use either text nodes or their
        // surrounding elements as range boundaries. Measuring a prefix range
        // handles both shapes and keeps the stored anchor DOM-independent.
        const prefix = document.createRange();
        prefix.selectNodeContents(container);
        prefix.setEnd(range.startContainer, range.startOffset);
        const startOffset = prefix.toString().length;
        const text = range.toString();
        const endOffset = startOffset + text.length;
        if (!text || endOffset <= startOffset) {
            return null;
        }
        return {
            startOffset,
            endOffset,
            text
        };
    }

    createRangeFromTextOffsets(container, startOffset, endOffset) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let offset = 0;
        let started = false;
        let current;
        while ((current = walker.nextNode())) {
            const nextOffset = offset + current.textContent.length;
            if (!started && startOffset >= offset && startOffset <= nextOffset) {
                range.setStart(current, Math.min(startOffset - offset, current.textContent.length));
                started = true;
            }
            if (started && endOffset >= offset && endOffset <= nextOffset) {
                range.setEnd(current, Math.min(endOffset - offset, current.textContent.length));
                return range.collapsed ? null : range;
            }
            offset = nextOffset;
        }
        return null;
    }

    applyPersistedLinkMarks(container, parentId) {
        const rootCardId = this.rawTree?.id;
        if (!rootCardId || !container) return;
        const fullText = container.textContent || '';
        const marks = graphNodesStore.getLinkMarks(rootCardId, parentId)
            .filter((mark) => this.nodeById?.has(mark.targetId))
            .map((mark) => {
                if (mark.text && fullText.slice(mark.startOffset, mark.endOffset) !== mark.text) {
                    const fallbackOffset = fullText.indexOf(mark.text);
                    if (fallbackOffset < 0) return null;
                    return {
                        ...mark,
                        startOffset: fallbackOffset,
                        endOffset: fallbackOffset + mark.text.length
                    };
                }
                return mark;
            })
            .filter(Boolean)
            .sort((left, right) => right.startOffset - left.startOffset);

        marks.forEach((storedMark) => {
            const range = this.createRangeFromTextOffsets(
                container,
                storedMark.startOffset,
                storedMark.endOffset
            );
            if (!range) return;
            const mark = document.createElement('mark');
            mark.className = 'graph-mark';
            mark.setAttribute('data-target-id', storedMark.targetId);
            mark.title = t('graph.traceBranch');
            this.wrapRangeWithMark(range, mark);
        });
    }

    showExtendDialog() {
        const ctx = this.selectedTextContext;
        if (!ctx || !this.rawTree) return;
        this.openDialog(ctx, t('graph.extend'), ctx.text || '');
    }

    openDialog(context, titleText, prefill = '') {
        this.dialogContext = context;
        this.dialogTitleEl.textContent = titleText;
        this.dialogInput.value = prefill;
        this.dialogEl.hidden = false;
        this.dialogInput.focus();
        this.dialogInput.select();
    }

    hideDialog() {
        if (!this.dialogEl) return;
        this.dialogEl.hidden = true;
        this.dialogContext = null;
        this.dialogInput.value = '';
    }

    submitExtendDialog(mode) {
        const ctx = this.dialogContext;
        const question = (this.dialogInput?.value || '').trim();
        if (!ctx || !question) {
            return;
        }
        const { parentId, range } = ctx;
        const parentAnswer = document.querySelector(
            `#${CSS.escape(this.domId(parentId))} .graph-bubble__answer-content`
        );
        let textAnchor = ctx.textAnchor || (range ? this.getRangeTextAnchor(parentAnswer, range) : null);
        if (!textAnchor && parentAnswer && ctx.text) {
            const startOffset = (parentAnswer.textContent || '').indexOf(ctx.text);
            if (startOffset >= 0) {
                textAnchor = {
                    startOffset,
                    endOffset: startOffset + ctx.text.length,
                    text: ctx.text
                };
            }
        }
        this.hideDialog();

        // 选中文本包裹为可跳转的 mark，指向新生成的子节点
        const node = this.createChildNode({
            parentId,
            title: question,
            question: mode === 'ai' ? question : '',
            content: mode === 'ai' ? t('graph.aiThinking') : t('graph.pending'),
            kind: mode === 'ai' ? 'ai' : 'manual'
        });
        if (!node) {
            return;
        }

        let storedMark = null;
        if (textAnchor) {
            storedMark = graphNodesStore.addLinkMark({
                rootCardId: this.rawTree.id,
                parentId,
                targetId: node.id,
                ...textAnchor
            });
        }
        if (range && storedMark) {
            const mark = document.createElement('mark');
            mark.className = 'graph-mark';
            mark.setAttribute('data-target-id', node.id);
            mark.title = t('graph.traceBranch');
            this.wrapRangeWithMark(range, mark);
        }

        this.selectionPill.style.display = 'none';
        window.getSelection().removeAllRanges();
        this.selectedTextContext = null;

        setTimeout(() => {
            this.triggerJumpToChild(node.id, parentId);
        }, 100);

        if (mode === 'ai') {
            void this.aiController.requestAnswer(node, question, parentId);
        }
    }

    updateNodeContent(nodeId, text) {
        const treeNode = this.nodeById?.get(nodeId);
        if (!treeNode) return;
        treeNode.text = text;
        graphNodesStore.setContent(nodeId, text);
        this.renderNodeBody(nodeId, text);
    }

    renderNodeBody(nodeId, text) {
        const answerContent = document.querySelector(`#${CSS.escape(this.domId(nodeId))} .graph-bubble__answer-content`);
        if (answerContent) {
            answerContent.innerHTML = renderSafeMarkdown(text);
            this.applyPersistedLinkMarks(answerContent, nodeId);
            // 流式输出时正文持续增长，钉在底部跟随阅读
            const body = answerContent.closest('.graph-bubble__body');
            if (body) body.scrollTop = body.scrollHeight;
        }
    }

    focusOnNode(nodeId, type = 'child') {
        const targetNode = this.nodes.find((n) => n.id === nodeId);
        if (!targetNode) return;

        const cardEl = document.getElementById(this.domId(nodeId));
        if (cardEl) {
            cardEl.classList.remove('graph-bubble--targeted-child', 'graph-bubble--targeted-self');
            void cardEl.offsetWidth;
            cardEl.classList.add(type === 'child'
                ? 'graph-bubble--targeted-child'
                : 'graph-bubble--targeted-self');
        }

        const currentScale = Math.max(this.transform.scale, 0.95);
        this.transform.x = this.viewport.clientWidth / 2 - targetNode.x * currentScale;
        this.transform.y = this.viewport.clientHeight / 2 - targetNode.y * currentScale;
        this.transform.scale = currentScale;

        this.world.style.transition = 'transform 0.65s cubic-bezier(0.16, 1, 0.3, 1)';
        this.applyTransform();
        setTimeout(() => {
            this.world.style.transition = 'none';
        }, 700);
    }

    centerRootLoop(retries = 90) {
        if (!this.isOpen || !this.nodes.length) {
            return;
        }

        const size = { w: this.viewport.clientWidth, h: this.viewport.clientHeight };
        if (size.w > 0 && size.h > 0) {
            const sizeChanged = !this._lastViewportSize
                || this._lastViewportSize.w !== size.w
                || this._lastViewportSize.h !== size.h;
            if (sizeChanged || !this._centered) {
                this._lastViewportSize = size;
                this._centered = true;
                const root = this.nodes[0];
                this.transform.scale = 1;
                this.transform.x = size.w / 2 - root.targetX;
                this.transform.y = size.h / 2 - root.targetY;
                this.applyTransform();
            }
        }

        if (retries > 0) {
            requestAnimationFrame(() => this.centerRootLoop(retries - 1));
        }
    }

    applyTransform() {
        this.world.style.transform =
            `translate(${this.transform.x}px, ${this.transform.y}px) scale(${this.transform.scale})`;
    }
}

export const graphViewController = new GraphViewController();

export function openGraphView({ rootCardId }) {
    return graphViewController._open(rootCardId);
}

export function closeGraphView() {
    graphViewController.close();
}

export function isGraphViewOpen() {
    return graphViewController.isOpen;
}
