# AgentBridge / MCP / Skills 接入说明

## 版本

- TeXlyre baseline：`421c1fdc`
- package version：`0.12.1`
- Node：`v26.8.2`

本阶段在第一阶段的 `AgentReviewHostRegistry` 上增加浏览器侧 AgentBridge。AgentBridge
不拥有 Review 状态机；它只负责接收本地 sidecar 请求，并把请求路由到当前 TeXlyre
project 的 live editor 和原生 tracked changes。

## 组件关系

```text
Codex / DSH
    │ MCP stdio
    ▼
TeXlyreAgent/src/mcp/texlyre-stdio.ts
    │ LocalBridgeHub + HTTP long-poll
    ▼
TeXlyre/src/services/AgentBridgeService.ts
    │ AgentReviewHostRegistry
    ▼
live CodeMirror/Yjs EditorView
    │
    ├── ReviewService.createReview()
    ├── ReviewExtension.getReviewChunks()
    ├── acceptReviewById()
    └── rejectReviewById()
         ▲
         └── ReviewPanel decision -> POST /bridge/call -> sidecar metadata
```

## TeXlyre 侧文件

`src/services/AgentBridgeService.ts` 提供：

- 浏览器侧 `/bridge/poll` long-poll client。
- `/bridge/respond` response client。
- `project.getContext`、`project.listFiles`、`document.readFile`。
- `review.stageChangeSet`：把 ChangeSet hunk 转成 TeXlyre 原生 review tags。
- `review.applyChangeSet`：在 stale 校验后调用 TeXlyre 原生 accept/reject action。
- `POST /bridge/call`：把 ReviewPanel 的单条或全量 accept/reject 映射回 ChangeSet hunk，
  并调用 sidecar `ReviewService.decideHunk`。

`src/hooks/editor/useEditorView.ts` 在 editor 注册时启动 bridge。只有配置
`VITE_TEXLYRE_AGENT_BRIDGE_URL` 时才会启动，普通 TeXlyre 使用不受影响。

## 启动

先启动 sidecar：

```bash
cd /home/hitcsc/GL/ResearchHub/Plugins/TeXlyreAgent
export TEXLYRE_AGENT_BRIDGE_TOKEN='replace-with-a-local-secret'
fnm exec --using=v26.8.2 npm run mcp:texlyre
```

再用相同 token 启动 TeXlyre：

```bash
VITE_TEXLYRE_AGENT_BRIDGE_URL='http://127.0.0.1:49321' \
VITE_TEXLYRE_AGENT_BRIDGE_TOKEN='replace-with-a-local-secret' \
pnpm dev
```

sidecar 默认绑定 `127.0.0.1:49321`，可通过 `TEXLYRE_AGENT_BRIDGE_PORT` 修改；配置 token
后，`poll`、`respond`、`call` 和 `health` 均需要相同的 Bearer token。

## Agent 能力边界

MCP 只暴露：

```text
texlyre_get_project_context
texlyre_list_files
texlyre_read_file
texlyre_propose_changes
texlyre_get_change_set
texlyre_get_review_feedback
```

MCP 不暴露 accept/reject/apply。Agent proposal 只创建原生 review tags；正式正文仍由
人类 ReviewPanel 操作决定。人工决策会同步到 sidecar，agent 后续读取 ChangeSet 时可
看到真实的 hunk 和聚合状态。

## 文件生命周期限制

`texlyre_list_files` 可以列出项目中的文本文件，但 `texlyre_read_file` 和 staging 要求
目标文件当前有 live `EditorView`。bridge 不会偷偷读取磁盘副本，避免绕过 Yjs 当前状态。

sidecar 的 ChangeSet/feedback metadata 当前保存在进程内存中；sidecar 重启后需要重新
创建 proposal。

## 验证

```bash
fnm exec --using=v26.8.2 node scripts/pm.cjs tsc --noEmit
fnm exec --using=v26.8.2 node scripts/pm.cjs jest tests/unit --runInBand
```

插件侧验证：

```bash
fnm exec --using=v26.8.2 npm run verify
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | fnm exec --using=v26.8.2 npm run mcp:texlyre
```
