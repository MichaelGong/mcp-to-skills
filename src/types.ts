import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export interface StdioServerEntry {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type HttpTransportKind = 'http' | 'streamable-http' | 'sse'

export interface HttpServerEntry {
  type: HttpTransportKind
  url: string
  headers?: Record<string, string>
}

export type McpServerEntry = StdioServerEntry | HttpServerEntry

export interface DiscoveredServer {
  name: string
  /** Human-readable origin, e.g. `claude-code:/Users/g/.claude.json`. */
  source: string
  entry: McpServerEntry
}

export interface DiscoveryResult {
  serverName: string
  source: string
  /** Original config entry, kept around so downstream can back it up. */
  entry: McpServerEntry
  ok: boolean
  error?: string
  serverInfo?: { name: string, version?: string }
  instructions?: string
  tools: Tool[]
}

export function isStdioEntry(entry: McpServerEntry): entry is StdioServerEntry {
  return (entry as StdioServerEntry).command !== undefined
}
