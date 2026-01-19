#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// ============================================================================
// 常量定义
// ============================================================================

const ROOT_DIR = process.cwd();
const DEFAULT_LOG_DIR = 'AgentLogs';

const LOG_DIR_NAME = normalizeLogDirName(process.env.AGENT_LOG_DIR ?? DEFAULT_LOG_DIR);
const LOG_DIR_PATH = path.resolve(ROOT_DIR, LOG_DIR_NAME);
const GITIGNORE_PATH = path.join(ROOT_DIR, '.gitignore');

// ACE API 配置（用于搜索功能）
const ACE_BASE_URL = process.env.ACE_BASE_URL || '';
const ACE_API_KEY = process.env.ACE_API_KEY || '';

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 规范化日志目录名称
 */
function normalizeLogDirName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    return DEFAULT_LOG_DIR;
  }
  return trimmed.replace(/^\.\/+/, '');
}

/**
 * 确保日志目录在根目录内
 */
function ensureLogDirInsideRoot() {
  const relative = path.relative(ROOT_DIR, LOG_DIR_PATH);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('日志目录必须位于当前工作目录下');
  }
}

/**
 * 转换为 .gitignore 条目格式
 */
function toGitignoreEntry(logDirName) {
  const normalized = String(logDirName).replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

/**
 * 清理标题为安全的文件名
 */
function sanitizeTitle(rawTitle) {
  const trimmed = String(rawTitle ?? '').trim();
  const cleaned = trimmed
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/^-+/g, '');

  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return 'untitled';
  }
  return cleaned;
}

/**
 * 构建日志内容
 */
function buildLogContent(title, content) {
  const safeTitle = String(title ?? '').trim() || '未命名记录';
  const body = String(content ?? '').trimEnd();
  if (!body) {
    return `# ${safeTitle}\n`;
  }
  return `# ${safeTitle}\n\n${body}\n`;
}

/**
 * 确保日志目录存在
 */
async function ensureLogDir() {
  await fs.mkdir(LOG_DIR_PATH, { recursive: true });
}

/**
 * 确保 .gitignore 中包含日志目录
 */
async function ensureGitignoreEntry() {
  const entry = toGitignoreEntry(LOG_DIR_NAME);
  let existing = '';

  try {
    existing = await fs.readFile(GITIGNORE_PATH, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  const hasEntry = lines.some((line) => line === entry || line === entry.replace(/\/$/, ''));

  if (hasEntry) {
    return;
  }

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const nextContent = `${existing}${prefix}${entry}\n`;
  await fs.writeFile(GITIGNORE_PATH, nextContent, 'utf8');
}

/**
 * 获取下一个日志编号
 */
async function getNextLogNumber() {
  let entries = [];

  try {
    entries = await fs.readdir(LOG_DIR_PATH, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return 1;
    }
    throw error;
  }

  let maxNumber = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(/^(\d{4})-.*\.md$/);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (parsed > maxNumber) {
      maxNumber = parsed;
    }
  }

  if (maxNumber >= 9999) {
    throw new Error('日志编号已达到上限 9999');
  }
  return maxNumber + 1;
}

/**
 * 解析日志文件名
 */
function parseLogFileName(fileName) {
  const match = fileName.match(/^(\d{4})-(.*)\.md$/);
  if (!match) {
    return null;
  }
  return {
    number: Number.parseInt(match[1], 10),
    title: match[2].replace(/-/g, ' ')
  };
}

/**
 * 从日志内容中提取标题
 */
function extractTitleFromContent(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// ============================================================================
// 核心功能实现
// ============================================================================

/**
 * 记录 Agent 日志
 */
async function recordAgentLog({ title, content }) {
  const trimmedTitle = String(title ?? '').trim();
  if (!trimmedTitle) {
    throw new Error('title不能为空');
  }

  ensureLogDirInsideRoot();
  await ensureLogDir();
  await ensureGitignoreEntry();

  const nextNumber = await getNextLogNumber();
  const numberText = String(nextNumber).padStart(4, '0');
  const fileTitle = sanitizeTitle(trimmedTitle);
  const fileName = `${numberText}-${fileTitle}.md`;
  const filePath = path.join(LOG_DIR_PATH, fileName);
  const fileContent = buildLogContent(trimmedTitle, content);

  await fs.writeFile(filePath, fileContent, 'utf8');

  return {
    filePath,
    fileName,
    number: nextNumber,
    logDir: LOG_DIR_NAME
  };
}

/**
 * 列出所有日志
 */
async function listLogs() {
  let entries = [];

  try {
    entries = await fs.readdir(LOG_DIR_PATH, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { logs: [], total: 0, logDir: LOG_DIR_NAME };
    }
    throw error;
  }

  const logs = [];
  
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    
    const parsed = parseLogFileName(entry.name);
    if (!parsed) {
      continue;
    }

    const filePath = path.join(LOG_DIR_PATH, entry.name);
    const stat = await fs.stat(filePath);
    
    // 尝试从文件内容中提取真实标题
    let title = parsed.title;
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const extractedTitle = extractTitleFromContent(content);
      if (extractedTitle) {
        title = extractedTitle;
      }
    } catch {
      // 忽略读取错误，使用文件名中的标题
    }

    logs.push({
      number: parsed.number,
      fileName: entry.name,
      title,
      createdAt: stat.birthtime.toISOString()
    });
  }

  // 按编号排序
  logs.sort((a, b) => a.number - b.number);

  return {
    logs,
    total: logs.length,
    logDir: LOG_DIR_NAME
  };
}

/**
 * 读取指定日志
 */
