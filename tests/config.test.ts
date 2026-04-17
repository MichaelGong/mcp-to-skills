import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadClaudeCodeConfig, loadLocalMcpConfigs } from '../src/config'

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

  it('skips projects[*].mcpServers by default', async () => {
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
    expect(out.map(s => s.name)).toEqual(['top'])
  })

  it('includes projects[*].mcpServers when includeProjects is true', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: { top: { command: 't' } },
        projects: {
          '/path/to/proj': { mcpServers: { proj1: { command: 'p' } } },
        },
      }),
    )
    const out = await loadClaudeCodeConfig({ configPath, includeProjects: true })
    expect(out).toHaveLength(2)
    const proj = out.find(s => s.name === 'proj1')
    expect(proj?.source).toBe('claude-code:project:/path/to/proj')
  })
})

describe('loadLocalMcpConfigs', () => {
  it('returns empty array when neither file exists', async () => {
    const out = await loadLocalMcpConfigs({ cwd: tmpDir })
    expect(out).toEqual([])
  })

  it('parses <cwd>/.mcp.json', async () => {
    const file = path.join(tmpDir, '.mcp.json')
    await fs.writeFile(
      file,
      JSON.stringify({ mcpServers: { figma: { type: 'http', url: 'http://x' } } }),
    )
    const out = await loadLocalMcpConfigs({ cwd: tmpDir })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('figma')
    expect(out[0].source).toBe(`claude-code:project:${file}`)
  })

  it('parses <cwd>/.cursor/mcp.json', async () => {
    const dir = path.join(tmpDir, '.cursor')
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'mcp.json')
    await fs.writeFile(
      file,
      JSON.stringify({ mcpServers: { context7: { command: 'c7' } } }),
    )
    const out = await loadLocalMcpConfigs({ cwd: tmpDir })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('context7')
    expect(out[0].source).toBe(`cursor:project:${file}`)
  })

  it('reads both files and merges them', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
    )
    await fs.mkdir(path.join(tmpDir, '.cursor'), { recursive: true })
    await fs.writeFile(
      path.join(tmpDir, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { b: { command: 'b' } } }),
    )
    const out = await loadLocalMcpConfigs({ cwd: tmpDir })
    expect(out.map(s => s.name).sort()).toEqual(['a', 'b'])
  })

  it('dedupes when .cursor/mcp.json is a symlink to .mcp.json', async () => {
    const real = path.join(tmpDir, '.mcp.json')
    await fs.writeFile(
      real,
      JSON.stringify({ mcpServers: { only: { command: 'o' } } }),
    )
    await fs.mkdir(path.join(tmpDir, '.cursor'), { recursive: true })
    await fs.symlink('../.mcp.json', path.join(tmpDir, '.cursor', 'mcp.json'))
    const out = await loadLocalMcpConfigs({ cwd: tmpDir })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('only')
  })

  it('throws a useful error on malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, '.mcp.json'), '{not json')
    await expect(loadLocalMcpConfigs({ cwd: tmpDir })).rejects.toThrow(/Failed to parse/)
  })
})
