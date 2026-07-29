import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  decodeFloat32Le,
  encodeFloat32Le,
  fuseRankings,
  normalizeRerankResponse,
  parseAgentLog,
  resolveStorageLayout,
  scoreBm25Candidates,
  selectWithMmr,
  splitLogIntoChunks,
  tokenizeSearchText,
} from '../src/index.js';

const workspaceParent = path.join(process.cwd(), '.agent-logs-test-workspaces');

beforeAll(async () => {
  await fs.mkdir(workspaceParent, { recursive: true });
});

afterAll(async () => {
  await fs.rm(workspaceParent, { recursive: true, force: true });
});

function fakeStat(iso = '2026-07-29T00:00:00.000Z') {
  return { birthtime: new Date(iso), mtime: new Date(iso) };
}

describe('metadata v1 与 Markdown 分块', () => {
  test('只授权紧跟 H1 的首个有效 metadata 块并保持字段', () => {
    const content = `# 决策 -- 标题\n\n<!-- agentlogs-meta:v1\n{"version":1,"createdAt":"2026-07-29T01:02:03.000Z","types":["decision","decision"],"tags":["中文","中文"],"artifacts":["a--b"],"relations":[{"type":"corrects","target":"0001-old.md"},{"type":"corrects","target":"0001-old.md"}]}\n-->\n\n正文\n\n<!-- agentlogs-meta:v1\n{"version":1,"createdAt":"2020-01-01T00:00:00.000Z","types":["error"],"tags":[],"artifacts":[],"relations":[]}\n-->`;
    const parsed = parseAgentLog(content, '0002-new.md', fakeStat());
    expect(parsed.metadata).toEqual({
      version: 1,
      createdAt: '2026-07-29T01:02:03.000Z',
      types: ['decision'],
      tags: ['中文'],
      artifacts: ['a--b'],
      relations: [{ type: 'corrects', target: '0001-old.md' }],
    });
    const chunks = splitLogIntoChunks(parsed);
    expect(chunks.some((chunk) => chunk.content.includes('正文'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('2020-01-01'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('2026-07-29'))).toBe(false);
  });

  test('无效或非首块 metadata 不吞正文并回退文件时间', () => {
    const invalid = '# 标题\n\n正文先出现\n\n<!-- agentlogs-meta:v1\n{"version":2}\n-->\n';
    const parsed = parseAgentLog(invalid, '0001-title.md', fakeStat());
    expect(parsed.metadata.createdAt).toBe('2026-07-29T00:00:00.000Z');
    expect(parsed.metadata.types).toEqual([]);
    expect(splitLogIntoChunks(parsed).map((chunk) => chunk.content).join('\n')).toContain('{"version":2}');
  });

  test('嵌套标题、空 section、代码 fence、超长段落和单行都保留精确行号', () => {
    const longLine = '甲'.repeat(4000);
    const content = [
      '# 标题', '', '根级内容', '', '## 根因', '', '```js', 'const x = 1;', '', 'const y = 2;', '```', '',
      '多行段落'.repeat(500), '', '### 验证', longLine,
    ].join('\n');
    const parsed = parseAgentLog(content, '0001-title.md', fakeStat());
    const chunks = splitLogIntoChunks(parsed);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((chunk) => chunk.content.length <= 1800)).toBe(true);
    expect(chunks.some((chunk) => chunk.sectionPath === '' && chunk.content.includes('根级内容'))).toBe(true);
    expect(chunks.some((chunk) => chunk.content.includes('const y = 2;'))).toBe(true);
    const windows = chunks.filter((chunk) => chunk.startLine === 16 && chunk.endLine === 16);
    expect(windows.length).toBe(3);
    expect(windows[0].content.slice(-200)).toBe(windows[1].content.slice(0, 200));
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.endLine).toBeLessThanOrEqual(parsed.lines.length);
    }
  });

  test('只有 H1 的极短文档仍产生可追溯根级 chunk', () => {
    const parsed = parseAgentLog('# 独立结论\n', '0001-title.md', fakeStat());
    expect(splitLogIntoChunks(parsed)).toEqual([{
      content: '# 独立结论',
      sectionPath: '',
      sectionRole: 'learning',
      startLine: 1,
      endLine: 1,
    }]);
  });
});

describe('中文与技术词 BM25', () => {
  test('中文 bigram、单字 unigram 和技术 token 按规则产生', () => {
    const pathTerms = tokenizeSearchText('路径过滤');
    expect(pathTerms).toContain('g2:路径');
    expect(pathTerms).toContain('g2:过滤');
    expect(tokenizeSearchText('错', { query: true })).toContain('g1:错');
    expect(tokenizeSearchText('错误', { query: true })).not.toContain('g1:错');
    const technical = tokenizeSearchText('FC_MAX_TURNS EOTP 1.0.4');
    expect(technical).toEqual(expect.arrayContaining(['fc_max_turns', 'eotp', '1.0.4']));
  });

  test('BM25 使用精确公式、技术词权重和确定性排序', () => {
    const chunks = [
      { id: 'a', documentPath: '0001-a.md', startLine: 1, tokenCount: 2, searchText: 'EOTP', termCounts: new Map([['eotp', 2]]) },
      { id: 'b', documentPath: '0002-b.md', startLine: 1, tokenCount: 2, searchText: 'partial', termCounts: new Map([['eotp', 1]]) },
    ];
    const index = {
      chunks,
      byId: new Map(chunks.map((chunk) => [chunk.id, chunk])),
      totalChunks: 2,
      avgTokenCount: 2,
      termStats: new Map([['eotp', 2]]),
    };
    const queryTerms = tokenizeSearchText('EOTP', { query: true });
    const result = scoreBm25Candidates(index, queryTerms, 'eotp');
    const idf = Math.log(1 + 0.5 / 2.5);
    const expectedA = 1.4 * idf * (2 * 2.2 / (2 + 1.2)) + 2;
    expect(result.map((item) => item.id)).toEqual(['a', 'b']);
    expect(result[0].score).toBeCloseTo(expectedA, 10);
    expect(scoreBm25Candidates(index, queryTerms, 'eotp')).toEqual(result);
  });
});

