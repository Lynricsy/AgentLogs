#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const ACE_USER_AGENT = 'augment.cli/0.12.0';
const ACE_REQUEST_TIMEOUT_MS = getPositiveInt(process.env.ACE_REQUEST_TIMEOUT_MS, 30000);
const ACE_MAX_LINES_PER_BLOB = getPositiveInt(process.env.ACE_MAX_LINES_PER_BLOB, 800);
const ACE_MAX_BATCH_BYTES = 1024 * 1024;
const ACE_RETRY_LIMIT = 3;
const ACE_RETRY_BASE_MS = 1000;
let aceSessionId;

// 搜索后端配置
const SEARCH_PROVIDER = normalizeSearchProvider(process.env.AGENT_LOG_SEARCH_PROVIDER ?? 'auto');
const FAST_CONTEXT_TREE_DEPTH = getBoundedInt(process.env.FC_TREE_DEPTH, 3, 1, 6);
const FAST_CONTEXT_MAX_TURNS = getBoundedInt(process.env.FC_MAX_TURNS, 3, 1, 5);
const FAST_CONTEXT_MAX_COMMANDS = getBoundedInt(process.env.FC_MAX_COMMANDS, 8, 1, 20);
const FAST_CONTEXT_MAX_RESULTS = getBoundedInt(process.env.FC_MAX_RESULTS, 10, 1, 30);
const FAST_CONTEXT_TIMEOUT_MS = getBoundedInt(process.env.FC_TIMEOUT_MS, 30000, 1000, 300000);
const FAST_CONTEXT_EXCLUDE_PATHS = parseStringList(process.env.FC_EXCLUDE_PATHS);
let fastContextModulePromise;

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取正整数配置，非法时返回默认值
 */
function getPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * 获取带上下限的正整数配置
 */
