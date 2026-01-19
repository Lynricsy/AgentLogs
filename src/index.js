import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

const ROOT_DIR = process.cwd();
const DEFAULT_LOG_DIR = 'AgentLogs';

const LOG_DIR_NAME = normalizeLogDirName(process.env.AGENT_LOG_DIR ?? DEFAULT_LOG_DIR);
const LOG_DIR_PATH = path.resolve(ROOT_DIR, LOG_DIR_NAME);
const GITIGNORE_PATH = path.join(ROOT_DIR, '.gitignore');

function normalizeLogDirName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    return DEFAULT_LOG_DIR;
  }
  return trimmed.replace(/^\.\/+/, '');
}

function ensureLogDirInsideRoot() {
  const relative = path.relative(ROOT_DIR, LOG_DIR_PATH);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('日志目录必须位于当前工作目录下');
  }
}

function toGitignoreEntry(logDirName) {
  const normalized = String(logDirName).replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

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

function buildLogContent(title, content) {
  const safeTitle = String(title ?? '').trim() || '未命名记录';
  const body = String(content ?? '').trimEnd();
  if (!body) {
    return `# ${safeTitle}\n`;
  }
  return `# ${safeTitle}\n\n${body}\n`;
}

async function ensureLogDir() {
  await fs.mkdir(LOG_DIR_PATH, { recursive: true });
}

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

async function main() {
  const server = new McpServer({
    name: 'agent-log-server',
    version: '0.1.0'
  });

  server.registerTool(
    'record-agent-log',
    {
      title: '记录Agent工作日志',
      description: '根据标题和内容生成递增编号的Markdown日志，并自动维护.gitignore。',
      inputSchema: {
        title: z.string().min(1).describe('工作内容标题'),
        content: z.string().describe('工作记录内容')
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
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output
      };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP日志工具启动失败：', error);
  process.exit(1);
});
