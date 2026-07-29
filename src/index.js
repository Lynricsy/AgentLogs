#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';

// ============================================================================
// 常量与配置
// ============================================================================

const DEFAULT_STORAGE_DIR = '.agent-logs';
const LEGACY_STORAGE_DIR = 'AgentLogs';
const MEMORY_TYPES = [
  'decision', 'rationale', 'learning', 'error', 'verification',
  'config', 'artifact', 'event', 'context', 'action',
];
const RELATION_TYPES = ['supersedes', 'corrects', 'follows_up', 'validates', 'releases'];
const META_START = '<!-- agentlogs-meta:v1';
const META_END = '-->';
const INDEX_SCHEMA_VERSION = '1';
const MAX_CHUNK_CHARS = 1800;
const CHUNK_OVERLAP_CHARS = 200;
const QUERY_VECTOR_CACHE_LIMIT = 256;
const STOPWORDS_ZH = new Set(['的', '了', '和', '是', '在', '对', '与', '及', '把', '将', '中', '呢', '吗', '什么', '怎么', '如何', '是否']);
const STOPWORDS_EN = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'who', 'with',
]);
const ROLE_RULES = [
  ['error', /根因|问题|错误|故障|失败/],
  ['decision', /决定|决策|选择|方案/],
  ['rationale', /为什么|原因|依据|机制/],
  ['verification', /验证|测试|证据|检查/],
  ['config', /配置|环境变量|参数/],
  ['artifact', /文件|路径|提交|发布|版本/],
  ['learning', /结论|总结|经验|收获|发现/],
  ['action', /已做|修改|修复|操作|实现/],
  ['context', /目标|任务|背景|现状/],
];
const QUERY_ROLE_RULES = [
  ['action', /做了什么|如何实现|implemented|\bfix\b/i],
  ['decision', /\bdecision\b/i],
  ['rationale', /\bwhy\b|\breason\b/i],
  ['learning', /\blearned\b|\bconclusion\b/i],
  ['error', /\berror\b|\bbug\b|\bfailure\b/i],
  ['verification', /\bverify\b|\btest\b/i],
  ['config', /\bconfig\b|\benvironment\b/i],
  ['artifact', /\bfile\b|\bpath\b|\brelease\b|\bversion\b/i],
  ['event', /事件|事故|发生|\bevent\b|\bincident\b/i],
  ['context', /\bgoal\b|\bcontext\b/i],
];
const RELATION_PRIORITY = new Map([
  ['corrects', 0], ['supersedes', 0], ['validates', 1], ['releases', 2], ['follows_up', 3],
]);
const CONFIG_WARNINGS = [];
const queryVectorCache = new Map();
let sqlModulePromise;

function getBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const valid = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(max, Math.max(min, valid));
}

function normalizeOptional(value) {
  const normalized = String(value ?? '').trim();
  return normalized || '';
}

function parseEndpoint(rawUrl, { appendEmbeddings = false, label }) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议无效');
    if (appendEmbeddings) {
      const pathname = url.pathname.replace(/\/+$/, '');
      const lastSegment = pathname.split('/').filter(Boolean).at(-1);
      url.pathname = lastSegment === 'embeddings' ? pathname : `${pathname}/embeddings`;
    }
    return url;
  } catch {
    CONFIG_WARNINGS.push(`${label} URL 无效，已关闭该能力`);
    return null;
  }
}

function buildRemoteConfig() {
  const embeddingUrlRaw = normalizeOptional(process.env.AGENT_LOG_EMBEDDING_API_URL);
  const embeddingModel = normalizeOptional(process.env.AGENT_LOG_EMBEDDING_MODEL);
  if (Boolean(embeddingUrlRaw) !== Boolean(embeddingModel)) {
    CONFIG_WARNINGS.push('embedding 配置不完整，已关闭语义索引');
  }
  const embeddingUrl = embeddingUrlRaw && embeddingModel
    ? parseEndpoint(embeddingUrlRaw, { appendEmbeddings: true, label: 'embedding' })
    : null;

  const rerankerUrlRaw = normalizeOptional(process.env.AGENT_LOG_RERANK_API_URL);
  const rerankerModel = normalizeOptional(process.env.AGENT_LOG_RERANK_MODEL);
  if (Boolean(rerankerUrlRaw) !== Boolean(rerankerModel)) {
    CONFIG_WARNINGS.push('reranker 配置不完整，已关闭模型重排');
  }
  const rerankerUrl = rerankerUrlRaw && rerankerModel
    ? parseEndpoint(rerankerUrlRaw, { appendEmbeddings: false, label: 'reranker' })
    : null;

  return {
    embedding: embeddingUrl ? {
      url: embeddingUrl,
      key: normalizeOptional(process.env.AGENT_LOG_EMBEDDING_API_KEY),
      model: embeddingModel,
      timeoutMs: getBoundedInt(process.env.AGENT_LOG_EMBEDDING_TIMEOUT_MS, 30_000, 1_000, 300_000),
      batchSize: getBoundedInt(process.env.AGENT_LOG_EMBEDDING_BATCH_SIZE, 32, 1, 128),
      modelKey: sha256(`${embeddingUrl.toString()}\0${embeddingModel}`),
    } : null,
    reranker: rerankerUrl ? {
      url: rerankerUrl,
      key: normalizeOptional(process.env.AGENT_LOG_RERANK_API_KEY),
      model: rerankerModel,
      timeoutMs: getBoundedInt(process.env.AGENT_LOG_RERANK_TIMEOUT_MS, 10_000, 1_000, 60_000),
    } : null,
    maxResults: getBoundedInt(process.env.AGENT_LOG_SEARCH_MAX_RESULTS, 5, 1, 20),
  };
}

// ============================================================================
// 项目本地存储
// ============================================================================

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** @internal 解析并验证项目内存储布局。 */
export async function resolveStorageLayout(rootDir, configuredDir) {
  const projectRoot = await fs.realpath(rootDir);
  const raw = String(configuredDir ?? '').trim();
  const usesDefaultLayout = !raw || raw === DEFAULT_STORAGE_DIR || raw === LEGACY_STORAGE_DIR;
  const value = usesDefaultLayout ? DEFAULT_STORAGE_DIR : raw;
  if (path.isAbsolute(value) || value === '.') {
    throw new Error('存储目录必须位于当前项目目录内');
  }
  const storageDirPath = path.resolve(projectRoot, value);
  if (!isInsideRoot(projectRoot, storageDirPath)) {
    throw new Error('存储目录必须位于当前项目目录内');
  }

  const components = path.relative(projectRoot, storageDirPath).split(path.sep).filter(Boolean);
  let current = projectRoot;
  for (const component of components) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('存储目录必须位于当前项目目录内');
      const real = await fs.realpath(current);
      if (!isInsideRoot(projectRoot, real)) throw new Error('存储目录必须位于当前项目目录内');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }

  return {
    projectRoot,
    storageDirName: path.relative(projectRoot, storageDirPath).split(path.sep).join('/'),
    storageDirPath,
    usesDefaultLayout,
  };
}

const STORAGE_LAYOUT = await resolveStorageLayout(process.cwd(), process.env.AGENT_LOG_DIR);
const ROOT_DIR = STORAGE_LAYOUT.projectRoot;
const STORAGE_DIR_NAME = STORAGE_LAYOUT.storageDirName;
const STORAGE_DIR_PATH = STORAGE_LAYOUT.storageDirPath;
const GITIGNORE_PATH = path.join(ROOT_DIR, '.gitignore');
const INDEX_PATH = path.join(STORAGE_DIR_PATH, 'index.sqlite');
const LOCK_PATH = path.join(STORAGE_DIR_PATH, 'index.lock');
const REMOTE_CONFIG = buildRemoteConfig();

