# @mgong/mcp-to-skills

[![npm version](https://img.shields.io/npm/v/@mgong/mcp-to-skills.svg)](https://www.npmjs.com/package/@mgong/mcp-to-skills)
[![npm downloads](https://img.shields.io/npm/dm/@mgong/mcp-to-skills.svg)](https://www.npmjs.com/package/@mgong/mcp-to-skills)
[![license](https://img.shields.io/npm/l/@mgong/mcp-to-skills.svg)](./LICENSE)
[![CI](https://github.com/MichaelGong/mcp-to-skills/actions/workflows/ci.yml/badge.svg)](https://github.com/MichaelGong/mcp-to-skills/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@mgong/mcp-to-skills.svg)](https://nodejs.org)

> [中文文档](./README.zh-CN.md) · English

Discover every MCP server already configured in [Claude Code](https://docs.anthropic.com/en/docs/claude-code), connect to them, and turn each one into a **Skill** that Claude or Cursor can pick up automatically.

For every server you get:

- `SKILL.md` with frontmatter, server description, server instructions, and a per-tool reference table
- `tools/<tool>.json` — the raw JSON Schema of every tool (optional)
- `mcp.json` — a backup of the original MCP entry, so you can safely delete it from `~/.claude.json`

Supported transports: **stdio**, **Streamable HTTP**, **SSE**.

Supported sources (merged automatically):

- **Global** — top-level `mcpServers` in `~/.claude.json` (use `--config` to point elsewhere)
- **Project (cwd)** — `<cwd>/.mcp.json` (Claude Code project format) and `<cwd>/.cursor/mcp.json` (Cursor project format)

The legacy `projects[*].mcpServers` map inside `~/.claude.json` is **not** read by default; pass `--include-projects` if you still want it.

---

## Quick start (no install)

```bash
# 1. List MCP servers found on this machine and probe their tools
npx @mgong/mcp-to-skills list

# 2. Generate ./skills/<server>/SKILL.md for every reachable server
npx @mgong/mcp-to-skills sync

# 3. Install the generated skills into Claude / Cursor (interactive picker)
npx @mgong/mcp-to-skills install
```

Or install globally once:

```bash
npm i -g @mgong/mcp-to-skills
mcp-to-skills sync
mcp-to-skills install
```

After `sync` your tree looks like this:

```
skills/
  context7/
    SKILL.md                 # primary entry the model loads
    mcp.json                 # backup of the original MCP entry
    tools/
      resolve-library-id.json
      query-docs.json
  mcp-backup.json            # aggregate backup, shaped like ~/.claude.json
```

---

## Commands

| Command   | What it does                                                                          |
| --------- | ------------------------------------------------------------------------------------- |
| `list`    | Probe every server, print connectivity + tool list                                    |
| `sync`    | Probe servers and write `SKILL.md` + config backups                                   |
| `install` | Copy `./skills/<server>/` into a target skills directory                              |
| `setup`   | One-shot interactive wizard: pick MCPs → generate → pick skills → pick install target |

Run `mcp-to-skills --help` for the full list of flags.

### Common flags

```bash
# Pick a different output directory
mcp-to-skills sync --out ~/.claude/skills

# Only the global config (skip <cwd>/.mcp.json and <cwd>/.cursor/mcp.json)
mcp-to-skills list --no-local

# Only project-level configs in the current directory (skip ~/.claude.json)
mcp-to-skills list --no-global

# Scan a specific directory for project-level configs
mcp-to-skills list --cwd /path/to/some/project

# Also include the legacy projects[*].mcpServers map from ~/.claude.json
mcp-to-skills list --include-projects

# Don't emit per-tool JSON schemas
mcp-to-skills sync --no-schemas

# Don't write config backups (mcp.json / mcp-backup.json)
mcp-to-skills sync --no-backup

# Keep raw env / headers values in backups (NOT recommended; default is to redact)
mcp-to-skills sync --no-redact-env

# Bigger timeout for slow-starting stdio servers
mcp-to-skills list --timeout 30000

# Use a different global config file
mcp-to-skills list --config /path/to/some.claude.json

# More parallel probes
mcp-to-skills list --concurrency 8
```

---

## install — copy skills into Claude / Cursor

`sync` only writes into `./skills/`. To make Claude Code or Cursor actually load them, copy the directory into the client's skills folder. `install` is an interactive helper for that step (built on [`@clack/prompts`](https://github.com/natemoo-re/clack)).

```bash
mcp-to-skills install
```

```
◆  Where do you want to install the skills?
│  ● Claude Code (global)    /Users/you/.claude/skills
│  ○ Claude Code (project)   .claude/skills
│  ○ Cursor (global)         /Users/you/.cursor/skills
│  ○ Custom path…            enter your own
```

- `Custom path…` opens a text input (`~/...`, relative or absolute paths supported)
- If the target already has a same-named skill, it asks before overwriting (default: skip)
- Copies the whole skill folder: `SKILL.md` + `mcp.json` + `tools/`

Non-interactive / CI:

```bash
# Take the default (~/.claude/skills) without prompting
mcp-to-skills install --yes

# Explicit target (also skips the menu)
mcp-to-skills install --to ~/.cursor/skills

# Replace existing same-named skills
mcp-to-skills install --to ~/.claude/skills --overwrite

# Just print the actions without writing anything
mcp-to-skills install --dry-run

# Use a different source folder (default ./skills)
mcp-to-skills install --from ./generated --to ~/.claude/skills
```

---

## Use as a library

```ts
import { discoverAll, loadClaudeCodeConfig, loadLocalMcpConfigs, writeSkill } from '@mgong/mcp-to-skills'

const servers = [
  ...await loadClaudeCodeConfig(), // global ~/.claude.json (top-level only)
  ...await loadLocalMcpConfigs({ cwd: process.cwd() }), // <cwd>/.mcp.json + <cwd>/.cursor/mcp.json
]
const results = await discoverAll(servers, { timeoutMs: 20_000 })

for (const r of results.filter(r => r.ok && r.tools.length > 5))
  await writeSkill(r, { outDir: './big-skills' })
```

Public exports:

| Export                                                               | Purpose                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `loadClaudeCodeConfig(opts?)`                                        | Parse `~/.claude.json` (top-level `mcpServers` only by default; pass `includeProjects: true` for `projects[*]`) |
| `loadLocalMcpConfigs({ cwd? })`                                      | Parse `<cwd>/.mcp.json` and `<cwd>/.cursor/mcp.json` (deduped via realpath)                                     |
| `discoverServer(server, opts?)`                                      | Connect to a single server and list its tools                                                                   |
| `discoverAll(servers, opts?)`                                        | Probe many servers in parallel                                                                                  |
| `renderSkill(result)`                                                | Render a `DiscoveryResult` into a `SKILL.md` string                                                             |
| `writeSkill(result, { outDir })`                                     | Write `SKILL.md` and `tools/*.json` to disk                                                                     |
| `writeServerBackup(result, outDir, { redactEnv? })`                  | Write `<outDir>/<name>/mcp.json`                                                                                |
| `writeAggregateBackup(results, outDir, { configPath?, redactEnv? })` | Write `<outDir>/mcp-backup.json`                                                                                |
| `sanitizeEntry(entry, { redactEnv? })`                               | Clone an MCP entry, optionally redacting secrets                                                                |
| `listSkillDirs(from)`                                                | List subdirectories of `from` that contain a `SKILL.md`                                                         |
| `installSkills(from, to, { overwrite?, dryRun? })`                   | Copy `<from>/<server>/` into `<to>/<server>/`                                                                   |

---

## Backup & restore

`sync` writes the original MCP server config alongside the generated skill so you can safely **delete the `mcpServers` field from `~/.claude.json`** afterwards. Two files are produced:

| File                         | Purpose                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `<outDir>/<server>/mcp.json` | A single server's entry (`name / source / entry`, plus `lastError` if the connection failed)           |
| `<outDir>/mcp-backup.json`   | Everything aggregated and grouped to mirror `~/.claude.json` (`mcpServers` + `projects[*].mcpServers`) |

### Restore everything back to `~/.claude.json`

```bash
cp ~/.claude.json ~/.claude.json.bak

jq -s '.[0] * { mcpServers: .[1].mcpServers }' \
  ~/.claude.json skills/mcp-backup.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

If you also want to merge `projects.*.mcpServers`:

```bash
jq -s '
  .[0]
  * { mcpServers: .[1].mcpServers }
  * { projects: ((.[0].projects // {}) * (.[1].projects // {})) }
' ~/.claude.json skills/mcp-backup.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

### Restore a single server

```bash
jq --slurpfile s skills/context7/mcp.json \
  '.mcpServers["\($s[0].name)"] = $s[0].entry' \
  ~/.claude.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

> Backups created with `--no-redact-env` contain raw secrets (env values and HTTP headers). Do **not** commit them to a public repo.

---

## Generated SKILL.md

```md
---
name: context7
description: "Use this server to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service... Use when the user wants to call any of the context7 tools: `resolve-library-id`, `query-docs`."
---

# context7

> Source: claude-code:/Users/you/.claude.json
> Server: `Context7` v2.1.8

## Server instructions

Use this server to fetch current documentation whenever the user asks about a library...

## Tools

### `resolve-library-id`

Resolves a package/product name to a Context7-compatible library ID...

**Input schema**

| Name          | Type   | Required | Description                                |
| ------------- | ------ | -------- | ------------------------------------------ |
| `query`       | string | yes      | The question or task you need help with... |
| `libraryName` | string | yes      | Library name to search for...              |
```

---

## Troubleshooting

| Symptom                   | Likely cause                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FAIL (transport: ...)`   | Wrong / missing fields on the URL or command                                                                                                                                                                             |
| `FAIL (... timed out)`    | Server starts slowly — retry with `--timeout 30000`                                                                                                                                                                      |
| `FAIL (spawn xxx ENOENT)` | The stdio `command` is not on `PATH`. Use an absolute path                                                                                                                                                               |
| `FAIL (401 / 403)`        | The HTTP server needs auth headers (`headers` in the entry)                                                                                                                                                              |
| `No MCP servers found`    | Neither `~/.claude.json` nor `<cwd>/.mcp.json` / `<cwd>/.cursor/mcp.json` defines any server. Pass `--include-projects` for the legacy `projects[*].mcpServers` map, or `cd` into a project that has a local `.mcp.json` |

To see a stdio server's own stderr, edit `src/discover.ts` and switch `stderr: 'pipe'` to `'inherit'`.

---

## Security

- Backups (`mcp.json` and `mcp-backup.json`) **redact** `env` and `headers` values to `"***"` by default
- Pass `--no-redact-env` only when you fully control the destination
- The `skills/` directory is in the project's `.gitignore`. Never commit it
- This tool reads `~/.claude.json`, spawns the MCP server processes you already have configured (stdio), or makes outbound HTTP requests to URLs you already trust. It does not phone home

Found a security issue? Please report privately to the email in `package.json` (or open a draft security advisory on GitHub) instead of filing a public issue.

---

## Contributing

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm lint        # antfu eslint
pnpm test        # vitest
pnpm build       # produces dist/cli.js + dist/index.js + .d.ts
```

PRs welcome. Please:

1. Add a test for new behavior (`tests/*.test.ts`)
2. Run `pnpm lint:fix && pnpm test && pnpm typecheck` before opening the PR
3. Update `CHANGELOG.md` under "Unreleased"

---

## Roadmap

- [ ] `sync` hash compare — skip writing identical files (better `git diff`)
- [ ] `sync --prune` — delete skill directories whose source server is gone
- [ ] `install --prune` — mirror deletes at the install target
- [x] Use server `instructions` first paragraph as `description` frontmatter (fallback: tool descriptions + tool names)
- [x] `install` interactive command
- [ ] Pull configs from more clients: Cursor (global / project), Claude Desktop, …

---

## License

[MIT](./LICENSE) © Michael Gong
