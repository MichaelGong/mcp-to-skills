import type { DiscoveryResult } from '../src/types'
import { describe, expect, it } from 'vitest'
import { renderSkill, sanitizeEntry } from '../src/skill'

function makeResult(over: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    serverName: 'demo',
    source: 'claude-code:/tmp/.claude.json',
    entry: { command: '/usr/bin/demo', args: ['--port', '4000'] },
    ok: true,
    serverInfo: { name: 'Demo', version: '1.2.3' },
    instructions: 'Demo MCP server. Use to do demo things.',
    tools: [
      {
        name: 'do_thing',
        description: 'Perform the canonical demo action.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target to act on' },
          },
          required: ['target'],
        },
      },
    ],
    ...over,
  }
}

describe('renderSkill', () => {
  it('emits valid frontmatter with name and description', () => {
    const md = renderSkill(makeResult())
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toMatch(/^name: demo$/m)
    expect(md).toMatch(/^description: /m)
    expect(md).toContain('# demo')
    expect(md).toContain('## Tools')
    expect(md).toContain('### `do_thing`')
    expect(md).toContain('| `target` | string | yes |')
  })

  it('falls back to a synthesized description when instructions are missing', () => {
    const md = renderSkill(makeResult({ instructions: undefined }))
    expect(md).toMatch(/MCP server \\?"demo\\?" exposes tools to:/)
    expect(md).toContain('`do_thing`')
  })

  it('marks empty tool list explicitly', () => {
    const md = renderSkill(makeResult({ tools: [], instructions: undefined }))
    expect(md).toContain('_No tools exposed._')
  })

  it('quotes name strings that contain colons', () => {
    const md = renderSkill(makeResult({ serverName: 'name:with:colons' }))
    expect(md).toMatch(/^name: "name:with:colons"$/m)
  })
})

describe('sanitizeEntry', () => {
  it('redacts env values for stdio entries when asked', () => {
    const out = sanitizeEntry(
      { command: 'svc', env: { TOKEN: 'sk-secret', OK: 'ok' } },
      { redactEnv: true },
    )
    expect(out).toEqual({ command: 'svc', env: { TOKEN: '***', OK: '***' } })
  })

  it('redacts headers for HTTP entries when asked', () => {
    const out = sanitizeEntry(
      { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer xxx' } },
      { redactEnv: true },
    )
    expect(out).toEqual({
      type: 'http',
      url: 'https://x',
      headers: { Authorization: '***' },
    })
  })

  it('returns a deep clone (mutation-safe)', () => {
    const original = { command: 'svc', env: { K: 'v' } }
    const out = sanitizeEntry(original, { redactEnv: false })
    ;(out as any).env.K = 'changed'
    expect(original.env.K).toBe('v')
  })

  it('passes through when redactEnv is false', () => {
    const out = sanitizeEntry(
      { command: 'svc', env: { TOKEN: 'sk-secret' } },
      { redactEnv: false },
    )
    expect(out).toEqual({ command: 'svc', env: { TOKEN: 'sk-secret' } })
  })
})