async function inspectStoragePath(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`存储路径必须是项目内普通目录: ${target}`);
    }
    return 'directory';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function prepareDefaultStorage() {
  const legacyPath = path.join(ROOT_DIR, LEGACY_STORAGE_DIR);
  let currentState = await inspectStoragePath(STORAGE_DIR_PATH);
  let legacyState = await inspectStoragePath(legacyPath);
  if (currentState === 'directory' && legacyState === 'directory') {
    throw new Error('同时检测到 .agent-logs 与旧 AgentLogs，无法自动合并，请先手动保留一个目录');
  }
  if (currentState === 'missing' && legacyState === 'directory') {
    try {
      await fs.rename(legacyPath, STORAGE_DIR_PATH);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      currentState = await inspectStoragePath(STORAGE_DIR_PATH);
      legacyState = await inspectStoragePath(legacyPath);
      if (currentState !== 'directory' || legacyState !== 'missing') throw error;
    }
    return;
  }
  if (currentState === 'missing' && legacyState === 'missing') {
    try {
      await fs.mkdir(STORAGE_DIR_PATH);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await inspectStoragePath(STORAGE_DIR_PATH) !== 'directory') throw error;
    }
  }
}

async function ensureStorageGitignoreEntry() {
  const entry = `${STORAGE_DIR_NAME.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;
  let existing = '';
  try {
    existing = await fs.readFile(GITIGNORE_PATH, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(entry) || lines.includes(entry.slice(0, -1))) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(GITIGNORE_PATH, `${existing}${prefix}${entry}\n`, 'utf8');
}

async function prepareProjectStorage() {
  if (STORAGE_LAYOUT.usesDefaultLayout) {
    await prepareDefaultStorage();
  } else {
    await fs.mkdir(STORAGE_DIR_PATH, { recursive: true });
    if (await inspectStoragePath(STORAGE_DIR_PATH) !== 'directory') {
      throw new Error(`存储路径必须是项目内普通目录: ${STORAGE_DIR_PATH}`);
    }
  }
  await ensureStorageGitignoreEntry();
}

// ============================================================================
// Markdown 元数据与日志操作
// ============================================================================

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function uniqueInOrder(values) {
  return [...new Set(values)];
}

function normalizeStringArray(values, field, maxLength) {
  const normalized = [];
  for (const value of values ?? []) {
    const item = String(value).trim();
    if (!item || item.length > maxLength || /[\n\r\x00-\x1F]/.test(item)) {
      throw new Error(`${field} 包含无效值`);
    }
    if (!normalized.includes(item)) normalized.push(item);
  }
  return normalized;
}

function normalizeMetadata(metadata) {
  const created = new Date(metadata.createdAt);
  if (!Number.isFinite(created.getTime()) || created.getTime() === 0) throw new Error('createdAt 无效');
  const types = uniqueInOrder(metadata.types ?? []);
  if (types.some((type) => !MEMORY_TYPES.includes(type)) || types.length > 10) throw new Error('types 无效');
  const relations = [];
  for (const relation of metadata.relations ?? []) {
    if (!RELATION_TYPES.includes(relation?.type) || !/^\d{4}-[^/\\]+\.md$/.test(relation?.target ?? '')) {
      throw new Error('relations 无效');
    }
    const key = `${relation.type}\0${relation.target}`;
    if (!relations.some((entry) => `${entry.type}\0${entry.target}` === key)) {
      relations.push({ type: relation.type, target: relation.target });
    }
  }
  if (relations.length > 16) throw new Error('relations 无效');
  return {
    version: 1,
    createdAt: created.toISOString(),
    types,
    tags: normalizeStringArray(metadata.tags, 'tags', 64),
    artifacts: normalizeStringArray(metadata.artifacts, 'artifacts', 256),
    relations,
  };
}

function fallbackCreatedAt(stat) {
  const birth = stat?.birthtime instanceof Date ? stat.birthtime : new Date(stat?.birthtime ?? 0);
  const modified = stat?.mtime instanceof Date ? stat.mtime : new Date(stat?.mtime ?? Date.now());
  return Number.isFinite(birth.getTime()) && birth.getTime() !== 0 ? birth.toISOString() : modified.toISOString();
}

function buildLogContent(title, content, metadata) {
  const safeTitle = String(title ?? '').trim() || '未命名记录';
  const body = String(content ?? '').trimEnd();
  const json = JSON.stringify(normalizeMetadata(metadata)).replace(/--/g, '\\u002d\\u002d');
  const prefix = `# ${safeTitle}\n\n${META_START}\n${json}\n${META_END}`;
  return body ? `${prefix}\n\n${body}\n` : `${prefix}\n`;
}

