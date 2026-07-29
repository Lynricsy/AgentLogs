# AGENTS.md — mcp-agentlogs

## 项目概览

这是一个单文件 MCP Agent 日志服务。`src/index.js` 提供 `record-agent-log`、`list-logs`、`read-log`、`search-logs` 四个工具。

- 语言：JavaScript ES modules。
- 基线：Node.js >= 24，同时支持 Bun。
- 入口：`src/index.js`。
- 依赖：`@modelcontextprotocol/sdk`、`sql.js`、Zod v4。
- 测试：Vitest 4，Node 环境。

Markdown 是唯一事实源。SQLite、BM25 统计和 embedding 都是可重建派生数据。

## 命令

```bash
npm ci
npm start
npm run start:bun
node --check src/index.js
npm test
npm pack --dry-run
```

没有构建步骤、linter 或 formatter。

## 架构不变量

- 保持单文件业务架构；核心逻辑位于 `src/index.js`。
- 默认存储目录为当前项目根下 `.agent-logs/`。
- `AGENT_LOG_DIR` 只允许项目内非 `.` 相对路径；禁止绝对路径、`..` 逃逸和符号链接。
- 所有运行时可变数据只能位于配置 storage 目录：Markdown、`index.sqlite`、锁、临时导出、损坏索引和未来磁盘缓存。
- 不使用 `os.homedir()`、`os.tmpdir()`、XDG 或项目外 fallback。
- 旧 `AgentLogs/` 只通过一次原子 rename 迁移；新旧目录冲突必须阻塞，禁止合并或覆盖。
- `search-logs` 只有 `hybrid` 实现；不要恢复旧搜索后端、provider 分支或旧环境变量。
- 词法检索必须使用自研中文分词和 BM25；sql.js 官方构建没有 FTS5，禁止退回 SQLite 默认分词。
- Embedding 与 Reranker 独立配置、独立 key、独立降级。Reranker 只能重排已经召回的前 30 个 chunk。
- 密钥永不落盘；查询向量 LRU 只在内存；Rerank 结果不缓存。
- metadata 只有紧跟 H1 的首个有效 `agentlogs-meta:v1` 块具有结构化权限。无效块不得隐藏日志或正文。
- 关系目标写入时必须是 storage 内现存的精确完整文件名；索引遇到手工编辑造成的断裂关系时忽略该边并产生 warning。

## 代码风格

- 2 空格缩进；始终使用分号和单引号；多行对象/数组使用尾逗号。
- Node 内置模块使用 `node:` 前缀。
- 默认 `const`，仅重赋值时使用 `let`，禁止 `var`。
- 使用 `async/await`，避免裸 Promise 链。
- 函数 camelCase，常量 SCREAMING_SNAKE_CASE，MCP tool 名 kebab-case。
- 逻辑区段使用 `// ========== 中文区段 ==========` 分隔。
- 所有新增注释、JSDoc、错误、warning、MCP 描述和用户可见文本使用简体中文。
- 数据库列名、JSON wire 字段、枚举和环境变量保留既定英文 literal。
- 错误必须包含必要上下文，但远程 API warning 只能包含 endpoint host、HTTP status/错误类型与中文原因；禁止泄露 key、完整 URL query 或响应 body。

## 搜索契约

- Markdown 按物理行和标题栈分块；metadata 不进入 chunk；每个 chunk 不超过 1800 字符。
- `search_text` 包含标题、章节、显式类型/标签/工件和 chunk 正文。
- SQLite schema version 为 `1`，同步以完整 Markdown SHA-256 为权威。
- 持久化采用 storage 内 lock、临时文件和原子 rename；失败时使用内存索引，不得使词法搜索失败。
- 通道为词法、语义、类型、时间和关系，RRF 权重固定；可选 Rerank 是第六路权重 2.0。
- 最终使用 lambda 0.75 的 MMR，每个文档最多两个 chunk。
- 结果必须返回真实 `startLine`/`endLine`、逐通道 signals、修订信息和 diagnostics。
- `diagnostics.mode` 只有当前查询向量成功且当前模型语料向量实际参与排名时才是 `hybrid`，否则为 `lexical-only`。

## 测试规则

- 测试 fixture、数据库、锁和临时缓存只能位于仓库内 `.agent-logs-test-workspaces/`。
- 禁止测试导入 `node:os` 或使用系统临时目录。
- 每个用例使用 `fs.mkdtemp(path.join(parent, 'case-'))` 风格的独立项目根，测试完成后删除 parent。
- 纯算法测试验证确定性分词、BM25、RRF、Rerank 响应、MMR、float32 编解码和布局校验。
- 集成测试必须使用 MCP SDK `Client` 与 `StdioClientTransport` 启动真实 `src/index.js` 子进程，并显式覆盖所有远程 API 环境变量，禁止继承开发机凭据。

## 发布

- 包版本与 `McpServer` version 必须同步。
- 发布工作流使用 Node 24，在 `npm ci` 后、`npm publish` 前运行 `npm test`。
- 版本 tag 使用 `v*`；不要在普通实现任务中创建或推送 tag。

## Git

提交格式：

```text
<type>(<scope>): <gitmoji> <subject>

Co-authored-by: Wine Fox <fox@ling.plus>
```

禁止设置 local git config；使用已有全局身份。
