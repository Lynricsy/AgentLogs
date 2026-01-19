# 🐱 MCP Agent 日志记录工具

<p align="center">
  <strong>一个基于 Model Context Protocol (MCP) 的 Agent 工作日志管理工具</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#工具说明">工具说明</a> •
  <a href="#配置说明">配置说明</a> •
  <a href="#许可证">许可证</a>
</p>

---

## 📖 概述

MCP Agent 日志记录工具是一个专为 AI Agent 设计的工作日志管理 MCP 服务器。它提供了简单而强大的日志记录、查询和搜索功能，帮助 Agent 和用户追踪工作历史、回顾任务进度。

### 为什么需要这个工具？

- **任务追踪**：自动记录 Agent 的每个工作阶段，便于回溯和审查
- **知识沉淀**：将工作过程中的关键信息保存为可检索的文档
- **历史查询**：支持列出、查看和搜索历史记录，快速定位所需信息

## ✨ 功能特性

- 📝 **日志记录** - 自动生成递增编号的 Markdown 日志文件（`0001-标题.md` 格式）
- 📋 **列出记录** - 获取所有历史日志的列表，包含编号、标题和创建时间
- 👁️ **查看记录** - 读取指定编号或文件名的日志内容
- 🔍 **智能搜索** - 使用自然语言搜索历史记录（需配置 ACE API）
- 🔒 **自动 .gitignore** - 自动将日志目录加入 `.gitignore`，保护隐私
- 🗂️ **可配置目录** - 支持通过环境变量自定义日志目录

## 🚀 快速开始

### 使用 npx（推荐）

```bash
npx mcp-agentlogs@latest
```

### 使用 bunx

```bash
bunx mcp-agentlogs@latest
```

### 从源码运行

```bash
# 克隆仓库
git clone https://github.com/Lynricsy/AgentLogs.git
cd AgentLogs

# 安装依赖
npm install

# 使用 Node.js 运行
npm start

# 或使用 Bun 运行
npm run start:bun
```

## 🔧 MCP 配置

### Claude Desktop 配置

在 Claude Desktop 配置文件中添加：

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "agent-logs": {
      "command": "npx",
      "args": ["-y", "mcp-agentlogs@latest"],
      "env": {
        "AGENT_LOG_DIR": "AgentLogs"
      }
    }
  }
}
```

### Cursor 配置

在 MCP 配置文件中添加：

```json
{
  "agent-logs": {
    "type": "stdio",
    "command": "bunx",
    "args": ["-y", "mcp-agentlogs@latest"],
    "env": {
      "AGENT_LOG_DIR": "AgentLogs"
    }
  }
}
```

### 启用搜索功能（可选）

如需使用 `search-logs` 工具进行智能搜索，需要配置 ACE API：

```json
{
  "agent-logs": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "mcp-agentlogs@latest"],
    "env": {
      "AGENT_LOG_DIR": "AgentLogs",
      "ACE_BASE_URL": "https://your-ace-api-endpoint.com",
      "ACE_API_KEY": "your-api-key"
    }
  }
}
```

## 🛠️ 工具说明

### `record-agent-log`

记录 Agent 工作日志，生成递增编号的 Markdown 文件。

**输入参数：**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `title` | string | ✅ | 工作内容标题 |
| `content` | string | ❌ | 工作记录内容（Markdown 格式） |

**输出：**

```json
{
  "filePath": "/path/to/AgentLogs/0001-任务标题.md",
  "fileName": "0001-任务标题.md",
  "number": 1,
  "logDir": "AgentLogs"
}
```

### `list-logs`

列出所有历史日志记录。

**输入参数：** 无

**输出：**

```json
{
  "logs": [
    {
      "number": 1,
      "fileName": "0001-任务标题.md",
      "title": "任务标题",
      "createdAt": "2025-01-19T12:00:00.000Z"
    }
  ],
  "total": 1,
  "logDir": "AgentLogs"
}
```

### `read-log`

读取指定日志的内容。

**输入参数：**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `identifier` | string/number | ✅ | 日志编号（如 `1` 或 `"1"`）或文件名（如 `"0001-任务标题.md"`） |

**输出：**

```json
{
  "number": 1,
  "fileName": "0001-任务标题.md",
  "title": "任务标题",
  "content": "# 任务标题\n\n日志内容...",
  "createdAt": "2025-01-19T12:00:00.000Z"
}
```

### `search-logs`

使用自然语言搜索历史日志记录。

> ⚠️ 此工具需要配置 ACE API（`ACE_BASE_URL` 和 `ACE_API_KEY`）

**输入参数：**

| 参数 | 类型 | 必需 | 描述 |
|------|------|------|------|
| `query` | string | ✅ | 自然语言搜索查询 |

**查询示例：**

- "查找关于数据库连接的日志"
- "之前做过哪些 API 相关的任务？"
- "修复登录 bug 的记录"

**输出：** 返回与查询相关的日志片段和文件信息。

---

## ⚙️ 环境变量

| 变量名 | 描述 | 默认值 |
|--------|------|--------|
| `AGENT_LOG_DIR` | 日志目录名称（相对于工作目录） | `AgentLogs` |
| `ACE_BASE_URL` | ACE 搜索 API 的基础 URL | - |
| `ACE_API_KEY` | ACE 搜索 API 的认证密钥 | - |

## 📝 使用提示

### 推荐给 Agent 的提示词

在你的 Agent 系统提示词中加入以下内容，以便更好地利用此工具：

```
## 日志记录规则

1. 在执行任务时，应在项目根目录下的 AgentLogs 目录中记录本次任务
2. 文件名格式为（编号-任务标题.md），编号为现有最大编号+1，使用四位数(0001~9999)
3. 对于大型复杂任务，每完成一个小阶段或重要节点就记录一次
4. 需要时可通过 list-logs 和 read-log 查看历史记录获取信息
5. **优先使用 search-logs 工具搜索历史记录**，快速定位相关信息
```

## 🔐 安全说明

- 日志目录会自动添加到 `.gitignore`，避免敏感信息被提交到版本控制
- 日志目录必须位于当前工作目录内，防止写入外部路径
- 文件名会自动清理特殊字符，确保跨平台兼容性

## 📄 许可证

ISC License

---

<p align="center">
  Made with 💜 by <a href="https://github.com/Lynricsy">Lynricsy</a>
</p>
