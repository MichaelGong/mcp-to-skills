import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { DiscoveryResult, McpServerEntry } from './types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isStdioEntry } from './types'

export interface WriteSkillOptions {
  /** Root directory; final SKILL.md goes to `<outDir>/<server>/SKILL.md`. */
  outDir: string
  /** When true (default), also dump per-tool JSON schemas under `tools/`. */
  writeRawSchemas?: boolean
}

/** YAML-quote a value if it contains characters that would break a bare scalar. */
function yamlString(value: string): string {
  return /[:#\n"'&*?{}[\],|>%@`]/.test(value) || value.trim() !== value
    ? JSON.stringify(value)
    : value
}

function singleLine(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max: number): string {
  if (text.length <= max)
    return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** First sentence-ish chunk: stop at the first `.`, `。`, `!`, `?`, `！`, `？`. */
function firstSentence(text: string): string {
  const cleaned = singleLine(text)
  const m = cleaned.match(/^.+?[.。!?！？](?:\s|$)/)
  return m ? m[0].trim() : cleaned
}

/**
 * Build the frontmatter `description` for a skill.
 *
 * Strategy, in priority order:
 * 1. If the MCP server returned `instructions`, use its first paragraph as the
 *    primary description (this is what the server author wrote about itself).
 * 2. Otherwise synthesize a capability summary by joining the first sentence
 *    of every tool's description.
 * 3. Append a `Use when …` clause that lists the tool names so the model has
 *    concrete keywords to match against the user's prompt.
 *
 * Server name + version + tool count are intentionally NOT in the description:
 * they're noise for routing and are already shown in the body of `SKILL.md`.
 */
function buildDescription(result: DiscoveryResult): string {
  const { serverName, tools, instructions } = result
  const MAIN_MAX = 600
  const TRIGGER_MAX = 350
  const TOTAL_MAX = 1024

  let main: string
  if (instructions?.trim()) {
    const firstPara = instructions.trim().split(/\n\s*\n/)[0] ?? instructions
    main = clip(singleLine(firstPara), MAIN_MAX)
  }
  else if (tools.length > 0) {
    const summaries = tools
      .map(t => firstSentence(t.description ?? '').replace(/\.$/, ''))
      .filter(Boolean)
    const joined = summaries.join('; ')
    main = clip(
      joined
        ? `MCP server "${serverName}" exposes tools to: ${joined}.`
        : `MCP server "${serverName}" exposes ${tools.length} tool${tools.length === 1 ? '' : 's'}.`,
      MAIN_MAX,
    )
  }
  else {
    main = `MCP server "${serverName}" exposes no tools.`
  }

  let trigger = ''
  if (tools.length > 0) {
    const names = tools.map(t => `\`${t.name}\``).join(', ')
    trigger = clip(
      `Use when the user wants to call any of the ${serverName} tools: ${names}.`,
      TRIGGER_MAX,
    )
  }

  return clip(trigger ? `${main} ${trigger}` : main, TOTAL_MAX)
}

function summarizeInputSchema(schema: unknown): string {
  if (!schema || typeof schema !== 'object')
    return '_No input parameters._'

  const s = schema as { properties?: Record<string, any>, required?: string[] }
  const props = s.properties ?? {}
  const required = new Set<string>(Array.isArray(s.required) ? s.required : [])
  const keys = Object.keys(props)
  if (keys.length === 0)
    return '_No input parameters._'

  const rows: string[] = [
    '| Name | Type | Required | Description |',
    '| --- | --- | --- | --- |',
  ]
  for (const k of keys) {
    const p = props[k] ?? {}
    const type = Array.isArray(p.type) ? p.type.join(' \\| ') : (p.type ?? '-')
    const desc = singleLine(p.description).replace(/\|/g, '\\|')
    rows.push(`| \`${k}\` | ${type} | ${required.has(k) ? 'yes' : 'no'} | ${desc} |`)
  }
  return rows.join('\n')
}

function renderToolSection(tool: Tool): string {
  const parts: string[] = []
  parts.push(`### \`${tool.name}\``)
  if (tool.description)
    parts.push(tool.description.trim())
  parts.push('**Input schema**')
  parts.push(summarizeInputSchema(tool.inputSchema))
  return parts.join('\n\n')
}

export function renderSkill(result: DiscoveryResult): string {
  const { serverName, tools, serverInfo, instructions, source } = result

  const description = buildDescription(result)

  const lines: string[] = [
    '---',
    `name: ${yamlString(serverName)}`,
    `description: ${yamlString(description)}`,
    '---',
    '',
    `# ${serverName}`,
    '',
    `> Source: ${source}`,
  ]
  if (serverInfo) {
    lines.push(
      `> Server: \`${serverInfo.name}\`${serverInfo.version ? ` v${serverInfo.version}` : ''}`,
    )
  }

  if (instructions?.trim()) {
    lines.push('', '## Server instructions', '', instructions.trim())
  }

  lines.push('', '## Tools', '')
  if (tools.length === 0)
    lines.push('_No tools exposed._')
  else
    lines.push(tools.map(renderToolSection).join('\n\n'))

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

export async function writeSkill(
  result: DiscoveryResult,
  opts: WriteSkillOptions,
): Promise<string> {
  const dir = path.join(opts.outDir, result.serverName)
  await fs.mkdir(dir, { recursive: true })

  const skillPath = path.join(dir, 'SKILL.md')
  await fs.writeFile(skillPath, renderSkill(result), 'utf8')

  if (opts.writeRawSchemas !== false && result.tools.length > 0) {
    const toolsDir = path.join(dir, 'tools')
    await fs.mkdir(toolsDir, { recursive: true })
    await Promise.all(
      result.tools.map(tool =>
        fs.writeFile(
          path.join(toolsDir, `${tool.name}.json`),
          `${JSON.stringify(
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
            null,
            2,
          )}\n`,
          'utf8',
        ),
      ),
    )
  }

  return skillPath
}

// -- Backup helpers ----------------------------------------------------------

export interface BackupOptions {
  /** Replace every value inside `env` with `"***"` (keys are kept). */
  redactEnv?: boolean
}

const REDACTED = '***'

/** Produce a copy of an entry, optionally redacting `env` values. */
export function sanitizeEntry(entry: McpServerEntry, opts: BackupOptions = {}): McpServerEntry {
  const cloned = JSON.parse(JSON.stringify(entry)) as McpServerEntry
  if (opts.redactEnv && isStdioEntry(cloned) && cloned.env) {
    for (const k of Object.keys(cloned.env))
      cloned.env[k] = REDACTED
  }
  if (opts.redactEnv && !isStdioEntry(cloned) && cloned.headers) {
    for (const k of Object.keys(cloned.headers))
      cloned.headers[k] = REDACTED
  }
  return cloned
}

interface ServerBackupFile {
  name: string
  source: string
  lastError?: string
  entry: McpServerEntry
}

/**
 * Write a single-server backup to `<outDir>/<server>/mcp.json`. Always written,
 * even when the server failed to connect, so the original config can be removed
 * from `~/.claude.json` safely.
 */
export async function writeServerBackup(
  result: DiscoveryResult,
  outDir: string,
  opts: BackupOptions = {},
): Promise<string> {
  const dir = path.join(outDir, result.serverName)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'mcp.json')
  const payload: ServerBackupFile = {
    name: result.serverName,
    source: result.source,
    ...(result.ok ? {} : { lastError: result.error }),
    entry: sanitizeEntry(result.entry, opts),
  }
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

interface AggregateBackup {
  generatedAt: string
  configPath?: string
  mcpServers: Record<string, McpServerEntry>
  projects?: Record<string, { mcpServers: Record<string, McpServerEntry> }>
}

const TOP_PREFIX = 'claude-code:'
const PROJECT_PREFIX = 'claude-code:project:'

/**
 * Write `<outDir>/mcp-backup.json` aggregating every entry, grouped to mirror
 * the shape of `~/.claude.json` (`mcpServers` + `projects[*].mcpServers`).
 */
export async function writeAggregateBackup(
  results: DiscoveryResult[],
  outDir: string,
  opts: BackupOptions & { configPath?: string } = {},
): Promise<string> {
  const payload: AggregateBackup = {
    generatedAt: new Date().toISOString(),
    configPath: opts.configPath,
    mcpServers: {},
  }

  for (const r of results) {
    const sanitized = sanitizeEntry(r.entry, opts)
    if (r.source.startsWith(PROJECT_PREFIX)) {
      const projPath = r.source.slice(PROJECT_PREFIX.length)
      payload.projects ??= {}
      payload.projects[projPath] ??= { mcpServers: {} }
      payload.projects[projPath].mcpServers[r.serverName] = sanitized
    }
    else if (r.source.startsWith(TOP_PREFIX)) {
      payload.mcpServers[r.serverName] = sanitized
    }
  }

  await fs.mkdir(outDir, { recursive: true })
  const file = path.join(outDir, 'mcp-backup.json')
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

// -- Install / sync to external skills directory ----------------------------

export interface InstallOptions {
  /** Replace existing `<to>/<server>/` directories (default: skip on conflict). */
  overwrite?: boolean
  /** Print actions without touching disk. */
  dryRun?: boolean
}

export interface InstallReport {
  copied: string[]
  skipped: { name: string, reason: string }[]
}

/** Return subdirectories of `from` that contain a `SKILL.md`. */
export async function listSkillDirs(from: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(from, { withFileTypes: true })
  }
  catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory())
      continue
    try {
      await fs.access(path.join(from, e.name, 'SKILL.md'))
      out.push(e.name)
    }
    catch {
      // not a skill dir, ignore
    }
  }
  return out.sort()
}

/**
 * Copy every `<from>/<server>/` (one with a `SKILL.md`) into `<to>/<server>/`.
 * Existing target dirs are kept unless `overwrite` is true.
 */
export async function installSkills(
  from: string,
  to: string,
  opts: InstallOptions = {},
): Promise<InstallReport> {
  const skills = await listSkillDirs(from)
  const report: InstallReport = { copied: [], skipped: [] }
  if (skills.length === 0)
    return report

  if (!opts.dryRun)
    await fs.mkdir(to, { recursive: true })

  for (const name of skills) {
    const src = path.join(from, name)
    const dst = path.join(to, name)
    const exists = await fs.stat(dst).then(() => true).catch(() => false)

    if (exists && !opts.overwrite) {
      report.skipped.push({ name, reason: 'target exists (use --overwrite)' })
      continue
    }
    if (opts.dryRun) {
      report.copied.push(name)
      continue
    }
    if (exists)
      await fs.rm(dst, { recursive: true, force: true })
    await fs.cp(src, dst, { recursive: true })
    report.copied.push(name)
  }
  return report
}
