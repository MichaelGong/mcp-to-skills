# @mgong/mcp-to-skills

> [English README](./README.md) · 中文文档

探索本机 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已配置的 MCP server，连上去拉取它们暴露的工具，并把每个 server 渲染成一份可被 Claude / Cursor 直接识别的 **Skill**（`SKILL.md` + 每个 tool 的 JSON Schema）。

- 配置来源（自动合并）：
  - **全局**：`~/.claude.json` 顶层的 `mcpServers`（可用 `--config` 指向其它文件）
  - **项目（cwd）**：`<cwd>/.mcp.json`（Claude Code 项目格式）和 `<cwd>/.cursor/mcp.json`（Cursor 项目格式）
  - 默认**不**读取 `~/.claude.json` 里的 `projects[*].mcpServers`，需要的话加 `--include-projects`
- 传输支持：stdio / Streamable HTTP / SSE
- 输出形态：`<outDir>/<server>/SKILL.md`（含 frontmatter）+ `<outDir>/<server>/tools/<tool>.json`

---

## 安装

```bash
pnpm install
```

> 依赖了 `@modelcontextprotocol/client@2.0.0-alpha.2`。该 alpha 包未声明运行时依赖 `@cfworker/json-schema`，本仓库已显式安装。

---

## 最快上手（4 步）

```bash
# 1. 看本机有哪些 MCP server，能不能连上、有哪些工具
pnpm start list

# 2. 把它们生成成 SKILL.md 到项目内 ./skills/
pnpm sync

# 3. 把生成好的 skills 安装到 Claude / Cursor 的 skills 目录（交互式选择）
mcp-to-skills install

# 4. 检查生成结果
ls skills/
cat skills/<server-name>/SKILL.md
```

跑完 `pnpm sync` 后会得到这样的目录：

```
skills/
  context7/
    SKILL.md                 # 给模型看的总入口（带 frontmatter）
    mcp.json                 # 这个 server 的原始配置备份
    tools/
      resolve-library-id.json
      query-docs.json
  mcp-backup.json            # 顶层聚合备份，结构兼容 ~/.claude.json
```

`install` 会把 `skills/<server>/` 整个目录拷贝到目标位置（默认 `~/.claude/skills/`），客户端启动时就能识别。也可以直接手动拷到 `~/.cursor/skills-cursor/` 等任何 skills 目录。