/** @internal 解析一份 Agent 日志且保留原始物理行映射。 */
export function parseAgentLog(content, fileName, stat) {
  const rawContent = String(content ?? '');
  const lines = rawContent.split('\n');
  const titleMatch = lines[0]?.match(/^#\s+(.+)\s*$/);
  const parsedName = parseLogFileName(fileName);
  const title = titleMatch?.[1]?.trim() || parsedName?.title || '未知标题';
  const warnings = [];
  let metadata = {
    version: 1,
    createdAt: fallbackCreatedAt(stat),
    types: [],
    tags: [],
    artifacts: [],
    relations: [],
  };
  let metadataLineRange = null;
  if (titleMatch) {
    let cursor = 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    if (lines[cursor]?.trim() === META_START) {
      const end = lines.indexOf(META_END, cursor + 1);
      if (end > cursor) {
        try {
          const parsed = JSON.parse(lines.slice(cursor + 1, end).join('\n'));
          if (parsed?.version !== 1) throw new Error('version 无效');
          metadata = normalizeMetadata(parsed);
          metadataLineRange = [cursor + 1, end + 1];
        } catch (error) {
          warnings.push(`日志 ${fileName} 的 metadata v1 无效：${error.message}`);
        }
      } else {
        warnings.push(`日志 ${fileName} 的 metadata v1 无效：缺少结束标记`);
      }
    }
  }
  return {
    fileName,
    title,
    content: rawContent,
    lines,
    metadata,
    explicitMetadata: metadataLineRange !== null,
    metadataLineRange,
    warnings,
  };
}

function sanitizeTitle(rawTitle) {
  const cleaned = String(rawTitle ?? '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/^-+/g, '');
  return !cleaned || cleaned === '.' || cleaned === '..' ? 'untitled' : cleaned;
}

function parseLogFileName(fileName) {
  const match = String(fileName).match(/^(\d{4})-(.*)\.md$/);
  return match ? { number: Number.parseInt(match[1], 10), title: match[2].replace(/-/g, ' ') } : null;
}

async function listLogFiles() {
  const entries = await fs.readdir(STORAGE_DIR_PATH, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && parseLogFileName(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => parseLogFileName(a).number - parseLogFileName(b).number || a.localeCompare(b));
}

async function getNextLogNumber() {
  const files = await listLogFiles();
  const maxNumber = files.reduce((max, name) => Math.max(max, parseLogFileName(name).number), 0);
  if (maxNumber >= 9999) throw new Error('日志编号已达到上限 9999');
  return maxNumber + 1;
}

async function validateRelations(relations) {
  for (const relation of relations) {
    const targetPath = path.join(STORAGE_DIR_PATH, relation.target);
    try {
      const stat = await fs.lstat(targetPath);
      const real = await fs.realpath(targetPath);
      if (stat.isSymbolicLink() || !stat.isFile() || path.dirname(real) !== STORAGE_DIR_PATH || !real.endsWith('.md')) {
        throw new Error('不是存储目录内普通 Markdown 文件');
      }
    } catch (error) {
      throw new Error(`关系目标无效 ${relation.target}：${error.message}`);
    }
  }
}

async function recordAgentLog({ title, content, types = [], tags = [], artifacts = [], relations = [] }) {
  const trimmedTitle = String(title ?? '').trim();
  if (!trimmedTitle) throw new Error('title 不能为空');
  const metadata = normalizeMetadata({
    version: 1,
    createdAt: new Date().toISOString(),
    types,
    tags,
    artifacts,
    relations,
  });
  await validateRelations(metadata.relations);
  const nextNumber = await getNextLogNumber();
  const fileName = `${String(nextNumber).padStart(4, '0')}-${sanitizeTitle(trimmedTitle)}.md`;
  const filePath = path.join(STORAGE_DIR_PATH, fileName);
  await fs.writeFile(filePath, buildLogContent(trimmedTitle, content, metadata), { encoding: 'utf8', flag: 'wx' });
  return { filePath, fileName, number: nextNumber, logDir: STORAGE_DIR_NAME, metadata };
}

async function readParsedLog(fileName) {
  const filePath = path.join(STORAGE_DIR_PATH, fileName);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`日志文件不是普通文件: ${fileName}`);
  const content = await fs.readFile(filePath, 'utf8');
  return parseAgentLog(content, fileName, stat);
}

async function listLogs() {
  const files = await listLogFiles();
  const logs = [];
  for (const fileName of files) {
    const document = await readParsedLog(fileName);
    logs.push({
      number: parseLogFileName(fileName).number,
      fileName,
      title: document.title,
      createdAt: document.metadata.createdAt,
      metadata: document.metadata,
    });
  }
  return { logs, total: logs.length, logDir: STORAGE_DIR_NAME };
}

async function readLog({ identifier }) {
  if (identifier === undefined || identifier === null || identifier === '') throw new Error('identifier 不能为空');
  const files = await listLogFiles();
  let fileName;
  if (typeof identifier === 'number' || /^\d+$/.test(String(identifier))) {
    const number = Number.parseInt(String(identifier), 10);
    const prefix = `${String(number).padStart(4, '0')}-`;
    fileName = files.find((name) => name.startsWith(prefix));
    if (!fileName) throw new Error(`未找到编号为 ${number} 的日志`);
  } else {
    fileName = String(identifier);
    if (!parseLogFileName(fileName)) throw new Error(`无效的日志文件名: ${fileName}`);
  }
  const document = await readParsedLog(fileName);
  return {
    number: parseLogFileName(fileName).number,
    fileName,
    title: document.title,
    content: document.content,
    createdAt: document.metadata.createdAt,
    metadata: document.metadata,
  };
}

// ============================================================================
// Markdown 分块与中文分词
// ============================================================================

function inferSectionRole(section) {
  const normalized = String(section ?? '').normalize('NFKC').toLowerCase();
  return ROLE_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'other';
}

function makeTextWindows(text, lineNumber) {
  if (text.length <= MAX_CHUNK_CHARS) return [{ content: text, startLine: lineNumber, endLine: lineNumber }];
  const windows = [];
  const step = MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS;
  for (let offset = 0; offset < text.length; offset += step) {
    windows.push({ content: text.slice(offset, offset + MAX_CHUNK_CHARS), startLine: lineNumber, endLine: lineNumber });
    if (offset + MAX_CHUNK_CHARS >= text.length) break;
  }
  return windows;
}

function splitOversizeBlock(block) {
  if (block.content.length <= MAX_CHUNK_CHARS) return [block];
  const rawLines = block.content.split('\n');
  const output = [];
  let current = [];
  let currentLength = 0;
  let currentStart = block.startLine;
  const flush = (endLine) => {
    if (!current.length) return;
    output.push({ ...block, content: current.join('\n'), startLine: currentStart, endLine });
    current = [];
    currentLength = 0;
  };
  rawLines.forEach((line, index) => {
    const lineNumber = block.startLine + index;
    if (line.length > MAX_CHUNK_CHARS) {
      flush(lineNumber - 1);
      output.push(...makeTextWindows(line, lineNumber).map((item) => ({ ...block, ...item })));
      currentStart = lineNumber + 1;
      return;
    }
    const addition = line.length + (current.length ? 1 : 0);
    if (current.length && currentLength + addition > MAX_CHUNK_CHARS) {
      flush(lineNumber - 1);
      currentStart = lineNumber;
    }
    current.push(line);
    currentLength += line.length + (current.length > 1 ? 1 : 0);
  });
  flush(block.endLine);
  return output;
}

/** @internal 按 Markdown 结构和物理行分块。 */
export function splitLogIntoChunks(document) {
  const blocks = [];
  const headingStack = [];
  let paragraph = [];
  let paragraphStart = 0;
  let fence = null;
  const excluded = document.metadataLineRange;
  const sectionPath = () => headingStack.map((entry) => entry.text).join(' > ');
  const flushParagraph = (endLine) => {
    if (!paragraph.length) return;
    const content = paragraph.join('\n');
    blocks.push({
      content,
      sectionPath: sectionPath(),
      sectionRole: inferSectionRole(sectionPath()),
      startLine: paragraphStart,
      endLine,
    });
    paragraph = [];
  };

  for (let index = 0; index < document.lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = document.lines[index];
    if (excluded && lineNumber >= excluded[0] && lineNumber <= excluded[1]) continue;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = null;
    }
    if (!fence) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph(lineNumber - 1);
        const level = heading[1].length;
        if (level === 1) continue;
        while (headingStack.length && headingStack.at(-1).level >= level) headingStack.pop();
        headingStack.push({ level, text: heading[2].trim() });
        blocks.push({
          content: line,
          sectionPath: sectionPath(),
          sectionRole: inferSectionRole(heading[2]),
          startLine: lineNumber,
          endLine: lineNumber,
        });
        continue;
      }
      if (!line.trim()) {
        flushParagraph(lineNumber - 1);
        continue;
      }
    }
    if (!paragraph.length) paragraphStart = lineNumber;
    paragraph.push(line);
  }
  flushParagraph(document.lines.length);

  const splitBlocks = blocks.flatMap(splitOversizeBlock);
  const packed = [];
  for (const block of splitBlocks) {
    const previous = packed.at(-1);
    const addition = previous ? `\n\n${block.content}` : block.content;
    if (previous && previous.sectionPath === block.sectionPath && previous.content.length + addition.length <= MAX_CHUNK_CHARS) {
      previous.content += `\n\n${block.content}`;
      previous.endLine = block.endLine;
    } else {
      packed.push({ ...block });
    }
  }
  if (!packed.length && document.lines[0]?.match(/^#\s+/)) {
    packed.push({
      content: document.lines[0],
      sectionPath: '',
      sectionRole: inferSectionRole(document.title),
      startLine: 1,
      endLine: 1,
    });
  }
  return packed;
}


function isTechnicalAscii(raw) {
  return /\d/.test(raw) || /[_\-.:\/@#]/.test(raw) || (raw.length >= 2 && raw === raw.toUpperCase() && /[A-Z]/.test(raw));
}

/** @internal 对文档与查询执行确定性中文和技术词分词。 */
export function tokenizeSearchText(text, { query = false } = {}) {
  const normalized = String(text ?? '').normalize('NFKC');
  const tokens = [];
  const technicalTerms = new Set();
  for (const match of normalized.matchAll(/[A-Za-z0-9_./:@#-]+/g)) {
    const raw = match[0];
    const lower = raw.toLowerCase();
    const technical = isTechnicalAscii(raw);
    if (technical || !STOPWORDS_EN.has(lower)) tokens.push(lower);
    if (technical) technicalTerms.add(lower);
    if (technical) {
      for (const component of lower.split(/[_\-/]+/).filter(Boolean)) {
        if (component !== lower && !STOPWORDS_EN.has(component)) tokens.push(component);
      }
    }
  }

  const cjkRuns = [...normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)]
    .map((match) => match[0]);
  let segmented = false;
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const run of cjkRuns) {
      for (const segment of segmenter.segment(run)) {
        const value = segment.segment.trim();
        if (value && !STOPWORDS_ZH.has(value)) tokens.push(value);
      }
    }
    segmented = true;
  }
  for (const run of cjkRuns) {
    if (!segmented && !STOPWORDS_ZH.has(run)) tokens.push(run);
    const chars = [...run];
    for (let index = 0; index < chars.length - 1; index += 1) tokens.push(`g2:${chars[index]}${chars[index + 1]}`);
    if (!query || chars.length === 1) {
      for (const char of chars) if (!STOPWORDS_ZH.has(char)) tokens.push(`g1:${char}`);
    }
  }
  const filtered = tokens.filter((token) => token && (!STOPWORDS_EN.has(token) || technicalTerms.has(token) || isTechnicalAscii(token)));
  Object.defineProperty(filtered, 'technicalTerms', { value: technicalTerms });
  return filtered;
}

function queryTermWeight(term, technicalTerms) {
  if (term.startsWith('g2:')) return 0.6;
  if (term.startsWith('g1:')) return 0.15;
  if (technicalTerms?.has(term) || isTechnicalAscii(term)) return 1.4;
  return 1;
}

