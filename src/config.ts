import type { DiscoveredServer, McpServerEntry } from './types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export interface LoadOptions {
  /** Override config file path. Defaults to `~/.claude.json`. */
  configPath?: string
  /**
   * When true, also collect `projects[*].mcpServers` from the global config.
   *
   * Default: `false`. The CLI now relies on {@link loadLocalMcpConfigs} to
   * pick up project-level servers from the current working directory instead.
   */
  includeProjects?: boolean
}

export interface LoadLocalOptions {
  /** Working directory to look in. Defaults to `process.cwd()`. */
  cwd?: string
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>
  projects?: Record<string, { mcpServers?: Record<string, McpServerEntry> } | undefined>
}

interface LocalMcpFile {
  mcpServers?: Record<string, McpServerEntry>
}

/**
 * Load MCP server entries from a Claude Code config file (default `~/.claude.json`).
 *
 * Only the **top-level** `mcpServers` is read by default; the `projects[*]`
 * map is ignored unless `includeProjects: true` is passed. Returns an empty
 * array when the file does not exist.
 */
export async function loadClaudeCodeConfig(opts: LoadOptions = {}): Promise<DiscoveredServer[]> {
  const filePath = opts.configPath ?? path.join(os.homedir(), '.claude.json')

  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return []
    throw err
  }

  const cfg = JSON.parse(raw) as ClaudeConfig
  const servers: DiscoveredServer[] = []

  for (const [name, entry] of Object.entries(cfg.mcpServers ?? {}))
    servers.push({ name, source: `claude-code:${filePath}`, entry })

  if (opts.includeProjects === true) {
    for (const [projPath, proj] of Object.entries(cfg.projects ?? {})) {
      for (const [name, entry] of Object.entries(proj?.mcpServers ?? {}))
        servers.push({ name, source: `claude-code:project:${projPath}`, entry })
    }
  }

  return servers
}

/**
 * Discover project-level MCP server entries declared in the current working
 * directory. Two locations are inspected:
 *
 * - `<cwd>/.mcp.json`         — Claude Code project format
 * - `<cwd>/.cursor/mcp.json`  — Cursor project format
 *
 * Both files are expected to be `{ "mcpServers": { ... } }`. Files that do
 * not exist are silently skipped. If both paths resolve (via symlink or not)
 * to the same underlying file, it is only read once.
 */
export async function loadLocalMcpConfigs(
  opts: LoadLocalOptions = {},
): Promise<DiscoveredServer[]> {
  const cwd = opts.cwd ?? process.cwd()
  const candidates: Array<{ file: string, sourceTag: string }> = [
    { file: path.join(cwd, '.mcp.json'), sourceTag: 'claude-code:project' },
    { file: path.join(cwd, '.cursor', 'mcp.json'), sourceTag: 'cursor:project' },
  ]

  const seen = new Set<string>()
  const servers: DiscoveredServer[] = []

  for (const { file, sourceTag } of candidates) {
    let real: string
    try {
      real = await fs.realpath(file)
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        continue
      throw err
    }
    if (seen.has(real))
      continue
    seen.add(real)

    let raw: string
    try {
      raw = await fs.readFile(real, 'utf8')
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        continue
      throw err
    }

    let cfg: LocalMcpFile
    try {
      cfg = JSON.parse(raw) as LocalMcpFile
    }
    catch (err) {
      throw new Error(`Failed to parse ${file}: ${(err as Error).message}`)
    }

    for (const [name, entry] of Object.entries(cfg.mcpServers ?? {}))
      servers.push({ name, source: `${sourceTag}:${file}`, entry })
  }

  return servers
}