function getBoundedInt(value, fallback, min, max) {
  const parsed = getPositiveInt(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 解析逗号分隔的字符串列表
 */
function parseStringList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 规范化搜索后端名称
 */
function normalizeSearchProvider(provider) {
  const normalized = String(provider ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') {
    return 'auto';
  }
  if (normalized === 'ace') {
    return 'ace';
  }
  if (['fast-context', 'fast_context', 'fastcontext', 'fc'].includes(normalized)) {
    return 'fast-context';
  }
  throw new Error('AGENT_LOG_SEARCH_PROVIDER 仅支持 auto、ace 或 fast-context');
}

/**
 * 根据配置和环境变量选择搜索后端
 */
function resolveSearchProvider() {
  if (SEARCH_PROVIDER !== 'auto') {
    return SEARCH_PROVIDER;
  }
  if (ACE_BASE_URL && ACE_API_KEY) {
    return 'ace';
  }
  return 'fast-context';
}

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
 * 搜索日志
 */
async function searchLogs({ query }) {
  if (!query || !String(query).trim()) {
    throw new Error('query 不能为空');
  }

  const normalizedQuery = String(query).trim();
  const provider = resolveSearchProvider();

  if (provider === 'ace') {
    if (!ACE_BASE_URL || !ACE_API_KEY) {
      throw new Error('search-logs 使用 ACE 时需要配置 ACE_BASE_URL 和 ACE_API_KEY');
    }
    return await searchLogsWithAce(normalizedQuery);
  }

  return await searchLogsWithFastContext(normalizedQuery);
}

/**
 * 使用 ACE API 进行语义搜索
 */
async function searchLogsWithAce(query) {
  const baseUrl = normalizeAceBaseUrl(ACE_BASE_URL);

  // 先收集日志内容并拆分为 blobs
  const blobs = await collectLogBlobs();
  if (blobs.length === 0) {
    return {
      query,
      results: '日志目录为空，没有可搜索的内容。',
      logDir: LOG_DIR_NAME,
      provider: 'ace'
    };
  }

  // 上传 blobs 获取 blob_names
  const blobNames = await uploadBlobs(baseUrl, blobs);
  if (blobNames.length === 0) {
    return {
      query,
      results: '日志内容上传失败，无法执行搜索。',
      logDir: LOG_DIR_NAME,
      provider: 'ace'
    };
  }

  const searchEndpoint = `${baseUrl}/agents/codebase-retrieval`;
  const requestBody = {
    information_request: query,
    blobs: {
      checkpoint_id: null,
      added_blobs: blobNames,
      deleted_blobs: []
    },
    dialog: [],
    max_output_length: 0,
    disable_codebase_retrieval: false,
    enable_commit_retrieval: false
  };

  const response = await postAceJson(searchEndpoint, requestBody, ACE_REQUEST_TIMEOUT_MS);
  const result = await safeReadJson(response);
  const formatted = String(result?.formatted_retrieval ?? '').trim();

  return {
    query,
    results: formatted || '未找到相关内容。',
    logDir: LOG_DIR_NAME,
    provider: 'ace'
  };
}

/**
 * 使用 fast-context 进行语义搜索
 */
async function searchLogsWithFastContext(query) {
  if (!(await hasMarkdownLogs())) {
    return {
      query,
      results: '日志目录为空，没有可搜索的内容。',
      logDir: LOG_DIR_NAME,
      provider: 'fast-context'
    };
  }

  let result;
  try {
    const { search } = await loadFastContextModule();
    result = await search({
      query,
      projectRoot: LOG_DIR_PATH,
      apiKey: process.env.WINDSURF_API_KEY || null,
      maxTurns: FAST_CONTEXT_MAX_TURNS,
      maxCommands: FAST_CONTEXT_MAX_COMMANDS,
      maxResults: FAST_CONTEXT_MAX_RESULTS,
      treeDepth: FAST_CONTEXT_TREE_DEPTH,
      timeoutMs: FAST_CONTEXT_TIMEOUT_MS,
      excludePaths: FAST_CONTEXT_EXCLUDE_PATHS
    });
  } catch (error) {
    result = buildFastContextThrownError(error);
  }

  result = await filterFastContextLogFiles(result);

  return {
    query,
    results: formatFastContextResult(result),
    logDir: LOG_DIR_NAME,
    provider: 'fast-context'
  };
}

/**
 * 过滤 fast-context 返回的非日志文件候选
 */
async function filterFastContextLogFiles(result) {
  if (result?.error || !Array.isArray(result?.files)) {
    return result;
  }

  const validFiles = [];
  let filteredCount = 0;
  const seenPaths = new Set();
  const realLogDir = await fs.realpath(LOG_DIR_PATH);

  for (const entry of result.files) {
    const filePath = await resolveExistingLogFilePath(entry, realLogDir);
    if (!filePath) {
      filteredCount += 1;
      continue;
    }

    if (seenPaths.has(filePath)) {
      filteredCount += 1;
      continue;
    }

    seenPaths.add(filePath);
    validFiles.push({
      ...entry,
      full_path: filePath
    });
  }

  return {
    ...result,
    files: validFiles,
    _filteredFiles: filteredCount
  };
}

/**
 * 将 fast-context 候选路径解析为真实日志文件路径
 */
async function resolveExistingLogFilePath(entry, realLogDir) {
  const rawPath = String(entry?.full_path ?? entry?.path ?? '').trim();
  if (!rawPath) {
    return null;
  }

  const absolutePath = resolveFastContextCandidatePath(rawPath);

  let stat;
  let realPath;
  try {
    stat = await fs.stat(absolutePath);
    realPath = await fs.realpath(absolutePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || !realPath.endsWith('.md')) {
    return null;
  }

  const relativeToLogDir = path.relative(realLogDir, realPath);
  if (!relativeToLogDir || relativeToLogDir.startsWith('..') || path.isAbsolute(relativeToLogDir)) {
    return null;
  }

  return realPath;
}

/**
 * 解析 fast-context 返回的候选路径
 */
function resolveFastContextCandidatePath(rawPath) {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  const normalizedRawPath = rawPath.replace(/\\/g, '/');
  if (normalizedRawPath === LOG_DIR_NAME || normalizedRawPath.startsWith(`${LOG_DIR_NAME}/`)) {
    return path.resolve(ROOT_DIR, rawPath);
  }

  return path.resolve(LOG_DIR_PATH, rawPath);
}

/**
 * 判断是否存在可搜索的 Markdown 日志
 */
async function hasMarkdownLogs() {
  try {
    const entries = await fs.readdir(LOG_DIR_PATH, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.md'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * 延迟加载 fast-context，避免 ACE 模式承担额外启动成本
 */
async function loadFastContextModule() {
  if (!fastContextModulePromise) {
    fastContextModulePromise = import('@sammysnake/fast-context-mcp/src/core.mjs');
  }

  const module = await fastContextModulePromise;
  if (typeof module.search !== 'function') {
    throw new Error('fast-context 模块未导出 search 函数');
  }
  return module;
}

/**
 * 将 fast-context 抛出的异常转换为搜索结果
 */
function buildFastContextThrownError(error) {
  return {
    error: String(error?.message ?? error),
    _meta: {
      errorCode: error?.code || error?.name || 'UNKNOWN',
      projectRoot: LOG_DIR_PATH
    }
  };
}

/**
 * 格式化 fast-context 搜索结果
 */
function formatFastContextResult(result) {
  if (result?.error) {
    return formatFastContextError(result);
  }

  const files = Array.isArray(result?.files) ? result.files : [];
  const patterns = Array.isArray(result?.rg_patterns)
    ? [...new Set(result.rg_patterns)].filter((pattern) => String(pattern).length >= 3)
    : [];

  if (files.length === 0 && patterns.length === 0) {
    const raw = String(result?.raw_response ?? '').trim();
    return raw ? `未找到相关日志。\n\n原始响应：\n${raw}` : '未找到相关日志。';
  }

  const parts = [];
  if (files.length > 0) {
    parts.push(`找到 ${files.length} 个相关日志文件。`);
    parts.push('');
    files.forEach((entry, index) => {
      const ranges = formatFastContextRanges(entry.ranges);
      const displayPath = formatLogSearchPath(entry.full_path ?? entry.path);
      const rangeText = ranges ? ` (${ranges})` : '';
      parts.push(`  [${index + 1}/${files.length}] ${displayPath}${rangeText}`);
    });
  } else {
    parts.push('未定位到具体日志文件。');
  }

  if (patterns.length > 0) {
    parts.push('');
    parts.push(`建议后续关键词：${patterns.join(', ')}`);
  }

  if (result?._filteredFiles > 0) {
    parts.push('');
    parts.push(`已过滤 ${result._filteredFiles} 个不存在、越界或非 Markdown 日志的候选结果。`);
  }

  const meta = result?._meta;
  if (meta) {
    const fallbackText = meta.fellBack ? '（已从请求深度自动降级）' : '';
    const configParts = [
      `tree_depth=${meta.treeDepth}${fallbackText}`,
      `tree_size=${meta.treeSizeKB}KB`,
      `max_turns=${FAST_CONTEXT_MAX_TURNS}`,
      `max_results=${FAST_CONTEXT_MAX_RESULTS}`,
      `timeout_ms=${FAST_CONTEXT_TIMEOUT_MS}`
    ];
    if (FAST_CONTEXT_EXCLUDE_PATHS.length > 0) {
      configParts.push(`exclude_paths=[${FAST_CONTEXT_EXCLUDE_PATHS.join(', ')}]`);
    }

    parts.push('');
    parts.push(`[config] ${configParts.join(', ')}`);
  }

  return parts.join('\n');
}

/**
 * 格式化 fast-context 错误信息
 */
function formatFastContextError(result) {
  const meta = result?._meta ?? {};
  const parts = [`fast-context 搜索失败：${result.error}`];

  if (Object.keys(meta).length > 0) {
    parts.push('');
    const diagnosticParts = [
      `error_type=${meta.errorCode || 'unknown'}`,
      `tree_depth_used=${meta.treeDepth ?? FAST_CONTEXT_TREE_DEPTH}`,
      `tree_size=${meta.treeSizeKB ?? 'unknown'}KB`
    ];
    if (meta.fellBack) {
      diagnosticParts.push('fallback=true');
    }
    if (meta.contextTrimmed) {
      diagnosticParts.push('context_trimmed=true');
    }
    parts.push(`[diagnostic] ${diagnosticParts.join(', ')}`);
    if (meta.projectRoot) {
      parts.push(`[diagnostic] project_path=${meta.projectRoot}`);
    }
  }

  parts.push([
    `[config] max_turns=${FAST_CONTEXT_MAX_TURNS}`,
    `max_results=${FAST_CONTEXT_MAX_RESULTS}`,
    `max_commands=${FAST_CONTEXT_MAX_COMMANDS}`,
    `timeout_ms=${FAST_CONTEXT_TIMEOUT_MS}`
  ].join(', '));

  if (meta.errorCode === 'AUTH_ERROR') {
    parts.push(
      '[hint] 认证失败，请设置有效的 WINDSURF_API_KEY，' +
      '或确保本机 Windsurf/Devin 已登录以便自动发现凭据。'
    );
  } else if (meta.errorCode === 'RATE_LIMITED') {
    parts.push('[hint] fast-context 当前被限流，请稍后重试。');
  } else if (meta.errorCode === 'PAYLOAD_TOO_LARGE' || meta.errorCode === 'TIMEOUT') {
    parts.push(
      '[hint] 请求过大或超时，可降低 FC_TREE_DEPTH/FC_MAX_TURNS，' +
      '或通过 FC_EXCLUDE_PATHS 排除大目录。'
    );
  }

  return parts.join('\n');
}

/**
 * 格式化搜索结果中的行号范围
 */
function formatFastContextRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    return '';
  }
  return ranges
    .filter((range) => Array.isArray(range) && range.length >= 2)
    .map(([start, end]) => `L${start}-${end}`)
    .join(', ');
}

/**
 * 将搜索结果路径格式化为相对日志路径
 */
function formatLogSearchPath(filePath) {
  const rawPath = String(filePath ?? '').trim();
  if (!rawPath) {
    return '未知路径';
  }

  const absolutePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.join(LOG_DIR_PATH, rawPath);
  const relativePath = path.relative(ROOT_DIR, absolutePath);
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return absolutePath;
}

function normalizeAceBaseUrl(baseUrl) {
  let normalized = String(baseUrl ?? '').trim();
  if (!normalized) {
    throw new Error('ACE_BASE_URL 不能为空');
  }
  if (normalized.startsWith('http://')) {
    normalized = normalized.replace('http://', 'https://');
  } else if (!normalized.startsWith('https://')) {
    normalized = `https://${normalized}`;
  }
  return normalized.replace(/\/+$/, '');
}

function getAceSessionId() {
  if (!aceSessionId) {
    aceSessionId = randomUUID();
  }
  return aceSessionId;
}

/**
 * 收集日志文件并拆分为 blobs
 */
async function collectLogBlobs() {
  let entries = [];

  try {
    entries = await fs.readdir(LOG_DIR_PATH, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const blobs = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const filePath = path.join(LOG_DIR_PATH, entry.name);
    try {
      const rawContent = await fs.readFile(filePath, 'utf8');
      const content = sanitizeAceContent(rawContent);
      const chunks = splitLogContent(entry.name, content);
      blobs.push(...chunks);
    } catch {
      // 忽略读取错误
    }
  }

  return blobs;
}

function sanitizeAceContent(content) {
  return String(content ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function splitLogContent(fileName, content) {
  const lines = String(content ?? '').split('\n');
  const maxLines = ACE_MAX_LINES_PER_BLOB;
  if (lines.length <= maxLines) {
    return [{ path: fileName, content }];
  }

  const chunks = [];
  const totalChunks = Math.ceil(lines.length / maxLines);
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * maxLines;
    const end = Math.min(start + maxLines, lines.length);
    const chunkContent = lines.slice(start, end).join('\n');
    const chunkPath = `${fileName}#chunk${i + 1}of${totalChunks}`;
    chunks.push({ path: chunkPath, content: chunkContent });
  }
  return chunks;
}

function buildBlobBatches(blobs) {
  const batches = [];
  let current = [];
  let currentSize = 0;

  for (const blob of blobs) {
    const blobSize = String(blob.content ?? '').length + String(blob.path ?? '').length;
    if (current.length > 0 && currentSize + blobSize > ACE_MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(blob);
    currentSize += blobSize;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * 上传 blobs 到 ACE API，返回 blob_names
 */
async function uploadBlobs(baseUrl, blobs) {
  if (blobs.length === 0) {
    return [];
  }

  const uploadEndpoint = `${baseUrl}/batch-upload`;
  const batches = buildBlobBatches(blobs);
  const blobNames = [];

  for (const batch of batches) {
    const response = await postAceJson(uploadEndpoint, { blobs: batch }, ACE_REQUEST_TIMEOUT_MS);
    const result = await safeReadJson(response);
    if (!Array.isArray(result?.blob_names) || result.blob_names.length === 0) {
      throw new Error('ACE 返回的 blob_names 为空，无法继续搜索');
    }
    blobNames.push(...result.blob_names);
  }

  return blobNames;
}

async function postAceJson(url, body, timeoutMs) {
  const payload = JSON.stringify(body);
  const baseHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${ACE_API_KEY}`,
    'User-Agent': ACE_USER_AGENT,
    'x-request-session-id': getAceSessionId()
  };

  return await fetchWithRetry(url, {
    method: 'POST',
    headers: baseHeaders,
    body: payload
  }, timeoutMs);
}

async function fetchWithRetry(url, options, timeoutMs) {
  let lastError;

  for (let attempt = 0; attempt < ACE_RETRY_LIMIT; attempt += 1) {
    const headers = {
      ...options.headers,
      'x-request-id': randomUUID()
    };

    try {
      const response = await fetchWithTimeout(url, { ...options, headers }, timeoutMs);
      if (response.ok) {
        return response;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < ACE_RETRY_LIMIT - 1) {
        const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : ACE_RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      const errorText = await response.text();
      throw new Error(`ACE API 请求失败 (${response.status}): ${errorText}`);
    } catch (error) {
      lastError = error;
      const isAbort = error?.name === 'AbortError';
      const isNetwork = String(error?.message || '').includes('fetch');
      if ((isAbort || isNetwork) && attempt < ACE_RETRY_LIMIT - 1) {
        await sleep(ACE_RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('ACE API 请求失败');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

使用自然语言搜索历史日志记录。此工具支持 ACE 或 fast-context 语义搜索。

## 使用场景
- 当你需要查找之前做过的相关任务
- 当你想了解某个功能的实现历史
- 当你需要回顾之前的解决方案
- **强烈建议在开始新任务前先搜索历史记录，避免重复工作**

## 查询示例
- "查找关于数据库连接的日志"
- "之前做过哪些 API 相关的任务？"
- "修复登录 bug 的记录"
- "用户认证功能的实现过程"

## 返回格式
返回格式化搜索结果，包含文件路径和相关代码片段。`,
      inputSchema: {
        query: z.string().min(1).describe('自然语言搜索查询')
      },
      outputSchema: {
        query: z.string(),
        results: z.any(),
        logDir: z.string(),
        provider: z.string()
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