async function readLog({ identifier }) {
  if (identifier === undefined || identifier === null || identifier === '') {
    throw new Error('identifier 不能为空');
  }

  let fileName;
  let number;

  // 判断是编号还是文件名
  if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
    number = typeof identifier === 'number' ? identifier : Number.parseInt(identifier, 10);
    const numberText = String(number).padStart(4, '0');
    
    // 查找匹配的文件
    let entries = [];
    try {
      entries = await fs.readdir(LOG_DIR_PATH);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`日志目录不存在: ${LOG_DIR_NAME}`);
      }
      throw error;
    }

    fileName = entries.find((name) => name.startsWith(`${numberText}-`) && name.endsWith('.md'));
    if (!fileName) {
      throw new Error(`未找到编号为 ${number} 的日志`);
    }
  } else {
    fileName = String(identifier);
    const parsed = parseLogFileName(fileName);
    if (!parsed) {
      throw new Error(`无效的日志文件名: ${fileName}`);
    }
    number = parsed.number;
  }

  const filePath = path.join(LOG_DIR_PATH, fileName);
  
  let content;
  let stat;
  try {
    content = await fs.readFile(filePath, 'utf8');
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`日志文件不存在: ${fileName}`);
    }
    throw error;
  }

  const title = extractTitleFromContent(content) || parseLogFileName(fileName)?.title || '未知标题';

  return {
    number,
    fileName,
    title,
    content,
    createdAt: stat.birthtime.toISOString()
  };
}

/**
 * 搜索日志（调用 ACE API）
 */
async function searchLogs({ query }) {
  if (!query || !String(query).trim()) {
    throw new Error('query 不能为空');
  }

  if (!ACE_BASE_URL || !ACE_API_KEY) {
    throw new Error('搜索功能需要配置 ACE_BASE_URL 和 ACE_API_KEY 环境变量');
  }

  // 确保 base_url 使用 https
  let baseUrl = ACE_BASE_URL;
  if (baseUrl.startsWith('http://')) {
    baseUrl = baseUrl.replace('http://', 'https://');
  } else if (!baseUrl.startsWith('https://')) {
    baseUrl = `https://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  // 调用 ACE API 进行搜索
  const searchEndpoint = `${baseUrl}/v1/search`;
  
  try {
    const response = await fetch(searchEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ACE_API_KEY}`
      },
      body: JSON.stringify({
        project_root_path: LOG_DIR_PATH,
        query: String(query).trim()
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ACE API 请求失败 (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    
    return {
      query: String(query).trim(),
      results: result.results || result.text || result,
      logDir: LOG_DIR_NAME
    };
  } catch (error) {
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error(`无法连接到 ACE API: ${baseUrl}`);
    }
    throw error;
  }
}

// ============================================================================
// MCP 服务器
// ============================================================================

async function main() {
  const server = new McpServer({
    name: 'agent-log-server',
    version: '1.0.0'
  });

  // 工具 1: 记录日志
  server.registerTool(
    'record-agent-log',
    {
      title: '记录 Agent 工作日志',
      description: '根据标题和内容生成递增编号的 Markdown 日志文件，并自动维护 .gitignore。',
      inputSchema: {
        title: z.string().min(1).describe('工作内容标题'),
        content: z.string().describe('工作记录内容（Markdown 格式）')
      },
      outputSchema: {
        filePath: z.string(),
        fileName: z.string(),
        number: z.number(),
        logDir: z.string()
      }
    },
    async ({ title, content }) => {
      const output = await recordAgentLog({ title, content });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // 工具 2: 列出所有日志
  server.registerTool(
    'list-logs',
    {
      title: '列出所有日志',
      description: `列出日志目录（${LOG_DIR_NAME}）中的所有历史日志记录，返回编号、文件名、标题和创建时间。`,
      inputSchema: {},
      outputSchema: {
        logs: z.array(z.object({
          number: z.number(),
          fileName: z.string(),
          title: z.string(),
          createdAt: z.string()
        })),
        total: z.number(),
        logDir: z.string()
      }
    },
    async () => {
      const output = await listLogs();
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // 工具 3: 读取指定日志
  server.registerTool(
    'read-log',
    {
      title: '读取指定日志',
      description: '根据日志编号或文件名读取指定日志的完整内容。',
      inputSchema: {
        identifier: z.union([z.string(), z.number()]).describe('日志编号（如 1 或 "1"）或文件名（如 "0001-任务标题.md"）')
      },
      outputSchema: {
        number: z.number(),
        fileName: z.string(),
        title: z.string(),
        content: z.string(),
        createdAt: z.string()
      }
    },
    async ({ identifier }) => {
      const output = await readLog({ identifier });
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  // 工具 4: 搜索日志
  server.registerTool(
    'search-logs',
    {
      title: '搜索历史日志',
      description: `**重要提示：当需要查找历史记录时，优先使用此工具进行搜索！**

使用自然语言搜索历史日志记录。此工具调用 ACE 代码搜索引擎，支持语义搜索。

## 使用场景
- 当你需要查找之前做过的相关任务
- 当你想了解某个功能的实现历史
- 当你需要回顾之前的解决方案

## 查询示例
- "查找关于数据库连接的日志"
- "之前做过哪些 API 相关的任务？"
- "修复登录 bug 的记录"
- "用户认证功能的实现过程"

## 注意
此工具需要配置 ACE_BASE_URL 和 ACE_API_KEY 环境变量。`,
      inputSchema: {
        query: z.string().min(1).describe('自然语言搜索查询')
      },
      outputSchema: {
        query: z.string(),
        results: z.any(),
        logDir: z.string()
      }
    },
    async ({ query }) => {
      const output = await searchLogs({ query });
      return {
        content: [{ type: 'text', text: typeof output.results === 'string' ? output.results : JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP 日志工具启动失败：', error);
  process.exit(1);
});