function normalizedSearchText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** @internal 以固定公式计算 BM25 候选。 */
export function scoreBm25Candidates(index, queryTerms, normalizedQuery) {
  const terms = uniqueInOrder(queryTerms);
  const totalChunks = index.totalChunks || index.chunks.length;
  const average = index.avgTokenCount || 1;
  const results = [];
  for (const chunk of index.chunks) {
    let score = 0;
    for (const term of terms) {
      const tf = chunk.termCounts?.get(term) ?? 0;
      if (!tf) continue;
      const df = index.termStats.get(term) ?? 0;
      const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5));
      const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * chunk.tokenCount / average);
      score += queryTermWeight(term, queryTerms.technicalTerms) * idf * (tf * 2.2 / denominator);
    }
    if (normalizedQuery.length >= 2 && normalizedSearchText(chunk.searchText).includes(normalizedQuery)) score += 2;
    if (score > 0) results.push({ id: chunk.id, score });
  }
  return results.sort((a, b) => b.score - a.score
    || index.byId.get(a.id).documentPath.localeCompare(index.byId.get(b.id).documentPath)
    || index.byId.get(a.id).startLine - index.byId.get(b.id).startLine).slice(0, 50);
}

// ============================================================================
// SQLite 派生索引
// ============================================================================

async function getSqlModule() {
  if (!sqlModulePromise) {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    sqlModulePromise = initSqlJs({ locateFile: () => wasmPath });
  }
  return await sqlModulePromise;
}

function initializeSchema(db) {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(
      path TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, explicit_types_json TEXT NOT NULL, tags_json TEXT NOT NULL,
      artifacts_json TEXT NOT NULL, warnings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks(
      id TEXT PRIMARY KEY, document_path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE,
      section_path TEXT NOT NULL, section_role TEXT NOT NULL, start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL,
      content_hash TEXT NOT NULL, token_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunk_terms(
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, term TEXT NOT NULL,
      tf INTEGER NOT NULL, PRIMARY KEY(chunk_id, term)
    );
    CREATE TABLE IF NOT EXISTS term_stats(term TEXT PRIMARY KEY, doc_freq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS embeddings(
      chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, model_key TEXT NOT NULL,
      model TEXT NOT NULL, dimensions INTEGER NOT NULL, content_hash TEXT NOT NULL,
      vector BLOB NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(chunk_id, model_key)
    );
    CREATE TABLE IF NOT EXISTS relations(
      source_path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE, type TEXT NOT NULL,
      target_path TEXT NOT NULL, PRIMARY KEY(source_path, type, target_path)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_path);
    CREATE INDEX IF NOT EXISTS idx_chunk_terms_term ON chunk_terms(term);
    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_key);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_path);
  `);
  db.run('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)', ['schema_version', INDEX_SCHEMA_VERSION]);
}

function queryRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

async function readIndexBytes() {
  try {
    return new Uint8Array(await fs.readFile(INDEX_PATH));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function openCurrentDatabase(warnings, { recover = false } = {}) {
  const SQL = await getSqlModule();
  const bytes = await readIndexBytes();
  if (!bytes) {
    const db = new SQL.Database();
    initializeSchema(db);
    return db;
  }
  try {
    const db = new SQL.Database(bytes);
    const version = queryRows(db, "SELECT value FROM index_meta WHERE key='schema_version'")[0]?.value;
    if (version !== INDEX_SCHEMA_VERSION) {
      db.close();
      throw new Error(`schema version ${version ?? '缺失'} 无效`);
    }
    db.run('PRAGMA foreign_keys = ON');
    return db;
  } catch (error) {
    if (!recover) throw error;
    const corruptPath = path.join(STORAGE_DIR_PATH, `index.corrupt-${Date.now()}.sqlite`);
    await fs.rename(INDEX_PATH, corruptPath).catch(async (renameError) => {
      if (renameError?.code !== 'ENOENT') throw renameError;
    });
    warnings.push(`派生索引损坏，已保留为 ${path.basename(corruptPath)} 并重建`);
    const db = new SQL.Database();
    initializeSchema(db);
    return db;
  }
}

async function acquireIndexLock() {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    try {
      const handle = await fs.open(LOCK_PATH, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > 5 * 60_000) {
          await fs.unlink(LOCK_PATH);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      await sleep(50);
    }
  }
  return null;
}

async function releaseIndexLock(handle) {
  await handle?.close().catch(() => {});
  await fs.unlink(LOCK_PATH).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function persistDatabase(db, warnings) {
  const temporaryPath = path.join(STORAGE_DIR_PATH, `index.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, db.export());
    try {
      await fs.rename(temporaryPath, INDEX_PATH);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      await fs.rm(INDEX_PATH, { force: true });
      await fs.rename(temporaryPath, INDEX_PATH);
    }
    return true;
  } catch (error) {
    warnings.push(`派生索引持久化失败，已使用内存索引：${error?.code || error?.name || '未知错误'}`);
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    return false;
  }
}

function embeddingText(searchText) {
  if (searchText.length <= 4096) return searchText;
  return `${searchText.slice(0, 2045)}\n[…]\n${searchText.slice(-2046)}`;
}

async function loadSourceDocuments() {
  const documents = [];
  for (const fileName of await listLogFiles()) {
    const filePath = path.join(STORAGE_DIR_PATH, fileName);
    const bytes = await fs.readFile(filePath);
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`日志文件不是普通文件: ${fileName}`);
    const parsed = parseAgentLog(bytes.toString('utf8'), fileName, stat);
    const number = parseLogFileName(fileName).number;
    const chunks = splitLogIntoChunks(parsed).map((chunk) => {
      const metadataParts = [
        parsed.title,
        chunk.sectionPath,
        ...parsed.metadata.types,
        ...parsed.metadata.tags,
        ...parsed.metadata.artifacts,
        chunk.content,
      ].filter(Boolean);
      const searchText = metadataParts.join('\n');
      const contentHash = sha256(searchText);
      const id = sha256(`${fileName}\0${chunk.sectionPath}\0${chunk.startLine}\0${chunk.endLine}\0${contentHash}`);
      const tokens = tokenizeSearchText(searchText);
      const termCounts = new Map();
      for (const token of tokens) termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
      return { ...chunk, id, searchText, contentHash, tokenCount: tokens.length, termCounts };
    });
    documents.push({ parsed, fileName, number, contentHash: sha256(bytes), chunks });
  }
  return documents;
}

function collectExistingEmbeddings(db) {
  const rows = queryRows(db, 'SELECT chunk_id, model_key, model, dimensions, content_hash, vector, created_at FROM embeddings');
  return new Map(rows.map((row) => [`${row.chunk_id}\0${row.model_key}`, row]));
}

