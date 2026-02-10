# AGENTS.md — mcp-agentlogs

## Project Overview

MCP (Model Context Protocol) server for agent work logging. Single-file Node.js application (`src/index.js`) providing 4 tools: `record-agent-log`, `list-logs`, `read-log`, `search-logs`. Uses ACE API for semantic search.

- **Language**: JavaScript (ES modules, `"type": "module"`)
- **Runtime**: Node.js >=18, also supports Bun
- **Entry point**: `src/index.js`
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod` (v4)

## Build / Run / Test Commands

```bash
# Install dependencies
npm ci

# Run (Node.js)
npm start            # or: node src/index.js

# Run (Bun)
npm run start:bun    # or: bun src/index.js

# No test framework configured — no test command exists
# No linter or formatter configured
```

There is **no build step** — raw JS, no transpilation.

### CI/CD

- **Publish to npm**: triggered on `v*` tags or manual dispatch (`publish.yml`)
- **GitHub Release**: triggered on `v*` tags (`release.yml`)
- CI uses Node 20, `npm ci`, `npm publish --access public --provenance`

## Code Style Guidelines

### Formatting

- **Indentation**: 2 spaces
- **Semicolons**: always
- **Quotes**: single quotes (`'...'`)
- **Template literals**: use for string interpolation (`\`${var}\``)
- **Trailing commas**: yes, in multi-line arrays/objects
- **Line length**: no strict limit, but keep readable (~100-120 chars)

### Imports

- **Node.js builtins**: always use `node:` prefix — `import fs from 'node:fs/promises'`, `import path from 'node:path'`
- **External packages**: named imports — `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`
- **Zod**: namespace import — `import * as z from 'zod'`
- **Import order**: Node.js builtins → external packages → local modules

### Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Functions | camelCase | `readLogFile`, `generateLogFilename` |
| Constants | SCREAMING_SNAKE_CASE | `LOG_DIR`, `MAX_RETRIES` |
| Variables | camelCase | `logFiles`, `nextNumber` |
| MCP tool names | kebab-case | `record-agent-log`, `search-logs` |
| File names | kebab-case or camelCase | `index.js` |

### Functions

- **Pure functions preferred** — no classes used in this codebase
- **`const` by default**, `let` only when reassignment is needed, never `var`
- **Arrow functions** for callbacks and short expressions
- **`async/await`** throughout — no raw Promise chains
- **Section separators**: use `// ========== Section Name ==========` comment blocks to divide logical sections

### Comments & Documentation

- **Language**: Chinese (中文) for all comments, error messages, and user-facing strings
- **JSDoc**: `/** 描述 */` above functions (brief, Chinese)
- **Inline comments**: Chinese, explaining *why* not *what*
- Section headers use `// ====...====` pattern

### Error Handling

- **`try/catch` with `async/await`** — never let errors propagate silently
- **Check error codes**: `error?.code === 'ENOENT'` for filesystem operations
- **Empty catches**: allowed ONLY with a comment explaining why (e.g., directory already exists)
- **Error messages**: Chinese, descriptive, include relevant context (file paths, IDs)
- **Return MCP error format**: `{ content: [{ type: 'text', text: errorMessage }], isError: true }`

### Schema Validation

- **Zod v4** for all MCP tool input/output schemas
- Define schemas inline in tool registration
- Use `.describe()` for field descriptions (Chinese)

### Architecture Patterns

- Single-file architecture — all logic in `src/index.js`
- Filesystem-based storage (numbered markdown files in configurable `LOG_DIR`)
- MCP SDK's `McpServer` class for server setup and tool registration
- Tool handler pattern: validate input → perform operation → return structured result
- Retry logic with exponential backoff for external API calls (ACE search)

## Git Conventions

### Commit Message Format

```
:gitmoji: <type>: [<scope>] <subject>
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`

**Common gitmojis**:
- ✨ `:sparkles:` — new feature
- 🐛 `:bug:` — bug fix
- 📝 `:memo:` — documentation
- 🎨 `:art:` — code style/structure
- ♻️ `:recycle:` — refactor
- 🔧 `:wrench:` — config changes
- 🎉 `:tada:` — initial commit
- ⬆️ `:arrow_up:` — dependency upgrade
- 🚀 `:rocket:` — deploy/release

**Always include**:
```
Co-authored-by: Wine Fox <fox@ling.plus>
```

### Version Tagging

- Tags follow `v*` pattern (e.g., `v1.0.1`)
- Tagging triggers both npm publish and GitHub Release

## Environment Variables

| Variable | Purpose | Required |
|----------|---------|----------|
| `ACE_BASE_URL` | ACE API base URL for semantic search | For `search-logs` |
| `ACE_API_KEY` | ACE API key for authentication | For `search-logs` |
| `LOG_DIR` | Custom log directory path | No (defaults to `./AgentLogs`) |

## Key File Locations

```
src/index.js          — Entire application (MCP server + all tool handlers)
package.json          — Project metadata and scripts
.github/workflows/    — CI: publish.yml + release.yml
AgentLogs/            — Default log output directory (gitignored)
```

## Common Patterns for New Tools

When adding a new MCP tool, follow this pattern from `src/index.js`:

```javascript
server.tool(
  'tool-name',
  '工具描述（中文）',
  {
    // Zod v4 input schema
    paramName: z.string().describe('参数描述'),
  },
  async ({ paramName }) => {
    try {
      // Implementation
      return {
        content: [{ type: 'text', text: resultString }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `错误信息: ${error.message}` }],
        isError: true,
      };
    }
  }
);
```

## Notes for AI Agents

- This is a **single-file project** — all changes go in `src/index.js`
- No tests exist — if adding tests, propose a framework first (vitest recommended for ESM)
- No linter configured — follow the style patterns described above by reading existing code
- All user-facing text must be in **Chinese (中文)**
- When modifying, preserve the `// ====...====` section separator structure
- The MCP SDK uses stdio transport — the server communicates via stdin/stdout
