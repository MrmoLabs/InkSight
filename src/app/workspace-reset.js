import { getAppContext } from './app-context.js';
import { graphNodesStore } from '../mindmap/graph-view/graph-nodes-store.js';
import { DOCUMENT_HISTORY_STORAGE_KEY } from '../core/document-history-store.js';

const RUNTIME_KEYS_TO_CLEAR = [
    'inksight_runtime_project_id',
    'inksight_runtime_session_id',
    'inksight_project_autosave_snapshot',
    'inksight_project_autosave_prefs',
    DOCUMENT_HISTORY_STORAGE_KEY
];

/**
 * Wipes the current workspace back to a clean state: board elements, cards,
 * highlights, documents, graph-view nodes, per-book document history and the
 * runtime project identity. The caller should reload the page afterwards so
 * the next boot starts from an empty workspace instead of restoring the old
 * runtime snapshot.
 */
export async function resetWorkspace() {
    const context = getAppContext();

    // 1. 清空画布元素（从尾部逐个移除，触发 board 的常规删除流程）
    const board = context?.board;
    if (board) {
        const { Transforms } = await import('@plait/core');
        while (board.children.length > 0) {
            Transforms.removeNode(board, [board.children.length - 1]);
        }
    }

    // 2. 清空各数据管理器
    context?.cardSystem?.clearAll();
    context?.highlightManager?.clearAll();
    context?.documentManager?.clearAll();
    graphNodesStore.clear();

    // 3. 清空文档历史与运行时项目标识——下次启动生成全新项目，
    //    不会再恢复旧的工作区快照
    try {
        RUNTIME_KEYS_TO_CLEAR.forEach((key) => localStorage.removeItem(key));
    } catch {
        // localStorage 不可用时跳过（私隐模式等），内存态已清理
    }
}
