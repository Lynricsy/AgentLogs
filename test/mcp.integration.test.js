import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = process.cwd();
const workspaceParent = path.join(repo, '.agent-logs-test-workspaces');
let mockServer;
let mockBaseUrl;
let requests;
let rerankMode;
let embeddingMode;

beforeAll(async () => {
  await fs.mkdir(workspaceParent, { recursive: true });
  requests = [];
  rerankMode = 'normal';
  embeddingMode = 'normal';
  mockServer = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
    });
    requests.push({ url: request.url, headers: request.headers, body });
    if (request.url.startsWith('/embeddings')) {
      if (embeddingMode === 'zero') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [0, 0, 0] })) }));
        return;
      }
      if (embeddingMode === 'nan') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, null, 0] })) }));
        return;
      }
      if (embeddingMode === 'drift' && body.input.length > 1) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: body.input.map((_, index) => ({
          index,
          embedding: index === 0 ? [1, 0] : [1, 0, 0],
        })) }));
        return;
      }
      const data = body.input.map((text, index) => {
        const semantic = text.includes('向量接口方案') || text.includes('multilingual embedding');
        return { index, embedding: semantic ? [1, 0, 0] : [0, 1, 0] };
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data }));
      return;
    }
    if (request.url === '/custom/rerank?tenant=test') {
      if (rerankMode === 'duplicate') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ results: body.documents.map(() => ({ index: 0, relevance_score: 1 })) }));
        return;
      }
      if (rerankMode === '503') {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.end('sensitive-response-body');
        return;
      }
      const results = body.documents.map((document, index) => ({
        index,
        relevance_score: document.includes('候选 B') ? 100 : body.documents.length - index,
      }));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ results }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockBaseUrl = `http://127.0.0.1:${mockServer.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  await fs.rm(workspaceParent, { recursive: true, force: true });
});

async function connectClient(cwd, overrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repo, 'src/index.js')],
    cwd,
    env: {
      ...process.env,
      AGENT_LOG_DIR: '',
      AGENT_LOG_EMBEDDING_API_URL: `${mockBaseUrl}/`,
      AGENT_LOG_EMBEDDING_API_KEY: 'embedding-secret',
      AGENT_LOG_EMBEDDING_MODEL: 'mock-embedding',
      AGENT_LOG_EMBEDDING_TIMEOUT_MS: '1000',
      AGENT_LOG_EMBEDDING_BATCH_SIZE: '32',
      AGENT_LOG_RERANK_API_URL: `${mockBaseUrl}/custom/rerank?tenant=test`,
      AGENT_LOG_RERANK_API_KEY: 'reranker-secret',
      AGENT_LOG_RERANK_MODEL: 'mock-reranker',
      AGENT_LOG_RERANK_TIMEOUT_MS: '1000',
      AGENT_LOG_SEARCH_MAX_RESULTS: '5',
      ...overrides,
    },
  });
  const client = new Client({ name: 'agentlogs-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text ?? `${name} 失败`);
  return result.structuredContent;
}

async function runServerToExit(cwd, overrides) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, 'src/index.js')], {
      cwd,
      env: {
        ...process.env,
        AGENT_LOG_DIR: '',
        AGENT_LOG_EMBEDDING_API_URL: '',
        AGENT_LOG_EMBEDDING_API_KEY: '',
        AGENT_LOG_EMBEDDING_MODEL: '',
        AGENT_LOG_EMBEDDING_TIMEOUT_MS: '1000',
        AGENT_LOG_EMBEDDING_BATCH_SIZE: '32',
        AGENT_LOG_RERANK_API_URL: '',
        AGENT_LOG_RERANK_API_KEY: '',
        AGENT_LOG_RERANK_MODEL: '',
        AGENT_LOG_RERANK_TIMEOUT_MS: '1000',
        AGENT_LOG_SEARCH_MAX_RESULTS: '5',
        ...overrides,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('等待失败进程退出超时'));
    }, 5_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.on('error', reject);
  });
}

describe('真实 stdio MCP', () => {
  test('metadata、词法、语义、Rerank、修订和增量同步端到端工作', async () => {
    const cwd = await fs.mkdtemp(path.join(workspaceParent, 'case-'));
    requests.length = 0;
    rerankMode = 'normal';
    const { client } = await connectClient(cwd);
    try {
      const decision = await call(client, 'record-agent-log', {
        title: '向量接口方案候选 A',
        content: '## 决策\n采用 multilingual embedding。\n\n## 验证\nEOTP 路径过滤已通过。',
        types: ['decision', 'decision'],
        tags: ['中文检索', '中文检索'],
        artifacts: ['EOTP'],
      });
      expect(decision.logDir).toBe('.agent-logs');
      expect(decision.metadata.types).toEqual(['decision']);
      const markdown = await fs.readFile(path.join(cwd, '.agent-logs', decision.fileName), 'utf8');
      expect(markdown).toContain('<!-- agentlogs-meta:v1');
      const listed = await call(client, 'list-logs');
      const read = await call(client, 'read-log', { identifier: decision.fileName });
      expect(listed.logs[0].metadata).toEqual(decision.metadata);
      expect(read.metadata).toEqual(decision.metadata);
      expect(read.content).toBe(markdown);

      await call(client, 'record-agent-log', {
        title: '候选 B',
        content: '## 错误\n候选 B 包含 EOTP，作为更相关修复。',
        types: ['error'],
      });
      const lexical = await call(client, 'search-logs', { query: 'EOTP' });
      expect(lexical.provider).toBe('hybrid');
      expect(lexical.matches[0].path).toMatch(/^\.agent-logs\/\d{4}-/);
      expect(lexical.matches[0].startLine).toBeGreaterThan(0);
      expect(lexical.matches.some((match) => match.signals.lexicalRank !== null)).toBe(true);

      const single = await call(client, 'search-logs', { query: '错' });
      expect(single.matches[0].types).toContain('error');

      const semantic = await call(client, 'search-logs', { query: '向量接口方案' });
      expect(semantic.diagnostics.mode, JSON.stringify(semantic.diagnostics)).toBe('hybrid');
      expect(semantic.matches[0].signals.semanticRank).toBe(1);

      const reranked = await call(client, 'search-logs', { query: 'EOTP 候选' });
      expect(reranked.matches[0].title).toContain('候选 B');
      expect(reranked.diagnostics.rerankerApplied).toBe(true);
      expect(reranked.matches[0].signals.rerankRank).toBe(1);
      const rerankRequest = requests.filter((request) => request.url === '/custom/rerank?tenant=test').at(-1);
      expect(Object.keys(rerankRequest.body).sort()).toEqual(['documents', 'model', 'query']);
      expect(rerankRequest.body.query).toBe('EOTP 候选');
      expect(rerankRequest.headers.authorization).toBe('Bearer reranker-secret');
      expect(rerankRequest.body.documents[0]).toContain('文件: .agent-logs/');
      expect(rerankRequest.body).not.toHaveProperty('top_n');

      const correction = await call(client, 'record-agent-log', {
        title: '修正旧决策',
        content: '## 修复\n新方案修正旧方案。',
        relations: [{ type: 'corrects', target: decision.fileName }],
      });
      const corrected = await call(client, 'search-logs', { query: '向量接口方案' });
      const oldMatch = corrected.matches.find((match) => match.fileName === decision.fileName);
      expect(oldMatch?.supersededBy).toContain(correction.fileName);

      const uniqueMarker = 'UNIQUE_MARKER_2026';
      await fs.appendFile(path.join(cwd, '.agent-logs', decision.fileName), `\n## 发现\n${uniqueMarker}\n`);
      const changed = await call(client, 'search-logs', { query: uniqueMarker });
      const changedMatch = changed.matches.find((match) => match.fileName === decision.fileName);
      expect(changedMatch?.startLine).toBeGreaterThan(0);
      expect(changedMatch?.signals.lexicalRank).not.toBeNull();

      rerankMode = 'duplicate';
      const malformed = await call(client, 'search-logs', { query: 'EOTP' });
      expect(malformed.diagnostics.mode).toBe('hybrid');
      expect(malformed.diagnostics.rerankerApplied).toBe(false);
      expect(malformed.diagnostics.rerankedCandidates).toBe(0);
      expect(malformed.diagnostics.warnings.join('\n')).not.toContain('reranker-secret');

      rerankMode = '503';
      const before503 = requests.filter((request) => request.url === '/custom/rerank?tenant=test').length;
      const fallback = await call(client, 'search-logs', { query: 'EOTP' });
      const after503 = requests.filter((request) => request.url === '/custom/rerank?tenant=test').length;
      expect(after503 - before503).toBe(1);
      expect(fallback.diagnostics.rerankerApplied).toBe(false);
      expect(fallback.diagnostics.warnings.join('\n')).not.toContain('tenant=test');
      expect(fallback.diagnostics.warnings.join('\n')).not.toContain('sensitive-response-body');

      const storageEntries = await fs.readdir(path.join(cwd, '.agent-logs'));
      expect(storageEntries).toContain('index.sqlite');
      expect(storageEntries).not.toContain('index.lock');
      expect((await fs.readdir(cwd)).sort()).toEqual(['.agent-logs', '.gitignore']);
    } finally {
      await client.close().catch(() => {});
    }
  });

  test('旧目录原子迁移、冲突阻塞与显式目录隔离', async () => {
    for (const configured of ['', 'AgentLogs', '.agent-logs']) {
      const cwd = await fs.mkdtemp(path.join(workspaceParent, 'migration-'));
      await fs.mkdir(path.join(cwd, 'AgentLogs'));
      await fs.writeFile(path.join(cwd, 'AgentLogs', '0001-old.md'), '# 旧日志\n\n正文\n');
      const { client } = await connectClient(cwd, { AGENT_LOG_DIR: configured, AGENT_LOG_EMBEDDING_API_URL: '', AGENT_LOG_EMBEDDING_MODEL: '', AGENT_LOG_RERANK_API_URL: '', AGENT_LOG_RERANK_MODEL: '' });
      try {
        expect((await call(client, 'list-logs')).total).toBe(1);
        await expect(fs.stat(path.join(cwd, '.agent-logs'))).resolves.toBeTruthy();
        await expect(fs.stat(path.join(cwd, 'AgentLogs'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await client.close().catch(() => {});
      }
    }

    const override = await fs.mkdtemp(path.join(workspaceParent, 'override-'));
    await fs.mkdir(path.join(override, 'AgentLogs'));
    const { client } = await connectClient(override, { AGENT_LOG_DIR: 'data/logs', AGENT_LOG_EMBEDDING_API_URL: '', AGENT_LOG_EMBEDDING_MODEL: '', AGENT_LOG_RERANK_API_URL: '', AGENT_LOG_RERANK_MODEL: '' });
    try {
      expect((await call(client, 'list-logs')).logDir).toBe('data/logs');
      await expect(fs.stat(path.join(override, 'AgentLogs'))).resolves.toBeTruthy();
    } finally {
      await client.close().catch(() => {});
    }
  });

  test('Reranker 只接收初始前 30 个候选且只请求一次', async () => {
    const cwd = await fs.mkdtemp(path.join(workspaceParent, 'cap-'));
    requests.length = 0;
    rerankMode = 'normal';
    const { client } = await connectClient(cwd);
    try {
      const sections = Array.from({ length: 31 }, (_, index) => `## 分段 ${index + 1}\nCAP_UNIQUE_TOKEN 候选 ${index + 1}`).join('\n\n');
      await call(client, 'record-agent-log', { title: '三十一候选', content: sections });
      await call(client, 'search-logs', { query: 'CAP_UNIQUE_TOKEN' });
      const rerankRequests = requests.filter((request) => request.url === '/custom/rerank?tenant=test');
      expect(rerankRequests).toHaveLength(1);
      expect(rerankRequests[0].body.documents).toHaveLength(30);
    } finally {
      await client.close().catch(() => {});
    }
  });

  test('Reranker 未配置、不完整和非法协议均独立禁用', async () => {
    const variants = [
      [{ AGENT_LOG_RERANK_API_URL: '', AGENT_LOG_RERANK_MODEL: '' }, null],
      [{ AGENT_LOG_RERANK_API_URL: `${mockBaseUrl}/custom/rerank?tenant=test`, AGENT_LOG_RERANK_MODEL: '' }, 'reranker 配置不完整'],
      [{ AGENT_LOG_RERANK_API_URL: '', AGENT_LOG_RERANK_MODEL: 'mock-reranker' }, 'reranker 配置不完整'],
      [{ AGENT_LOG_RERANK_API_URL: 'ftp://invalid.example/rerank?secret=yes', AGENT_LOG_RERANK_MODEL: 'mock-reranker' }, 'reranker URL 无效'],
    ];
    for (const [overrides, warning] of variants) {
      const cwd = await fs.mkdtemp(path.join(workspaceParent, 'rerank-config-'));
      requests.length = 0;
      const { client } = await connectClient(cwd, {
        AGENT_LOG_EMBEDDING_API_URL: '',
        AGENT_LOG_EMBEDDING_MODEL: '',
        ...overrides,
      });
      try {
        await call(client, 'record-agent-log', { title: '候选一', content: 'CONFIG_TOKEN' });
        await call(client, 'record-agent-log', { title: '候选二', content: 'CONFIG_TOKEN' });
        const result = await call(client, 'search-logs', { query: 'CONFIG_TOKEN' });
        expect(result.diagnostics.rerankerApplied).toBe(false);
        expect(result.diagnostics.rerankerModel).toBeNull();
        if (warning) expect(result.diagnostics.warnings.join('\n')).toContain(warning);
        else expect(result.diagnostics.warnings).toEqual([]);
        expect(requests.filter((request) => request.url === '/custom/rerank?tenant=test')).toHaveLength(0);
      } finally {
        await client.close().catch(() => {});
      }
    }
  });

  test('损坏索引、schema 漂移、过期锁和活跃锁均安全恢复或内存降级', async () => {
    const cwd = await fs.mkdtemp(path.join(workspaceParent, 'recovery-'));
    const disabled = {
      AGENT_LOG_EMBEDDING_API_URL: '',
      AGENT_LOG_EMBEDDING_MODEL: '',
      AGENT_LOG_RERANK_API_URL: '',
      AGENT_LOG_RERANK_MODEL: '',
    };
    let connection = await connectClient(cwd, disabled);
    await call(connection.client, 'record-agent-log', { title: '恢复测试', content: 'RECOVERY_TOKEN' });
    await call(connection.client, 'search-logs', { query: 'RECOVERY_TOKEN' });
    await connection.client.close();

    const storage = path.join(cwd, '.agent-logs');
    await fs.writeFile(path.join(storage, 'index.sqlite'), 'not-a-sqlite-database');
    connection = await connectClient(cwd, disabled);
    try {
      const corrupt = await call(connection.client, 'search-logs', { query: 'RECOVERY_TOKEN' });
      expect(corrupt.matches[0].fileName).toContain('恢复测试');
      expect((await fs.readdir(storage)).some((name) => name.startsWith('index.corrupt-'))).toBe(true);
    } finally {
      await connection.client.close().catch(() => {});
    }

    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const wrongDb = new SQL.Database();
    wrongDb.run('CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    wrongDb.run("INSERT INTO index_meta VALUES ('schema_version', '999')");
    await fs.writeFile(path.join(storage, 'index.sqlite'), wrongDb.export());
    wrongDb.close();
    connection = await connectClient(cwd, disabled);
    try {
      const wrongSchema = await call(connection.client, 'search-logs', { query: 'RECOVERY_TOKEN' });
      expect(wrongSchema.matches.length).toBeGreaterThan(0);
      expect(wrongSchema.diagnostics.warnings.join('\n')).toContain('派生索引损坏');

      const lockPath = path.join(storage, 'index.lock');
      await fs.writeFile(lockPath, '{}');
      const active = await call(connection.client, 'search-logs', { query: 'RECOVERY_TOKEN' });
      expect(active.diagnostics.warnings.join('\n')).toContain('索引锁等待超时');
      await fs.rm(lockPath, { force: true });

      await fs.writeFile(lockPath, '{}');
      const stale = new Date(Date.now() - 10 * 60_000);
      await fs.utimes(lockPath, stale, stale);
      const recovered = await call(connection.client, 'search-logs', { query: 'RECOVERY_TOKEN' });
      expect(recovered.matches.length).toBeGreaterThan(0);
      await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const entries = await fs.readdir(storage);
      expect(entries.every((name) => !name.endsWith('.tmp') && name !== 'index.lock')).toBe(true);
    } finally {
      await connection.client.close().catch(() => {});
    }
  }, 20_000);

  test('默认目录冲突与越界配置在写入任何运行时文件前失败', async () => {
    const conflict = await fs.mkdtemp(path.join(workspaceParent, 'conflict-'));
    await fs.mkdir(path.join(conflict, '.agent-logs'));
    await fs.mkdir(path.join(conflict, 'AgentLogs'));
    await fs.writeFile(path.join(conflict, '.agent-logs', 'new.bin'), 'new');
    await fs.writeFile(path.join(conflict, 'AgentLogs', 'old.bin'), 'old');
    const conflictResult = await runServerToExit(conflict, {});
    expect(conflictResult.code).not.toBe(0);
    expect(conflictResult.stderr).toContain('同时检测到 .agent-logs 与旧 AgentLogs，无法自动合并，请先手动保留一个目录');
    expect(await fs.readFile(path.join(conflict, '.agent-logs', 'new.bin'), 'utf8')).toBe('new');
    expect(await fs.readFile(path.join(conflict, 'AgentLogs', 'old.bin'), 'utf8')).toBe('old');

    const root = await fs.mkdtemp(path.join(workspaceParent, 'invalid-layout-'));
    const outside = await fs.mkdtemp(path.join(workspaceParent, 'outside-target-'));
    await fs.symlink(outside, path.join(root, 'link'));
    for (const configured of [path.join(root, 'absolute'), '../escape', 'link/logs']) {
      const before = (await fs.readdir(root)).sort();
      const result = await runServerToExit(root, { AGENT_LOG_DIR: configured });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('存储目录必须位于当前项目目录内');
      expect((await fs.readdir(root)).sort()).toEqual(before);
    }
  });

  test('零向量、非有限向量和批内维度漂移整批降级', async () => {
    for (const mode of ['zero', 'nan', 'drift']) {
      embeddingMode = mode;
      const cwd = await fs.mkdtemp(path.join(workspaceParent, `embedding-${mode}-`));
      const { client } = await connectClient(cwd, {
        AGENT_LOG_RERANK_API_URL: '',
        AGENT_LOG_RERANK_MODEL: '',
      });
      try {
        await call(client, 'record-agent-log', { title: '向量一', content: 'VECTOR_FAILURE_TOKEN 第一段' });
        await call(client, 'record-agent-log', { title: '向量二', content: 'VECTOR_FAILURE_TOKEN 第二段' });
        const result = await call(client, 'search-logs', { query: 'VECTOR_FAILURE_TOKEN' });
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.diagnostics.mode).toBe('lexical-only');
        expect(result.diagnostics.warnings.join('\n')).toContain('embedding');
      } finally {
        await client.close().catch(() => {});
      }
    }
    embeddingMode = 'normal';
  });

  test('远程端点不可达时 embedding 与 Reranker 独立降级且词法仍成功', async () => {
    const cwd = await fs.mkdtemp(path.join(workspaceParent, 'offline-'));
    const { client } = await connectClient(cwd, {
      AGENT_LOG_EMBEDDING_API_URL: 'http://127.0.0.1:1',
      AGENT_LOG_RERANK_API_URL: 'http://127.0.0.1:1/custom/rerank?tenant=secret',
    });
    try {
      await call(client, 'record-agent-log', { title: '离线检索', content: 'OFFLINE_TOKEN' });
      await call(client, 'record-agent-log', { title: '离线候选', content: 'OFFLINE_TOKEN' });
      const result = await call(client, 'search-logs', { query: 'OFFLINE_TOKEN' });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.diagnostics.mode).toBe('lexical-only');
      expect(result.diagnostics.rerankerApplied).toBe(false);
      const warnings = result.diagnostics.warnings.join('\n');
      expect(warnings).toContain('embedding 127.0.0.1:1');
      expect(warnings).toContain('reranker 127.0.0.1:1');
      expect(warnings).not.toContain('tenant=secret');
      expect(warnings).not.toContain('embedding-secret');
      expect(warnings).not.toContain('reranker-secret');
    } finally {
      await client.close().catch(() => {});
    }
  }, 15_000);
});