> `mcp.json` 与 `mcp-backup.json` 是**配置备份**：连接失败的 server 也会备份（这样你删掉原配置后还能恢复）。详见下方 [配置备份与恢复](#%E9%85%8D%E7%BD%AE%E5%A4%87%E4%BB%BD%E4%B8%8E%E6%81%A2%E5%A4%8D)。

---

## 命令一览

```bash
pnpm start list            # 探测 + 打印
pnpm start sync            # 探测 + 写 SKILL.md
mcp-to-skills install         # 把 ./skills/ 拷到 Claude / Cursor 等目录（交互式）
mcp-to-skills setup           # 一键向导：探测 → 选 MCP → 生成 → 选 skill → 选目标，三步都二次确认
pnpm start --help          # 全部参数

pnpm typecheck             # tsc --noEmit
pnpm lint                  # antfu eslint
pnpm lint:fix              # 自动修复
pnpm build                 # 出 dist/cli.js + dist/index.js + .d.ts
```

### 常用参数

```bash
# 换输出目录（注意 pnpm 透传参数要加 --）
pnpm start sync -- --out ~/.claude/skills

# 只读全局，不读当前目录下的 .mcp.json / .cursor/mcp.json
pnpm start list -- --no-local

# 只读当前目录的项目级配置，不读 ~/.claude.json
pnpm start list -- --no-global

# 指定要扫描的项目目录
pnpm start list -- --cwd /path/to/some/project

# 也读取 ~/.claude.json 里 projects[*].mcpServers（默认不读）
pnpm start list -- --include-projects

# 不生成 tools/*.json，只要 SKILL.md
pnpm start sync -- --no-schemas

# 不写配置备份（mcp.json / mcp-backup.json）
pnpm start sync -- --no-backup

# 备份时把 env / headers 值替换为 "***"
pnpm start sync -- --redact-env

# 慢启动 server 调高超时（默认 15s）
pnpm start list -- --timeout 30000

# 临时指定别的全局配置文件
pnpm start list -- --config /path/to/some.claude.json

# 调整并发探测数（默认 4）
pnpm start list -- --concurrency 8
```

> 小坑：`pnpm <script> --foo` 会被 pnpm 当成自己的参数。给底层程序传参要用 `--` 隔开，例如 `pnpm sync -- --out skills2`。

---

## install：把 skills 装到客户端

`sync` 只是把 `SKILL.md` 写进 `./skills/`，要让 Claude Code / Cursor 真正用上还得拷到对应目录。`install` 命令负责这一步，基于 [`@clack/prompts`](https://github.com/natemoo-re/clack) 提供交互式选择。

```bash
mcp-to-skills install
```

会弹出菜单，常见目标一键选中：

```
◆  Where do you want to install the skills?
│  ● Claude Code (global)    /Users/you/.claude/skills
│  ○ Claude Code (project)   .claude/skills
│  ○ Cursor (global)         /Users/you/.cursor/skills
│  ○ Custom path…            enter your own
```

- 选 `Custom path…` 会跳出文本框，支持 `~/...`、相对/绝对路径
- 目标已有同名 skill 会再问一次是否覆盖（默认 No）
- 整包复制：`SKILL.md` + `mcp.json` + `tools/`

非交互 / CI 场景（无 TTY，或显式跳过提示）：

```bash
# 直接采用默认 ~/.claude/skills，不弹任何菜单
mcp-to-skills install --yes

# 显式指定目标（也跳过菜单）
mcp-to-skills install --to ~/.cursor/skills

# 已存在直接覆盖（默认是 skip）
mcp-to-skills install --to ~/.claude/skills --overwrite

# 仅打印将要执行的动作，不动文件
mcp-to-skills install --dry-run

# 改源目录（默认 ./skills）
mcp-to-skills install --from ./generated --to ~/.claude/skills
```

| 参数           | 说明                                        |
| -------------- | ------------------------------------------- |
| `--from <dir>` | 源目录，默认 `./skills`（即 `sync` 的输出） |
| `--to <dir>`   | 目标目录；不传时进入交互菜单                |
| `--yes`, `-y`  | 跳过交互，使用默认目标 `~/.claude/skills`   |
| `--overwrite`  | 覆盖目标已有的同名 skill 目录               |
| `--dry-run`    | 只显示要做的事，不写盘                      |

> 只复制包含 `SKILL.md` 的子目录，所以 `mcp-backup.json` 等附加文件不会被装到客户端的 skills 目录里。

---

## 配置备份与恢复

`sync` 默认会同时把 MCP server 的原始配置写盘，所以你跑完之后就可以**安全地从 `~/.claude.json` 中删掉** `mcpServers` 字段：日后想换机器、想给同事一份、或者要恢复都可以从备份复原。

写出的两类文件：

| 文件                         | 用途                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `<outDir>/<server>/mcp.json` | 单个 server 的原始 entry，包含 `name / source / entry`，连接失败时还会带 `lastError`                    |
| `<outDir>/mcp-backup.json`   | 全部聚合，按 `mcpServers` + `projects[*].mcpServers` 分组，结构与 `~/.claude.json` 一致，可直接合并回去 |

### 备份相关参数

```bash
mcp-to-skills sync --no-backup        # 不写 mcp.json / mcp-backup.json
mcp-to-skills sync --redact-env       # env / headers 的值替换成 "***"（保留 key）
```

### 整个恢复回 ~/.claude.json

最直观的做法用 jq：

```bash
# 备份当前 claude.json
cp ~/.claude.json ~/.claude.json.bak

# 把聚合备份里的 mcpServers 合并回 ~/.claude.json
jq -s '.[0] * { mcpServers: .[1].mcpServers }' \
  ~/.claude.json skills/mcp-backup.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

如果备份里有 `projects.*.mcpServers`，也想合并回去：

```bash
jq -s '
  .[0]
  * { mcpServers: .[1].mcpServers }
  * { projects: ((.[0].projects // {}) * (.[1].projects // {})) }
' ~/.claude.json skills/mcp-backup.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

### 只恢复某一个 server

```bash
# 把 skills/context7/mcp.json 里的 entry 写回 ~/.claude.json 的 mcpServers.context7
jq --slurpfile s skills/context7/mcp.json \
  '.mcpServers["\($s[0].name)"] = $s[0].entry' \
  ~/.claude.json > ~/.claude.json.next \
  && mv ~/.claude.json.next ~/.claude.json
```

> 安全提示：备份默认包含完整的 `env`（含 token / API key）。如果要把备份提交到仓库或发给别人，请加 `--redact-env`。

---

## 当成全局 CLI 用

构建一次后链接到全局，就能在任意目录直接 `mcp-to-skills ...`：

```bash
pnpm build
pnpm link --global

mcp-to-skills list
mcp-to-skills sync                            # 写到 ./skills/
mcp-to-skills install                         # 交互式装到 ~/.claude/skills 等
mcp-to-skills sync --out ~/.cursor/skills-cursor --no-schemas
```

不想链接也行：

```bash
node /path/to/mcp-to-skills/dist/cli.js list
```

---

## 当成库用

```ts
import { discoverAll, loadClaudeCodeConfig, loadLocalMcpConfigs, writeSkill } from 'mcp-to-skills'

const servers = [
  ...await loadClaudeCodeConfig(), // ~/.claude.json 顶层 mcpServers
  ...await loadLocalMcpConfigs({ cwd: process.cwd() }), // <cwd>/.mcp.json + <cwd>/.cursor/mcp.json
]
const results = await discoverAll(servers, { timeoutMs: 20_000 })

for (const r of results.filter(r => r.ok && r.tools.length > 5))
  await writeSkill(r, { outDir: './big-skills' })
```

主要导出：

| 名称                                                                 | 说明                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `loadClaudeCodeConfig(opts?)`                                        | 解析 `~/.claude.json`，默认只读顶层 `mcpServers`；`includeProjects: true` 时再读 `projects[*]` |
| `loadLocalMcpConfigs({ cwd? })`                                      | 解析 `<cwd>/.mcp.json` 和 `<cwd>/.cursor/mcp.json`（按 realpath 去重）                         |
| `discoverServer(server, opts?)`                                      | 连接单个 server，返回 `DiscoveryResult`                                                        |
| `discoverAll(servers, opts?)`                                        | 并发探测多个 server                                                                            |
| `renderSkill(result)`                                                | 把 `DiscoveryResult` 渲染成 `SKILL.md` 字符串                                                  |
| `writeSkill(result, { outDir })`                                     | 落盘 `SKILL.md` 与 `tools/*.json`                                                              |
| `writeServerBackup(result, outDir, { redactEnv? })`                  | 落盘 `<outDir>/<name>/mcp.json`                                                                |
| `writeAggregateBackup(results, outDir, { configPath?, redactEnv? })` | 落盘 `<outDir>/mcp-backup.json`                                                                |
| `sanitizeEntry(entry, { redactEnv? })`                               | 拷贝并按需脱敏一个 entry                                                                       |
| `listSkillDirs(from)`                                                | 列出 `from` 下所有含 `SKILL.md` 的子目录                                                       |
| `installSkills(from, to, { overwrite?, dryRun? })`                   | 把 `<from>/<server>/` 拷到 `<to>/<server>/`                                                    |

---

## 典型工作流

**A. 把所有 Claude Code 上的 MCP 一键变成 Claude Skill**

```bash
mcp-to-skills sync       # 写到 ./skills/，先在仓库内 review
mcp-to-skills install    # 交互式装到 ~/.claude/skills
```

也可以一步到位（不留本地副本）：

```bash
mcp-to-skills sync --out ~/.claude/skills
```

新装一个 MCP server 后重跑一次即可。

**B. 只看某次新加的 server 工作正常不正常**

```bash
mcp-to-skills list | grep <server-name>
```

`OK (N tools)` = 连上并拉到 N 个 tool；`FAIL (...)` 会带原因。

**C. 给团队同步配置**：把对方的 `claude.json` 拷过来

```bash
mcp-to-skills sync --config ./teammate.claude.json --out ./teammate-skills
```

---

## FAIL 排查

| 现象                      | 含义 / 处理                                               |
| ------------------------- | --------------------------------------------------------- |
| `FAIL (transport: ...)`   | URL / command 字段写错或缺字段                            |
| `FAIL (... timed out)`    | server 启动慢，加 `--timeout 30000` 重试                  |
| `FAIL (spawn xxx ENOENT)` | stdio server 的 `command` 不在 PATH，需要写绝对路径或装好 |
| `FAIL (401 / 403)`        | HTTP server 缺 `headers` 里的鉴权字段                     |

需要看 stdio server 自己的报错，可以临时把 `src/discover.ts` 中的 `stderr: 'pipe'` 改成 `'inherit'` 重跑。

---

## 输出的 SKILL.md 长什么样

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

## 项目结构

```
src/
  types.ts       # 共享类型 + isStdioEntry 守卫
  config.ts      # 解析 ~/.claude.json
  discover.ts    # Client + Stdio/StreamableHTTP/SSE Transport，分页 listTools，并发
  skill.ts       # 渲染 SKILL.md 与 tools/*.json，落盘
  cli.ts         # list / sync / install 子命令（带 shebang，install 用 @clack/prompts 交互）
  index.ts       # 库导出
```

---

## 路线图

- [ ] 写盘前对比 hash，无变化不写，方便 `git diff`
- [ ] `sync --prune`：删除配置中已不存在的 skill 目录
- [ ] `install --prune`：从目标目录里删除源目录已不存在的 skill
- [x] 用 server `instructions` 的首段当作 frontmatter 的 `description`，让 Skill 触发更准（fallback：从 tool 描述聚合 + 列出 tool 名）
- [x] `install` 命令：交互式把生成的 skills 拷到 Claude / Cursor 的 skills 目录
- [ ] 多客户端配置源：Cursor 全局 / 项目、Claude Desktop 等
