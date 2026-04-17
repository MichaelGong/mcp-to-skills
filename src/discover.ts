import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { DiscoveredServer, DiscoveryResult, McpServerEntry } from './types'
import process from 'node:process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { isStdioEntry } from './types'

const CLIENT_INFO = { name: 'mcp-to-skills', version: '0.1.0' }

export interface DiscoverOptions {
  /** Per-request timeout in ms (passed to `connect` and `listTools`). */
  timeoutMs?: number
  /** How many servers to probe in parallel. */
  concurrency?: number
}

function buildTransport(entry: McpServerEntry): Transport {
  if (isStdioEntry(entry)) {
    return new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      env: entry.env
        ? { ...(process.env as Record<string, string>), ...entry.env }
        : undefined,
      cwd: entry.cwd,
      // Capture stderr instead of polluting our own stdout.
      stderr: 'pipe',
    })
  }

  const url = new URL(entry.url)
  const requestInit: RequestInit | undefined = entry.headers
    ? { headers: entry.headers }
    : undefined

  if (entry.type === 'sse')
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined)

  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined)
}

async function listAllTools(client: Client, timeoutMs: number): Promise<Tool[]> {
  const all: Tool[] = []
  let cursor: string | undefined
  do {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs })
    all.push(...res.tools)
    cursor = res.nextCursor
  } while (cursor)
  return all
}

export async function discoverServer(
  server: DiscoveredServer,
  opts: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const base = {
    serverName: server.name,
    source: server.source,
    entry: server.entry,
  }

  let transport: Transport
  try {
    transport = buildTransport(server.entry)
  }
  catch (err) {
    return { ...base, ok: false, error: `transport: ${(err as Error).message}`, tools: [] }
  }

  const client = new Client(CLIENT_INFO)

  try {
    await client.connect(transport, { timeout: timeoutMs })
    const tools = await listAllTools(client, timeoutMs)
    const info = client.getServerVersion()
    const instructions = client.getInstructions()
    return {
      ...base,
      ok: true,
      serverInfo: info ? { name: info.name, version: info.version } : undefined,
      instructions,
      tools,
    }
  }
  catch (err) {
    return { ...base, ok: false, error: (err as Error)?.message ?? String(err), tools: [] }
  }
  finally {
    try {
      await client.close()
    }
    catch {
      // Ignore shutdown errors; the original failure is more useful.
    }
  }
}

export async function discoverAll(
  servers: DiscoveredServer[],
  opts: DiscoverOptions = {},
): Promise<DiscoveryResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4)
  const results: DiscoveryResult[] = Array.from({ length: servers.length })
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++
      if (idx >= servers.length)
        return
      results[idx] = await discoverServer(servers[idx], opts)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, servers.length || 1) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}
