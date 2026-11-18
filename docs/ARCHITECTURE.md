# InkSight 技术架构 (Architecture)

## 技术栈 (Tech Stack)

### Core
- **Framework**: Vanilla JS (ES Modules) + React (部分组件)
- **Build Tool**: Vite
- **Language**: JavaScript (ES6+) / CSS3

### Libraries
- **PDF Rendering**: `pdfjs-dist`
- **EPUB Rendering**: `epubjs`
- **Markdown Parsing**: `marked`
- **Mind Map / Whiteboard**: `plait` (Drawnix core), `roughjs` (手绘风格)
- **State Management**: Custom Event Bus + Reactive State (Immer)
- **Storage**: 原生 IndexedDB、LocalStorage；Electron 使用本机目录。详见 [浏览器工作区存储](BROWSER_STORAGE.md)。

## 项目结构 (Project Structure)

```
src/
├── core/               # 核心逻辑
│   ├── card-system.js      # 卡片/节点管理系统
│   ├── highlight-manager.js # 高亮/标注管理器
│   ├── document-manager.js  # 文档状态管理
│   └── theme-manager.js     # 主题管理器
├── readers/            # 阅读器实现
│   ├── pdf-reader.js       # PDF 阅读器封装
│   ├── epub-reader.js      # EPUB 阅读器封装
│   ├── text-reader.js      # 文本/MD 阅读器封装
│   └── pdf-*.js            # PDF 相关工具 (高亮、工具栏等)
├── mindmap/            # 思维导图模块
│   ├── drawnix-view.js     # 导图视图控制器 (Drawnix)
│   ├── DrawnixBoard.jsx    # Drawnix 画板集成
│   └── PlaitBoard.jsx      # Plait 画板组件
├── ui/                 # 通用 UI 组件
│   └── split-view.js       # 分屏控制器
└── styles/             # 样式文件
```

## 模块装配说明

当前 `main.js` 已做过一轮较大规模的职责下沉。关于前端模块的最新职责边界、依赖方向和装配约定，请优先参考：

- [MODULE_DEPENDENCY_MAP.md](/D:/Projects/InkSight/docs/MODULE_DEPENDENCY_MAP.md)

## 关键模块说明 (Key Modules)

### 1. Reader System (阅读器系统)
采用策略模式，`main.js` 根据文件类型实例化不同的 Reader (`PDFReader`, `EpubReader`, `TextReader`)。所有 Reader 需实现统一接口：
- `load(fileData)`
- `onPrevPage() / onNextPage()`
- `setSelectionMode(mode)` (In Progress)
- `goToLocation(loc)`

### 2. Highlight & Card System (高亮与卡片系统)
- **HighlightManager**: 负责在文档上创建、存储和渲染高亮。它生成唯一的 `highlightId`。
- **CardSystem**: 负责管理思维导图节点。当用户从文档拖拽内容时，创建一个关联了 `sourceId` (文件ID) 和 `highlightId` 的卡片。
- **Linkage**: 通过 `sourceId` + `highlightId` 实现从卡片到文档的反向定位。

### 3. Event Bus (事件总线)
使用原生 `CustomEvent` 进行模块间通信，解耦阅读器与导图模块。
- `mindmap-selection-changed`: 导图节点选中时触发，通知主界面更新底部信息栏。
- `jump-to-source`: 请求跳转到文档特定位置。

## 数据流 (Data Flow)

1. **Import**: 用户选择文件 -> 生成唯一 Hash ID -> 存入 `state.files` -> `openFile()`.
2. **Read & Annotate**: 用户在 Reader 中选中文本 -> `HighlightManager` 创建高亮对象 -> 触发 UI 反馈。
3. **Create Node**: 用户拖拽高亮 -> `CardSystem` 接收数据 -> 在 Drawnix 画板上创建节点。
4. **Persist**: 浏览器版定期检查工作区变化，创建引用共享文件内容的 IndexedDB 快照；阅读位置与偏好使用 LocalStorage。Electron 通过 IPC 写入本机目录。