describe('融合、Rerank、MMR 与向量编码', () => {
  test('五路 RRF 和权重 2 的第六路可改变排序', () => {
    const base = [
      { weight: 1, items: ['a', 'b'] },
      { weight: 1, items: ['a', 'b'] },
      { weight: 0.6, items: ['b', 'a'] },
      { weight: 0.5, items: ['b', 'a'] },
      { weight: 0.4, items: ['b', 'a'] },
    ];
    expect(fuseRankings(base)[0].id).toBe('a');
    expect(fuseRankings([...base, { weight: 2, items: ['b', 'a'] }])[0].id).toBe('b');
    expect(fuseRankings(base)).toEqual(fuseRankings(base));
  });

  test.each(['results', 'data'])('%s envelope 规范化且并列稳定', (field) => {
    expect(normalizeRerankResponse({ [field]: [
      { index: 2, relevance_score: 0.5 },
      { index: 0, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.8 },
    ] }, 3)).toEqual([
      { index: 1, score: 0.8, rank: 1 },
      { index: 0, score: 0.5, rank: 2 },
      { index: 2, score: 0.5, rank: 3 },
    ]);
  });

  test.each([
    [{}, 1],
    [{ results: [], data: [] }, 0],
    [{ results: [{ index: 0, relevance_score: 1 }] }, 2],
    [{ results: [{ index: 1, relevance_score: 1 }] }, 1],
    [{ results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0 }] }, 2],
    [{ results: [{ index: 0, relevance_score: Number.NaN }] }, 1],
  ])('拒绝畸形 Rerank 响应 %#', (payload, count) => {
    expect(() => normalizeRerankResponse(payload, count)).toThrow();
  });

  test('float32 little-endian 往返并拒绝维度不一致', () => {
    const encoded = encodeFloat32Le([1, -0.5, Math.PI]);
    expect([...encoded.slice(0, 4)]).toEqual([0, 0, 128, 63]);
    expect([...decodeFloat32Le(encoded, 3)]).toEqual([1, -0.5, expect.closeTo(Math.PI, 5)]);
    expect(() => decodeFloat32Le(encoded, 2)).toThrow('维度');
  });

  test('MMR 使用向量 cosine 或 token Jaccard 且每文件最多两个结果', () => {
    const candidates = [
      { id: 'a1', documentPath: 'a.md', startLine: 1, relevance: 1, vector: Float32Array.from([1, 0]), tokens: ['x'] },
      { id: 'a2', documentPath: 'a.md', startLine: 2, relevance: 0.99, vector: Float32Array.from([1, 0]), tokens: ['x'] },
      { id: 'a3', documentPath: 'a.md', startLine: 3, relevance: 0.98, vector: null, tokens: ['x'] },
      { id: 'b1', documentPath: 'b.md', startLine: 1, relevance: 0.8, vector: Float32Array.from([0, 1]), tokens: ['y'] },
    ];
    const selected = selectWithMmr(candidates, { limit: 4, lambda: 0.75 });
    expect(selected[0].id).toBe('a1');
    expect(selected[1].id).toBe('b1');
    expect(selected.filter((item) => item.documentPath === 'a.md')).toHaveLength(2);
  });
});

describe('项目本地存储解析', () => {
  test('默认字面量统一到 .agent-logs 且不创建目录', async () => {
    const root = await fs.mkdtemp(path.join(workspaceParent, 'layout-'));
    for (const configured of [undefined, '', '.agent-logs', 'AgentLogs']) {
      const layout = await resolveStorageLayout(root, configured);
      expect(layout.storageDirName).toBe('.agent-logs');
      expect(layout.usesDefaultLayout).toBe(true);
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  test('合法嵌套目录可用，绝对路径、点与逃逸被拒绝', async () => {
    const root = await fs.mkdtemp(path.join(workspaceParent, 'layout-'));
    const nested = await resolveStorageLayout(root, 'data/logs');
    expect(nested.storageDirName).toBe('data/logs');
    expect(nested.usesDefaultLayout).toBe(false);
    for (const configured of [root, '.', '../escape']) {
      await expect(resolveStorageLayout(root, configured)).rejects.toThrow('存储目录必须位于当前项目目录内');
    }
  });

  test('项目外 symlink 被拒绝，项目内普通父目录可用', async () => {
    const root = await fs.mkdtemp(path.join(workspaceParent, 'layout-'));
    const outside = await fs.mkdtemp(path.join(workspaceParent, 'outside-'));
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(resolveStorageLayout(root, 'link/logs')).rejects.toThrow('存储目录必须位于当前项目目录内');
    await fs.mkdir(path.join(root, 'ordinary'));
    await expect(resolveStorageLayout(root, 'ordinary/logs')).resolves.toMatchObject({ storageDirName: 'ordinary/logs' });
  });
});
