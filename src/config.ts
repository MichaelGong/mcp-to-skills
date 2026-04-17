import type { DiscoveredServer, McpServerEntry } from './types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface LoadOptions {
  /** Override config file path. Defaults to `~/.claude.json`. */
  configPath?: string
  /** When true (default), also collect `projects[*].mcpServers`. */
  includeProjects?: boolean
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>
  projects?: Record<string, { mcpServers?: Record<string, McpServerEntry> } | undefined>
}

/**
 * Load MCP server entries from a Claude Code config file (default `~/.claude.json`).
 * Returns an empty array if the file does not exist.
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

  if (opts.includeProjects !== false) {
    for (const [projPath, proj] of Object.entries(cfg.projects ?? {})) {
      for (const [name, entry] of Object.entries(proj?.mcpServers ?? {}))
        servers.push({ name, source: `claude-code:project:${projPath}`, entry })
    }
  }

  return servers
}
