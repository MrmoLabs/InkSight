import { aiConfigManager } from '../../core/ai-config-manager.js';
import { chatStream } from '../../core/ai-client.js';
import { emitAppNotification } from '../../ui/app-notifications.js';
import { t } from '../../i18n/index.js';

export class GraphAiController {
    constructor({
        getNodeById,
        getBubbleElement,
        buildConversation,
        updateNodeContent,
        renderNodeBody,
        chatStream: stream = chatStream
    }) {
        this.getNodeById = getNodeById;
        this.getBubbleElement = getBubbleElement;
        this.buildConversation = buildConversation;
        this.updateNodeContent = updateNodeContent;
        this.renderNodeBody = renderNodeBody;
        this.chatStream = stream;
        this.pendingNodeIds = new Set();
    }

    clearPending() {
        this.pendingNodeIds.clear();
    }

    async requestAnswer(treeNode, question, parentId, { preserveExisting = false } = {}) {
        if (this.pendingNodeIds.has(treeNode.id)) {
            return false;
        }
        const config = aiConfigManager.get();
        if (!aiConfigManager.isConfigured()) {
            if (!preserveExisting) {
                this.updateNodeContent(treeNode.id, t('graph.aiNotConfigured'));
            }
            emitAppNotification({ message: t('graph.aiNotConfiguredNotice'), level: 'warning' });
            return false;
        }

        const bubbleEl = this.getBubbleElement(treeNode.id);
        const regenerateBtn = bubbleEl?.querySelector('.graph-bubble__editor-btn--primary');
        const previousContent = treeNode.text;
        this.pendingNodeIds.add(treeNode.id);
        bubbleEl?.classList.add('graph-bubble--loading');
        if (regenerateBtn) regenerateBtn.disabled = true;
        if (!preserveExisting) {
            this.updateNodeContent(treeNode.id, t('graph.aiThinking'));
        }

        let flushTimer = null;
        try {
            let answer = '';
            const flush = () => {
                flushTimer = null;
                const viewNode = this.getNodeById(treeNode.id);
                if (viewNode) {
                    viewNode.text = answer;
                }
                this.renderNodeBody(treeNode.id, answer);
            };
            await this.chatStream(config, {
                system: t('graph.aiSystem'),
                messages: this.buildConversation(parentId, question),
                onDelta: (_delta, full) => {
                    answer = full;
                    if (!flushTimer) {
                        flushTimer = setTimeout(flush, 120);
                    }
                }
            });
            clearTimeout(flushTimer);
            this.updateNodeContent(treeNode.id, answer);
            return true;
        } catch (error) {
            clearTimeout(flushTimer);
            if (preserveExisting) {
                treeNode.text = previousContent;
                this.renderNodeBody(treeNode.id, previousContent);
            } else {
                this.updateNodeContent(treeNode.id, `(${t('graph.aiRequestFailed', { message: error.message })})`);
            }
            emitAppNotification({ message: t('graph.aiRequestFailed', { message: error.message }), level: 'error' });
            return false;
        } finally {
            this.pendingNodeIds.delete(treeNode.id);
            bubbleEl?.classList.remove('graph-bubble--loading');
            if (regenerateBtn) regenerateBtn.disabled = false;
        }
    }
}
