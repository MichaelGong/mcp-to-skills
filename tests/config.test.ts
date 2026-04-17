import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadClaudeCodeConfig } from '../src/config'

let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-to-skills-'))
  configPath = path.join(tmpDir, 'claude.json')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('loadClaudeCodeConfig', () => {
  it('returns empty array when the config file does not exist', async () => {
    const out = await loadClaudeCodeConfig({ configPath: path.join(tmpDir, 'nope.json') })
    expect(out).toEqual([])
  })

  it('parses top-level mcpServers', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          alpha: { command: 'a' },
          beta: { type: 'http', url: 'https://b' },
        },
      }),
    )
    const out = await loadClaudeCodeConfig({ configPath })
    expect(out).toHaveLength(2)
    expect(out.map(s => s.name).sort()).toEqual(['alpha', 'beta'])
    expect(out[0].source).toBe(`claude-code:${configPath}`)
  })

  it('includes projects[*].mcpServers by default', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { top: { command: 't' } },
        projects: {
          '/path/to/proj': { mcpServers: { proj1: { command: 'p' } } },
        },
      }),
    )
    const out = await loadClaudeCodeConfig({ configPath })
    expect(out).toHaveLength(2)
    const proj = out.find(s => s.name === 'proj1')
    expect(proj?.source).toBe('claude-code:project:/path/to/proj')
  })

  it('skips projects when includeProjects is false', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { top: { command: 't' } },
        projects: {
          '/path/to/proj': { mcpServers: { proj1: { command: 'p' } } },
        },
      }),
    )
    const out = await loadClaudeCodeConfig({ configPath, includeProjects: false })
    expect(out.map(s => s.name)).toEqual(['top'])
  })
})