function buildDatabaseFromDocuments(SQL, documents, existingEmbeddings, warnings) {
  const db = new SQL.Database();
  initializeSchema(db);
  db.run('BEGIN');
  try {
    const documentStatement = db.prepare(`
      INSERT INTO documents(path, number, title, created_at, content_hash, explicit_types_json, tags_json, artifacts_json, warnings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const chunkStatement = db.prepare(`
      INSERT INTO chunks(id, document_path, section_path, section_role, start_line, end_line, content, search_text, content_hash, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const termStatement = db.prepare('INSERT INTO chunk_terms(chunk_id, term, tf) VALUES (?, ?, ?)');
    const relationStatement = db.prepare('INSERT INTO relations(source_path, type, target_path) VALUES (?, ?, ?)');
    const embeddingStatement = db.prepare(`
      INSERT INTO embeddings(chunk_id, model_key, model, dimensions, content_hash, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const knownFiles = new Set(documents.map((document) => document.fileName));
    const termDocuments = new Map();
    let totalTokens = 0;
    let totalChunks = 0;
    for (const document of documents) {
      const { parsed } = document;
      documentStatement.run([
        document.fileName, document.number, parsed.title, parsed.metadata.createdAt, document.contentHash,
        JSON.stringify(parsed.metadata.types), JSON.stringify(parsed.metadata.tags),
        JSON.stringify(parsed.metadata.artifacts), JSON.stringify(parsed.warnings),
      ]);
      for (const relation of parsed.metadata.relations) {
        if (knownFiles.has(relation.target)) relationStatement.run([document.fileName, relation.type, relation.target]);
        else warnings.push(`日志 ${document.fileName} 的关系目标不存在：${relation.target}`);
      }
      for (const chunk of document.chunks) {
        chunkStatement.run([
          chunk.id, document.fileName, chunk.sectionPath, chunk.sectionRole, chunk.startLine, chunk.endLine,
          chunk.content, chunk.searchText, chunk.contentHash, chunk.tokenCount,
        ]);
        totalTokens += chunk.tokenCount;
        totalChunks += 1;
        for (const [term, count] of chunk.termCounts) {
          termStatement.run([chunk.id, term, count]);
          if (!termDocuments.has(term)) termDocuments.set(term, new Set());
          termDocuments.get(term).add(chunk.id);
        }
        for (const row of existingEmbeddings.values()) {
          if (row.chunk_id === chunk.id && row.content_hash === chunk.contentHash) {
            embeddingStatement.run([
              row.chunk_id, row.model_key, row.model, row.dimensions, row.content_hash, row.vector, row.created_at,
            ]);
          }
        }
      }
    }
    for (const [term, chunkIds] of termDocuments) {
      db.run('INSERT INTO term_stats(term, doc_freq) VALUES (?, ?)', [term, chunkIds.size]);
    }
    db.run('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)', ['total_chunks', String(totalChunks)]);
    db.run('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)', [
      'avg_token_count', String(totalChunks ? totalTokens / totalChunks : 0),
    ]);
    documentStatement.free();
    chunkStatement.free();
    termStatement.free();
    relationStatement.free();
    embeddingStatement.free();
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

async function synchronizeIndex() {
  const warnings = [...CONFIG_WARNINGS];
  const documents = await loadSourceDocuments();
  const lock = await acquireIndexLock();
  const SQL = await getSqlModule();
  if (!lock) {
    warnings.push('索引锁等待超时，已从 Markdown 构建本次内存索引');
    return { db: buildDatabaseFromDocuments(SQL, documents, new Map(), warnings), warnings, persisted: false };
  }
  try {
    const oldDb = await openCurrentDatabase(warnings, { recover: true });
    const embeddings = collectExistingEmbeddings(oldDb);
    oldDb.close();
    const latestDocuments = await loadSourceDocuments();
    const db = buildDatabaseFromDocuments(SQL, latestDocuments, embeddings, warnings);
    await persistDatabase(db, warnings);
    return { db, warnings, persisted: true };
  } finally {
    await releaseIndexLock(lock);
  }
}

function databaseToIndex(db) {
  const documentRows = queryRows(db, 'SELECT * FROM documents');
  const documentMap = new Map(documentRows.map((row) => [row.path, {
    path: row.path,
    number: row.number,
    title: row.title,
    createdAt: row.created_at,
    types: JSON.parse(row.explicit_types_json),
    tags: JSON.parse(row.tags_json),
    artifacts: JSON.parse(row.artifacts_json),
    warnings: JSON.parse(row.warnings_json),
  }]));
  const chunks = queryRows(db, 'SELECT * FROM chunks').map((row) => ({
    id: row.id,
    documentPath: row.document_path,
    sectionPath: row.section_path,
    sectionRole: row.section_role,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    searchText: row.search_text,
    contentHash: row.content_hash,
    tokenCount: row.token_count,
    termCounts: new Map(),
  }));
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const row of queryRows(db, 'SELECT chunk_id, term, tf FROM chunk_terms')) {
    byId.get(row.chunk_id)?.termCounts.set(row.term, row.tf);
  }
  const termStats = new Map(queryRows(db, 'SELECT term, doc_freq FROM term_stats').map((row) => [row.term, row.doc_freq]));
  const meta = new Map(queryRows(db, 'SELECT key, value FROM index_meta').map((row) => [row.key, row.value]));
  return {
    chunks,
    byId,
    documents: documentMap,
    termStats,
    totalChunks: Number(meta.get('total_chunks') ?? chunks.length),
    avgTokenCount: Number(meta.get('avg_token_count') ?? 0),
    relations: queryRows(db, 'SELECT source_path, type, target_path FROM relations'),
  };
}

// ============================================================================
// 向量、融合与重排
// ============================================================================

/** @internal 编码 little-endian float32。 */
export function encodeFloat32Le(vector) {
  const buffer = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return new Uint8Array(buffer);
}

/** @internal 解码 little-endian float32。 */
export function decodeFloat32Le(bytes, dimensions) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (array.byteLength !== dimensions * 4) throw new Error('向量维度与字节长度不一致');
  const view = new DataView(array.buffer, array.byteOffset, array.byteLength);
  const output = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) output[index] = view.getFloat32(index * 4, true);
  return output;
}

function normalizeVector(vector, expectedDimensions = null) {
  if (!Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('向量必须为非空有限数值数组');
  }
  if (expectedDimensions !== null && vector.length !== expectedDimensions) throw new Error('向量维度漂移');
  let normSquared = 0;
  for (const value of vector) normSquared += value * value;
  if (!Number.isFinite(normSquared) || normSquared === 0) throw new Error('向量不能是零向量');
  const inverse = 1 / Math.sqrt(normSquared);
  return Float32Array.from(vector, (value) => value * inverse);
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

function safeRemoteWarning(label, url, reason, status = null) {
  const statusText = status === null ? '' : ` HTTP ${status}`;
  return `${label} ${url.host}${statusText}：${reason}`;
}

async function requestEmbeddings(inputs, config) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (config.key) headers.Authorization = `Bearer ${config.key}`;
      const response = await fetchWithTimeout(config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, input: inputs }),
      }, config.timeoutMs);
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await sleep(1_000 * (attempt + 1));
          continue;
        }
        throw Object.assign(new Error('请求失败'), { status: response.status });
      }
      const payload = await response.json();
      if (!Array.isArray(payload?.data) || payload.data.length !== inputs.length) throw new Error('响应 data 数量无效');
      const ordered = payload.data.some((item) => Number.isInteger(item?.index))
        ? [...payload.data].sort((a, b) => a.index - b.index)
        : payload.data;
      if (ordered.some((item, index) => Number.isInteger(item?.index) && item.index !== index)) {
        throw new Error('响应 index 无效');
      }
      let dimensions = null;
      return ordered.map((item) => {
        const normalized = normalizeVector(item?.embedding, dimensions);
        dimensions ??= normalized.length;
        return normalized;
      });
    } catch (error) {
      lastError = error;
      const retryable = !error?.status || error?.status === 429 || error?.status >= 500;
      if (retryable && attempt < 2) {
        await sleep(1_000 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function getCachedQueryVector(key) {
  const value = queryVectorCache.get(key);
  if (!value) return null;
  queryVectorCache.delete(key);
  queryVectorCache.set(key, value);
  return value;
}

function setCachedQueryVector(key, vector) {
  if (queryVectorCache.has(key)) queryVectorCache.delete(key);
  queryVectorCache.set(key, vector);
  if (queryVectorCache.size > QUERY_VECTOR_CACHE_LIMIT) queryVectorCache.delete(queryVectorCache.keys().next().value);
}

async function persistEmbeddingRows(rows, config, warnings) {
  if (!rows.length) return;
  const lock = await acquireIndexLock();
  if (!lock) {
    warnings.push('向量写入等待索引锁超时，本次向量仅在内存使用');
    return;
  }
  let db;
  try {
    db = await openCurrentDatabase(warnings, { recover: false });
    for (const row of rows) {
      const current = queryRows(db, 'SELECT content_hash FROM chunks WHERE id = ?', [row.chunkId])[0];
      if (!current || current.content_hash !== row.contentHash) continue;
      db.run(`
        INSERT OR REPLACE INTO embeddings(chunk_id, model_key, model, dimensions, content_hash, vector, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [row.chunkId, config.modelKey, config.model, row.vector.length, row.contentHash, encodeFloat32Le(row.vector), new Date().toISOString()]);
    }
    const expected = queryRows(db, 'SELECT COUNT(*) AS count FROM chunks')[0]?.count ?? 0;
    const current = queryRows(db, 'SELECT COUNT(*) AS count FROM embeddings WHERE model_key = ?', [config.modelKey])[0]?.count ?? 0;
    if (expected > 0 && current === expected) db.run('DELETE FROM embeddings WHERE model_key <> ?', [config.modelKey]);
    await persistDatabase(db, warnings);
  } catch (error) {
    warnings.push(`向量索引持久化失败：${error?.code || error?.name || '未知错误'}`);
  } finally {
    db?.close();
    await releaseIndexLock(lock);
  }
}

async function buildSemanticRanking(db, index, query, warnings) {
  const config = REMOTE_CONFIG.embedding;
  if (!config || !index.chunks.length) return { ranking: [], vectors: new Map(), embeddedChunks: 0, active: false };
  const cacheKey = `${config.modelKey}\0${query}`;
  let queryVector = getCachedQueryVector(cacheKey);
  if (!queryVector) {
    try {
      [queryVector] = await requestEmbeddings([query], config);
      setCachedQueryVector(cacheKey, queryVector);
    } catch (error) {
      warnings.push(safeRemoteWarning('embedding', config.url, `查询向量失败（${error?.name || '错误'}）`, error?.status));
      return { ranking: [], vectors: new Map(), embeddedChunks: 0, active: false };
    }
  }

  const storedRows = queryRows(db, `
    SELECT e.chunk_id, e.dimensions, e.vector, e.content_hash
    FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
    WHERE e.model_key = ? AND e.content_hash = c.content_hash
  `, [config.modelKey]);
  const vectors = new Map();
  for (const row of storedRows) {
    try {
      if (row.dimensions === queryVector.length) vectors.set(row.chunk_id, decodeFloat32Le(row.vector, row.dimensions));
    } catch {
      warnings.push(`chunk ${row.chunk_id} 的持久化向量无效，已重新计算`);
    }
  }
  const missing = index.chunks.filter((chunk) => !vectors.has(chunk.id));
  const generatedRows = [];
  for (let offset = 0; offset < missing.length; offset += config.batchSize) {
    const batch = missing.slice(offset, offset + config.batchSize);
    try {
      const batchVectors = await requestEmbeddings(batch.map((chunk) => embeddingText(chunk.searchText)), config);
      if (batchVectors.some((vector) => vector.length !== queryVector.length)) throw new Error('语料向量维度与查询向量不一致');
      batch.forEach((chunk, indexInBatch) => {
        vectors.set(chunk.id, batchVectors[indexInBatch]);
        generatedRows.push({ chunkId: chunk.id, contentHash: chunk.contentHash, vector: batchVectors[indexInBatch] });
      });
    } catch (error) {
      warnings.push(safeRemoteWarning('embedding', config.url, `语料向量失败（${error?.name || '错误'}）`, error?.status));
      break;
    }
  }
  await persistEmbeddingRows(generatedRows, config, warnings);

  const scores = [];
  for (const chunk of index.chunks) {
    const vector = vectors.get(chunk.id);
    if (!vector || vector.length !== queryVector.length) continue;
    let score = 0;
    for (let dimension = 0; dimension < vector.length; dimension += 1) score += queryVector[dimension] * vector[dimension];
    scores.push({ id: chunk.id, score });
  }
  scores.sort((a, b) => b.score - a.score
    || index.byId.get(a.id).documentPath.localeCompare(index.byId.get(b.id).documentPath)
    || index.byId.get(a.id).startLine - index.byId.get(b.id).startLine);
  return {
    ranking: scores.slice(0, 50),
    vectors,
    embeddedChunks: vectors.size,
    active: scores.length > 0,
  };
}

/** @internal 使用 RRF 融合有限排名列表。 */
export function fuseRankings(voices, { rrfK = 60 } = {}) {
  const scores = new Map();
  for (const voice of voices) {
    const items = voice.items ?? voice.ranking ?? [];
    items.forEach((item, index) => {
      const id = typeof item === 'string' ? item : item.id;
      scores.set(id, (scores.get(id) ?? 0) + (voice.weight ?? 1) / (rrfK + index + 1));
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** @internal 验证并规范化通用 Rerank 响应。 */
export function normalizeRerankResponse(payload, candidateCount) {
  const hasResults = Array.isArray(payload?.results);
  const hasData = Array.isArray(payload?.data);
  if (hasResults === hasData) throw new Error('Rerank 响应必须且只能包含 results 或 data 数组');
  const rows = hasResults ? payload.results : payload.data;
  if (rows.length !== candidateCount) throw new Error('Rerank 响应数量与候选数不一致');
  const seen = new Set();
  for (const row of rows) {
    if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= candidateCount || seen.has(row.index)) {
      throw new Error('Rerank index 无效');
    }
    if (!Number.isFinite(row.relevance_score)) throw new Error('Rerank relevance_score 无效');
    seen.add(row.index);
  }
  if (seen.size !== candidateCount) throw new Error('Rerank index 不完整');
  return [...rows]
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .map((row, rank) => ({ index: row.index, score: row.relevance_score, rank: rank + 1 }));
}

function tokenJaccard(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left);
  const rightSet = right instanceof Set ? right : new Set(right);
  if (!leftSet.size && !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function vectorCosine(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return dot;
}

/** @internal 用 MMR 选择多样结果并限制每个文档最多两个 chunk。 */
export function selectWithMmr(candidates, { limit, lambda = 0.75 }) {
  const selected = [];
  const remaining = [...candidates];
  const perDocument = new Map();
  while (selected.length < limit && remaining.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if ((perDocument.get(candidate.documentPath) ?? 0) >= 2) continue;
      let maxSimilarity = 0;
      for (const chosen of selected) {
        const cosine = vectorCosine(candidate.vector, chosen.vector);
        const similarity = cosine ?? tokenJaccard(candidate.tokens ?? [], chosen.tokens ?? []);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
      const mmr = lambda * candidate.relevance - (1 - lambda) * maxSimilarity;
      const currentBest = remaining[bestIndex];
      if (mmr > bestScore || (mmr === bestScore && (
        !currentBest || candidate.documentPath.localeCompare(currentBest.documentPath) < 0
        || (candidate.documentPath === currentBest.documentPath && candidate.startLine < currentBest.startLine)
      ))) {
        bestScore = mmr;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    perDocument.set(chosen.documentPath, (perDocument.get(chosen.documentPath) ?? 0) + 1);
  }
  return selected;
}

function inferQueryRoles(query) {
  const roles = new Set();
  const normalized = normalizedSearchText(query);
  for (const [role, pattern] of ROLE_RULES) if (pattern.test(normalized)) roles.add(role);
  for (const [role, pattern] of QUERY_ROLE_RULES) if (pattern.test(normalized)) roles.add(role);
  return roles;
}

function chooseRepresentative(documentPath, index, lexicalScores, queryRoles) {
  return index.chunks.filter((chunk) => chunk.documentPath === documentPath).sort((a, b) => {
    const scoreDifference = (lexicalScores.get(b.id) ?? 0) - (lexicalScores.get(a.id) ?? 0);
    if (scoreDifference) return scoreDifference;
    const roleDifference = Number(queryRoles.has(b.sectionRole)) - Number(queryRoles.has(a.sectionRole));
    return roleDifference || a.startLine - b.startLine;
  })[0];
}

function buildAuxiliaryRankings(index, query, lexicalRanking) {
  const roles = inferQueryRoles(query);
  const lexicalScores = new Map(lexicalRanking.map((entry) => [entry.id, entry.score]));
  const representatives = new Map();
  for (const documentPath of index.documents.keys()) {
    representatives.set(documentPath, chooseRepresentative(documentPath, index, lexicalScores, roles));
  }
  const typeRanking = roles.size ? index.chunks.filter((chunk) => {
    const document = index.documents.get(chunk.documentPath);
    return roles.has(chunk.sectionRole) || document.types.some((type) => roles.has(type));
  }).sort((a, b) => {
    const sectionDifference = Number(roles.has(b.sectionRole)) - Number(roles.has(a.sectionRole));
    if (sectionDifference) return sectionDifference;
    const explicitDifference = Number(index.documents.get(b.documentPath).types.some((type) => roles.has(type)))
      - Number(index.documents.get(a.documentPath).types.some((type) => roles.has(type)));
    return explicitDifference || a.documentPath.localeCompare(b.documentPath) || a.startLine - b.startLine;
  }).slice(0, 50).map((chunk) => ({ id: chunk.id })) : [];

  const normalized = normalizedSearchText(query);
  const temporalTriggered = /最近|最新|上次|今天|昨天|本周|本月|\brecent\b|\blatest\b|\blast\b|\btoday\b|\byesterday\b|\bthis week\b|\bthis month\b|\d{4}-\d{2}(?:-\d{2})?/.test(normalized);
  let temporalRanking = [];
  if (temporalTriggered) {
    const dateMatch = normalized.match(/\d{4}-\d{2}(?:-\d{2})?/);
    const target = dateMatch ? new Date(`${dateMatch[0]}${dateMatch[0].length === 7 ? '-01' : ''}T00:00:00Z`).getTime() : null;
    temporalRanking = [...index.documents.values()].sort((a, b) => target === null
      ? new Date(b.createdAt) - new Date(a.createdAt) || b.number - a.number || a.path.localeCompare(b.path)
      : Math.abs(new Date(a.createdAt) - target) - Math.abs(new Date(b.createdAt) - target) || a.path.localeCompare(b.path))
      .map((document) => representatives.get(document.path)).filter(Boolean).slice(0, 50).map((chunk) => ({ id: chunk.id }));
  }

  const seedDocuments = new Set([
    ...lexicalRanking.map((entry) => index.byId.get(entry.id)?.documentPath),
    ...typeRanking.map((entry) => index.byId.get(entry.id)?.documentPath),
    ...temporalRanking.map((entry) => index.byId.get(entry.id)?.documentPath),
  ].filter(Boolean));
  const relationRanking = index.relations
    .filter((relation) => seedDocuments.has(relation.target_path))
    .sort((a, b) => (RELATION_PRIORITY.get(a.type) ?? 99) - (RELATION_PRIORITY.get(b.type) ?? 99)
      || a.source_path.localeCompare(b.source_path))
    .map((relation) => representatives.get(relation.source_path)).filter(Boolean)
    .slice(0, 50).map((chunk) => ({ id: chunk.id }));
  return { roles, typeRanking, temporalRanking, relationRanking, representatives };
}

function buildRerankDocument(candidate, index) {
  const chunk = index.byId.get(candidate.id);
  const document = index.documents.get(chunk.documentPath);
  return [
    `文件: ${STORAGE_DIR_NAME}/${document.path}`,
    `标题: ${document.title}`,
    `章节: ${chunk.sectionPath || '（根）'}`,
    `创建时间: ${document.createdAt}`,
    `类型: ${document.types.join(', ') || '（无）'}`,
    `标签: ${document.tags.join(', ') || '（无）'}`,
    `工件: ${document.artifacts.join(', ') || '（无）'}`,
    `内容:\n${chunk.searchText}`,
  ].join('\n');
}

async function requestRerank(query, candidates, index, warnings) {
  const config = REMOTE_CONFIG.reranker;
  if (!config || candidates.length < 2) return null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (config.key) headers.Authorization = `Bearer ${config.key}`;
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        query,
        documents: candidates.map((candidate) => buildRerankDocument(candidate, index)),
      }),
    }, config.timeoutMs);
    if (!response.ok) throw Object.assign(new Error('请求失败'), { status: response.status });
    return normalizeRerankResponse(await response.json(), candidates.length);
  } catch (error) {
    warnings.push(safeRemoteWarning('reranker', config.url, `模型重排失败（${error?.name || '错误'}）`, error?.status));
    return null;
  }
}

function round4(value) {
  return value === null || value === undefined ? null : Math.round(value * 10_000) / 10_000;
}

function uniqueWarnings(warnings) {
  return uniqueInOrder(warnings.filter(Boolean));
}

function compressSnippet(content) {
  const compact = String(content).replace(/\s+/g, ' ').trim();
  return compact.length > 600 ? `${compact.slice(0, 600)}…` : compact;
}

function formatSearchResults(matches, diagnostics) {
  if (!matches.length) return '未找到相关日志。';
  const parts = [];
  matches.forEach((match, index) => {
    const signals = Object.entries(match.signals)
      .filter(([key, value]) => key.endsWith('Rank') && value !== null)
      .map(([key, value]) => `${key.replace('Rank', '')}#${value}`)
      .join(', ');
    parts.push(`[${index + 1}/${matches.length}] ${match.path} (L${match.startLine}-L${match.endLine})`);
    parts.push(`标题：${match.title}`);
    parts.push(`章节：${match.section || '（根）'}`);
    parts.push(`摘要：${match.snippet}`);
    parts.push(`信号：${signals || '无'}`);
    parts.push('');
  });
  const rerankerState = diagnostics.rerankerApplied
    ? 'applied'
    : REMOTE_CONFIG.reranker && diagnostics.rerankerAttempted ? 'fallback' : 'disabled';
  parts.push(`mode=${diagnostics.mode}, documents=${diagnostics.indexedDocuments}, chunks=${diagnostics.indexedChunks}, reranker=${rerankerState}`);
  for (const warning of diagnostics.warnings) parts.push(`警告：${warning}`);
  return parts.join('\n').trim();
}

async function searchLogs({ query }) {
  const normalizedQuery = String(query ?? '').trim();
  if (!normalizedQuery) throw new Error('query 不能为空');
  const synchronized = await synchronizeIndex();
  const { db } = synchronized;
  try {
    const index = databaseToIndex(db);
    synchronized.warnings.push(...[...index.documents.values()].flatMap((document) => document.warnings));
    if (!index.documents.size) {
      const diagnostics = {
        mode: 'lexical-only', indexedDocuments: 0, indexedChunks: 0, embeddedChunks: 0,
        embeddingModel: REMOTE_CONFIG.embedding?.model ?? null,
        rerankerModel: REMOTE_CONFIG.reranker?.model ?? null,
        rerankerApplied: false, rerankedCandidates: 0, rerankerAttempted: false,
        warnings: uniqueWarnings(synchronized.warnings),
      };
      return {
        query: normalizedQuery, results: '日志目录为空，没有可搜索的内容。',
        logDir: STORAGE_DIR_NAME, provider: 'hybrid', matches: [], diagnostics,
      };
    }

    const queryTerms = tokenizeSearchText(normalizedQuery, { query: true });
    const lexicalRanking = scoreBm25Candidates(index, queryTerms, normalizedSearchText(normalizedQuery));
    const semantic = await buildSemanticRanking(db, index, normalizedQuery, synchronized.warnings);
    const auxiliary = buildAuxiliaryRankings(index, normalizedQuery, lexicalRanking);
    const baseVoices = [
      { name: 'lexical', weight: 1, items: lexicalRanking },
      { name: 'semantic', weight: 1, items: semantic.ranking },
      { name: 'type', weight: 0.6, items: auxiliary.typeRanking },
      { name: 'temporal', weight: 0.5, items: auxiliary.temporalRanking },
      { name: 'relation', weight: 0.4, items: auxiliary.relationRanking },
    ];
    const voiceRanks = new Map();
    for (const voice of baseVoices) {
      voice.items.forEach((entry, rank) => {
        if (!voiceRanks.has(entry.id)) voiceRanks.set(entry.id, {});
        voiceRanks.get(entry.id)[voice.name] = { rank: rank + 1, score: entry.score ?? null };
      });
    }
    const initial = fuseRankings(baseVoices).sort((a, b) => b.score - a.score
      || index.byId.get(a.id).documentPath.localeCompare(index.byId.get(b.id).documentPath)
      || index.byId.get(a.id).startLine - index.byId.get(b.id).startLine).slice(0, 30);
    const rerankerAttempted = Boolean(REMOTE_CONFIG.reranker && initial.length >= 2);
    const reranked = await requestRerank(normalizedQuery, initial, index, synchronized.warnings);
    let fused = initial;
    if (reranked) {
      const rerankItems = reranked.map((entry) => ({ id: initial[entry.index].id, score: entry.score }));
      rerankItems.forEach((entry, rank) => {
        if (!voiceRanks.has(entry.id)) voiceRanks.set(entry.id, {});
        voiceRanks.get(entry.id).rerank = { rank: rank + 1, score: entry.score };
      });
      fused = fuseRankings([...baseVoices, { name: 'rerank', weight: 2, items: rerankItems }])
        .filter((entry) => initial.some((candidate) => candidate.id === entry.id));
    }

    const historyQuery = /过程|历史|旧方案|原方案|曾经|\bhistory\b|\bold\b|\bprevious\b/i.test(normalizedQuery);
    const supersededTargets = new Map();
    for (const relation of index.relations) {
      if (['corrects', 'supersedes'].includes(relation.type)) {
        if (!supersededTargets.has(relation.target_path)) supersededTargets.set(relation.target_path, []);
        supersededTargets.get(relation.target_path).push(relation.source_path);
      }
    }
    fused = fused.map((entry) => {
      const chunk = index.byId.get(entry.id);
      const supersededBy = supersededTargets.get(chunk.documentPath) ?? [];
      return { ...entry, score: entry.score * (!historyQuery && supersededBy.length ? 0.7 : 1), supersededBy };
    }).sort((a, b) => b.score - a.score
      || index.byId.get(a.id).documentPath.localeCompare(index.byId.get(b.id).documentPath)
      || index.byId.get(a.id).startLine - index.byId.get(b.id).startLine);

    const highest = fused[0]?.score || 1;
    const candidates = fused.map((entry) => {
      const chunk = index.byId.get(entry.id);
      return {
        ...entry,
        documentPath: chunk.documentPath,
        startLine: chunk.startLine,
        relevance: entry.score / highest,
        vector: semantic.vectors.get(entry.id) ?? null,
        tokens: new Set(chunk.termCounts.keys()),
      };
    });
    const selected = selectWithMmr(candidates, { limit: REMOTE_CONFIG.maxResults, lambda: 0.75 });
    const matches = selected.map((candidate) => {
      const chunk = index.byId.get(candidate.id);
      const document = index.documents.get(chunk.documentPath);
      const ranks = voiceRanks.get(candidate.id) ?? {};
      return {
        fileName: document.path,
        path: `${STORAGE_DIR_NAME}/${document.path}`,
        number: document.number,
        title: document.title,
        section: chunk.sectionPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        snippet: compressSnippet(chunk.content),
        score: round4(candidate.relevance),
        types: uniqueInOrder([...document.types, ...(chunk.sectionRole === 'other' ? [] : [chunk.sectionRole])]),
        tags: document.tags,
        artifacts: document.artifacts,
        signals: {
          lexicalRank: ranks.lexical?.rank ?? null,
          semanticRank: ranks.semantic?.rank ?? null,
          typeRank: ranks.type?.rank ?? null,
          temporalRank: ranks.temporal?.rank ?? null,
          relationRank: ranks.relation?.rank ?? null,
          rerankRank: ranks.rerank?.rank ?? null,
          lexicalScore: round4(ranks.lexical?.score ?? null),
          semanticScore: round4(ranks.semantic?.score ?? null),
          rerankScore: round4(ranks.rerank?.score ?? null),
        },
        supersededBy: candidate.supersededBy,
      };
    });
    const diagnostics = {
      mode: semantic.active ? 'hybrid' : 'lexical-only',
      indexedDocuments: index.documents.size,
      indexedChunks: index.chunks.length,
      embeddedChunks: semantic.embeddedChunks,
      embeddingModel: REMOTE_CONFIG.embedding?.model ?? null,
      rerankerModel: REMOTE_CONFIG.reranker?.model ?? null,
      rerankerApplied: Boolean(reranked),
      rerankedCandidates: reranked ? initial.length : 0,
      rerankerAttempted,
      warnings: uniqueWarnings(synchronized.warnings),
    };
    return {
      query: normalizedQuery,
      results: formatSearchResults(matches, diagnostics),
      logDir: STORAGE_DIR_NAME,
      provider: 'hybrid',
      matches,
      diagnostics: {
        mode: diagnostics.mode,
        indexedDocuments: diagnostics.indexedDocuments,
        indexedChunks: diagnostics.indexedChunks,
        embeddedChunks: diagnostics.embeddedChunks,
        embeddingModel: diagnostics.embeddingModel,
        rerankerModel: diagnostics.rerankerModel,
        rerankerApplied: diagnostics.rerankerApplied,
        rerankedCandidates: diagnostics.rerankedCandidates,
        warnings: diagnostics.warnings,
      },
    };
  } finally {
    db.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// MCP 服务器与入口
// ============================================================================

const metadataSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  types: z.array(z.enum(MEMORY_TYPES)),
  tags: z.array(z.string()),
  artifacts: z.array(z.string()),
  relations: z.array(z.object({ type: z.enum(RELATION_TYPES), target: z.string() })),
});

const cleanString = (max) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\n\r\x00-\x1F]/.test(value),
  '不能包含换行、NUL 或 C0 控制字符',
);

function createServer() {
  const server = new McpServer({ name: 'agent-log-server', version: '2.0.0' });
  server.registerTool('record-agent-log', {
    title: '记录 Agent 工作日志',
    description: '生成带可验证 metadata v1 的递增编号 Markdown 日志，并维护项目内存储。',
    inputSchema: {
      title: z.string().trim().min(1).describe('工作内容标题'),
      content: z.string().default('').describe('工作记录内容（Markdown 格式）'),
      types: z.array(z.enum(MEMORY_TYPES)).max(10).default([]).describe('记忆类型'),
      tags: z.array(cleanString(64)).max(32).default([]).describe('检索标签'),
      artifacts: z.array(cleanString(256)).max(32).default([]).describe('文件、版本或其他工件'),
      relations: z.array(z.object({
        type: z.enum(RELATION_TYPES),
        target: z.string().regex(/^\d{4}-[^/\\]+\.md$/),
      })).max(16).default([]).describe('指向现存日志的修订关系'),
    },
    outputSchema: {
      filePath: z.string(), fileName: z.string(), number: z.number(), logDir: z.string(), metadata: metadataSchema,
    },
  }, async (input) => {
    const output = await recordAgentLog(input);
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
  });

  server.registerTool('list-logs', {
    title: '列出所有日志',
    description: `列出 ${STORAGE_DIR_NAME} 中的日志及结构化 metadata。`,
    inputSchema: {},
    outputSchema: {
      logs: z.array(z.object({
        number: z.number(), fileName: z.string(), title: z.string(), createdAt: z.string(), metadata: metadataSchema,
      })),
      total: z.number(), logDir: z.string(),
    },
  }, async () => {
    const output = await listLogs();
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
  });

  server.registerTool('read-log', {
    title: '读取指定日志',
    description: '按编号或完整文件名读取原始 Markdown 与结构化 metadata。',
    inputSchema: {
      identifier: z.union([z.string(), z.number()]).describe('日志编号或完整文件名'),
    },
    outputSchema: {
      number: z.number(), fileName: z.string(), title: z.string(), content: z.string(),
      createdAt: z.string(), metadata: metadataSchema,
    },
  }, async ({ identifier }) => {
    const output = await readLog({ identifier });
    return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], structuredContent: output };
  });

  const nullableRank = z.number().int().positive().nullable();
  const nullableScore = z.number().nullable();
  server.registerTool('search-logs', {
    title: '搜索历史日志',
    description: `**重要提示：当需要查找历史记录时，优先使用此工具进行搜索！**\n\n使用中文 BM25、可选向量、类型、时间、关系、可选模型重排和 MMR 搜索项目内日志，并返回精确证据行号。`,
    inputSchema: {
      query: z.string().trim().min(1).max(4000).describe('自然语言搜索查询'),
    },
    outputSchema: {
      query: z.string(), results: z.string(), logDir: z.string(), provider: z.literal('hybrid'),
      matches: z.array(z.object({
        fileName: z.string(), path: z.string(), number: z.number(), title: z.string(), section: z.string(),
        startLine: z.number(), endLine: z.number(), snippet: z.string(), score: z.number(),
        types: z.array(z.string()), tags: z.array(z.string()), artifacts: z.array(z.string()),
        signals: z.object({
          lexicalRank: nullableRank, semanticRank: nullableRank, typeRank: nullableRank,
          temporalRank: nullableRank, relationRank: nullableRank, rerankRank: nullableRank,
          lexicalScore: nullableScore, semanticScore: nullableScore, rerankScore: nullableScore,
        }),
        supersededBy: z.array(z.string()),
      })),
      diagnostics: z.object({
        mode: z.enum(['hybrid', 'lexical-only']), indexedDocuments: z.number(), indexedChunks: z.number(),
        embeddedChunks: z.number(), embeddingModel: z.string().nullable(), rerankerModel: z.string().nullable(),
        rerankerApplied: z.boolean(), rerankedCandidates: z.number(), warnings: z.array(z.string()),
      }),
    },
  }, async ({ query }) => {
    const output = await searchLogs({ query });
    return { content: [{ type: 'text', text: output.results }], structuredContent: output };
  });
  return server;
}

async function main() {
  await prepareProjectStorage();
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

async function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await isDirectEntry()) {
  main().catch((error) => {
    console.error('MCP 日志工具启动失败：', error);
    process.exit(1);
  });
}
