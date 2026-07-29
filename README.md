# MCP Agent 日志记录工具

一个基于 Model Context Protocol（MCP）的项目本地 Agent 工作日志服务。Markdown 是唯一事实源；SQLite、词法统计和向量均为可删除、可重建的派生索引。

## 功能

- 以 `0001-标题.md` 格式记录递增编号日志。
- 在 H1 后持久化 `agentlogs-meta:v1`，记录类型、标签、工件、修订关系和创建时间。
- 使用中文 BM25、可选 OpenAI-compatible embedding、类型、时间与关系通道混合召回。
- 使用 RRF 融合、可选通用 Rerank API 和 MMR 多样性选择。
- 返回真实 Markdown 行号、召回信号、修订状态与降级诊断。
- 所有运行时数据严格保存在当前项目的存储目录内。
- 支持 Node.js 24 LTS 和 Bun。

## 要求

- Node.js >= 24.0.0，或兼容当前依赖的 Bun。
- MCP 客户端必须以目标项目目录作为服务器工作目录。

## 快速开始

```bash
npx mcp-agentlogs@latest
# 或
bunx mcp-agentlogs@latest
```

从源码运行：

```bash
npm ci
npm start
# Bun
npm run start:bun
```

## MCP 配置

默认无需环境变量：

```json
{
  "mcpServers": {
    "agent-logs": {
      "command": "npx",
      "args": ["-y", "mcp-agentlogs@latest"]
    }
  }
}
```

### 启用向量与模型重排

```json
{
  "mcpServers": {
    "agent-logs": {
      "command": "npx",
      "args": ["-y", "mcp-agentlogs@latest"],
      "env": {
        "AGENT_LOG_EMBEDDING_API_URL": "https://api.example.com/v1",
        "AGENT_LOG_EMBEDDING_API_KEY": "embedding-key",
        "AGENT_LOG_EMBEDDING_MODEL": "multilingual-embedding",
        "AGENT_LOG_RERANK_API_URL": "https://api.example.com/v1/rerank?tenant=project",
        "AGENT_LOG_RERANK_API_KEY": "reranker-key",
        "AGENT_LOG_RERANK_MODEL": "multilingual-reranker"
      }
    }
  }
}
```

Embedding URL 必须是绝对 `http:` 或 `https:` URL。若最后一个路径段不是 `embeddings`，服务会追加 `/embeddings`。请求与 OpenAI-compatible `/embeddings` 契约一致：

```json
{ "model": "...", "input": ["..."] }
```

Rerank URL 必须是完整的绝对 endpoint；服务不会追加路径。请求固定为 Cohere、Jina、SiliconFlow 与 Voyage 共同子集：

```json
{ "model": "...", "query": "...", "documents": ["..."] }
```

服务接受 `results[]` 或 `data[]`，每项必须包含完整且不重复的 `index` 与有限数值 `relevance_score`。Reranker 只重排五路召回前 30 个 chunk，不能新增候选，失败时完整回退初始 RRF。

Embedding 与 Reranker 配置、超时和密钥完全独立。只配置 URL 或模型时，对应能力关闭并产生诊断 warning；词法搜索始终可用。

## 项目本地存储与迁移

默认存储目录是项目根下 `.agent-logs/`。`AGENT_LOG_DIR` 只接受项目内非 `.` 相对路径；绝对路径、`..` 逃逸和符号链接路径会使服务启动失败。

以下值都使用默认布局并参与旧目录迁移：

- 未设置或空值；
- `.agent-logs`；
- 旧字面量 `AgentLogs`。

启动时若只有旧 `AgentLogs/`，服务会用同文件系统原子 `rename` 为 `.agent-logs/`。若新旧目录同时存在，服务拒绝启动，不复制、不合并、不覆盖。显式的其他项目内相对目录不会探测旧目录。

存储目录包含：

```text
.agent-logs/
├── 0001-任务标题.md
├── index.sqlite
├── index.lock                         # 仅持锁期间存在
├── index.<pid>.<uuid>.tmp             # 仅原子导出期间存在
└── index.corrupt-<timestamp>.sqlite   # 损坏索引诊断副本
```

Markdown 是唯一不可替代数据。删除 `index.sqlite` 后，下次搜索会从 Markdown 全量重建。锁超时、索引损坏或持久化失败不会改写 Markdown，也不会使用项目外临时目录。

## 工具

### `record-agent-log`

