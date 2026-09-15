# Agent Review Host 注册改动说明

## 版本基线

- TeXlyre commit：`421c1fdc`
- TeXlyre package version：`0.12.1`
- 验证 Node：`v26.8.2`，通过 `fnm` 启动
- 改动日期：2026-09-15

本说明对应 MVP-A 的第一阶段：把 TeXlyre 当前已经存在的 live
CodeMirror/Yjs 编辑器注册给后续 AgentBridge。它不引入第二套 diff，也不改变 ReviewService、
ReviewPanel 或 Yjs 的数据结构。

## 工作树保护范围

修改前工作树已经存在以下用户改动，本次没有触碰：

- `public/sw.js`
- `src/types/userdata.ts`
- `translations/locales.config.json`

## 修改文件

### 新增

`src/services/AgentReviewHostRegistry.ts`

提供 `AgentReviewHostRegistry` 和单例 `agentReviewHostRegistry`，按
`projectId + path` 注册 live `EditorView`。

公开能力：

- `registerEditor()`：注册编辑器并返回注销函数。
- `getEditor()`：读取完整注册信息，包括是否只读。
- `getEditorView()`：按项目和路径取得 live `EditorView`。
- `listEditors()`：列出当前注册的编辑器快照，不泄漏 `EditorView` 对象。
- `subscribe()`：监听注册表变化。
- `texlyre-agent-review-host-changed`：浏览器 DOM 事件，给后续 bridge 做发现通知。

注册表只保存编辑器引用，不读取磁盘、不创建 review、不直接修改正文。

### 修改

`src/hooks/editor/useEditorView.ts`

- 在 hook 末尾增加可选的 `currentFilePath` 参数，避免破坏现有 viewer 调用点。
- `EditorView` 创建后注册到 `agentReviewHostRegistry`。
- 优先使用当前文件路径；缺少路径时从 `FileStoreService` 或
  `FilePathCacheService` 异步解析。
- React effect cleanup 时注销注册。
- 用取消标记避免异步路径解析完成后把已销毁的 editor 注册回去。

`src/components/editor/Editor.tsx`

- 将 `filePath || linkedFileInfo?.filePath` 传给 `useEditorView`。

`tests/unit/services/AgentReviewHostRegistry.test.ts`

- 验证注册、查询、注销。
- 验证旧 editor 的 disposer 不会删除同一路径上的新 editor。

## 运行时流程

```text
EditorContent
  -> useEditorView 创建 CodeMirror EditorView
  -> AgentReviewHostRegistry.registerEditor(projectId, path, view)
  -> AgentBridge 通过 registry 找到 live editor
  -> NativeReviewHost 读取 live 文本并校验 base hash
  -> TeXlyre 原生 ReviewService 创建 review tags
  -> ReviewPanel 展示 hunk
  -> 人工 accept/reject
  -> acceptReviewById/rejectReviewById
  -> CodeMirror transaction
  -> Yjs 同步
```

当前阶段只完成第一步注册。MCP Server 不应直接读取 `.tex` 磁盘副本，也不应绕过
ReviewPanel 修改正文。

## 验证

```bash
fnm exec --using=v26.8.2 node scripts/pm.cjs jest \
  tests/unit/services/AgentReviewHostRegistry.test.ts --runInBand

fnm exec --using=v26.8.2 node scripts/pm.cjs jest \
  tests/unit --runInBand

fnm exec --using=v26.8.2 node scripts/pm.cjs tsc --noEmit
```

本次验证结果：新增测试 2/2 通过；unit tests 为 49 suites、728 tests 全部通过；TypeScript
检查通过。

导入顺序检查仍会报告 TeXlyre 基线中既有文件的问题；本次新增文件不在该错误列表中。

## 后续迁移步骤

升级 TeXlyre 后，先确认目标 commit 是否仍包含以下结构：

- `src/hooks/editor/useEditorView.ts` 仍负责创建和销毁 `EditorView`。
- `src/components/editor/Editor.tsx` 仍是主 editor 的调用点。
- `FileStoreService.getFile()` 和 `FilePathCacheService.getLinkedFilePath()` 仍可用。

然后按以下顺序迁移：

1. 拷贝 `src/services/AgentReviewHostRegistry.ts`。
2. 将 `useEditorView.ts` 的最小修改重新应用到新版本对应位置。
3. 将 `Editor.tsx` 的 `currentFilePath` 参数重新应用到主调用点。
4. 拷贝并运行 registry 单元测试。
5. 通过后再实现 AgentBridge/MCP，不要把注册层与 MCP transport 绑定在一起。

对应的可迁移源码、测试和 patch 保存在 `TeXlyreAgent/texlyre-sync/421c1fdc/`。