输入：

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 必需，日志标题 |
| `content` | string | Markdown 正文 |
| `types` | enum[] | 最多 10 项：`decision`、`rationale`、`learning`、`error`、`verification`、`config`、`artifact`、`event`、`context`、`action` |
| `tags` | string[] | 最多 32 项，每项 1–64 字符 |
| `artifacts` | string[] | 最多 32 项，每项 1–256 字符 |
| `relations` | object[] | 最多 16 项，`type` 为 `supersedes`、`corrects`、`follows_up`、`validates`、`releases`，`target` 是现存完整日志文件名 |

数组按第一次出现顺序去重。关系目标必须是存储目录内现存的普通 Markdown 文件。

新日志格式：

```markdown
# 标题

<!-- agentlogs-meta:v1
{"version":1,"createdAt":"2026-07-29T00:00:00.000Z","types":["decision"],"tags":["中文检索"],"artifacts":["src/index.js"],"relations":[]}
-->

正文
```

只有紧跟 H1（允许空行）的第一个有效 metadata 块具有结构化权限。旧日志没有 metadata 时仍可读取和索引，创建时间由文件系统时间派生。

### `list-logs`

返回编号、文件名、标题、创建时间和标准化 `metadata`。

### `read-log`

按编号或完整文件名返回原始 Markdown。`content` 保留 metadata 注释，同时返回标准化 `metadata`。

### `search-logs`

`query` trim 后必须为 1–4000 字符。顶层 `provider` 固定为 `hybrid`；这表示唯一搜索实现，不代表每次都成功使用向量。

结构化返回包含：

- `matches[]`：项目相对路径、标题、章节、真实物理行范围、摘要、相关度、类型、标签、工件、修订来源；
- `signals`：词法、语义、类型、时间、关系和 Rerank 的 rank/score；
- `diagnostics.mode`：只有查询向量成功且至少一个当前模型语料向量参与排名时为 `hybrid`，否则为 `lexical-only`；
- `diagnostics.warnings`：索引、metadata、断裂关系、embedding 与 Reranker 的安全降级原因。

时间通道只在查询明确包含最近、今天、日期等时间意图时启用；普通查询不会衰减旧日志。`corrects`/`supersedes` 的旧目标默认降权，查询明确要求历史或旧方案时保留原权重。

## 环境变量

| 变量 | 默认值 | 约束 |
|---|---:|---|
| `AGENT_LOG_DIR` | `.agent-logs` | 仅项目内相对目录 |
| `AGENT_LOG_EMBEDDING_API_URL` | 空 | URL 与模型同时非空才启用 |
| `AGENT_LOG_EMBEDDING_API_KEY` | 空 | 可选，不落盘 |
| `AGENT_LOG_EMBEDDING_MODEL` | 空 | URL 与模型同时非空才启用 |
| `AGENT_LOG_EMBEDDING_TIMEOUT_MS` | `30000` | `1000..300000` |
| `AGENT_LOG_EMBEDDING_BATCH_SIZE` | `32` | `1..128` |
| `AGENT_LOG_RERANK_API_URL` | 空 | 完整 endpoint；与模型同时非空才启用 |
| `AGENT_LOG_RERANK_API_KEY` | 空 | 可选，不继承 embedding key，不落盘 |
| `AGENT_LOG_RERANK_MODEL` | 空 | URL 与模型同时非空才启用 |
| `AGENT_LOG_RERANK_TIMEOUT_MS` | `10000` | `1000..60000` |
| `AGENT_LOG_SEARCH_MAX_RESULTS` | `5` | `1..20` |

## 外发内容与隐私

启用 embedding 时，服务只发送 trim 后的查询和每个 chunk 的有界 `search_text`；超过 4096 字符的文本保留首尾。不会发送完整 Markdown 文件、数据库、关系图或索引元数据。

启用 Reranker 时，服务最多发送 30 个候选字符串。每个字符串包含项目相对文件名、标题、章节、创建时间、类型、标签、工件和该 chunk 的 `search_text`。Rerank 分数只存在于当前查询内，不写 SQLite、不写磁盘缓存。

API key 只通过请求头发送，不写磁盘、不进入模型 key、warning 或结构化结果。查询向量只保存在最多 256 项的进程内 LRU 中。

## 开发与验证

```bash
npm ci
node --check src/index.js
npm test
npm pack --dry-run
```

Vitest 使用仓库内 `.agent-logs-test-workspaces/`，不使用系统临时目录。发布工作流在 `npm ci` 后、`npm publish` 前执行完整测试。

## 许可证

ISC
