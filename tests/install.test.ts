import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSkills, listSkillDirs } from '../src/skill'

let tmpDir: string
let from: string
let to: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-to-skills-install-'))
  from = path.join(tmpDir, 'src-skills')
  to = path.join(tmpDir, 'target')
  await fs.mkdir(path.join(from, 'alpha'), { recursive: true })
  await fs.writeFile(path.join(from, 'alpha', 'SKILL.md'), '# alpha\n')
  await fs.mkdir(path.join(from, 'beta'), { recursive: true })
  await fs.writeFile(path.join(from, 'beta', 'SKILL.md'), '# beta\n')
  // Decoy: directory without SKILL.md should be ignored.
  await fs.mkdir(path.join(from, 'not-a-skill'), { recursive: true })
  await fs.writeFile(path.join(from, 'not-a-skill', 'note.txt'), 'ignore me\n')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('listSkillDirs', () => {
  it('returns only directories that contain a SKILL.md', async () => {
    expect(await listSkillDirs(from)).toEqual(['alpha', 'beta'])
  })

  it('returns empty array if the source does not exist', async () => {
    expect(await listSkillDirs(path.join(tmpDir, 'nope'))).toEqual([])
  })
})

describe('installSkills', () => {
  it('copies all skill dirs into a fresh target', async () => {
    const report = await installSkills(from, to)
    expect(report.copied.sort()).toEqual(['alpha', 'beta'])
    expect(report.skipped).toEqual([])
    expect(await fs.readFile(path.join(to, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n')
  })

  it('skips existing dirs without --overwrite', async () => {
    await fs.mkdir(path.join(to, 'alpha'), { recursive: true })
    await fs.writeFile(path.join(to, 'alpha', 'SKILL.md'), '# old\n')

    const report = await installSkills(from, to)
    expect(report.copied).toEqual(['beta'])
    expect(report.skipped.map(s => s.name)).toEqual(['alpha'])
    expect(await fs.readFile(path.join(to, 'alpha', 'SKILL.md'), 'utf8')).toBe('# old\n')
  })

  it('overwrites when overwrite=true', async () => {
    await fs.mkdir(path.join(to, 'alpha'), { recursive: true })
    await fs.writeFile(path.join(to, 'alpha', 'SKILL.md'), '# old\n')

    const report = await installSkills(from, to, { overwrite: true })
    expect(report.copied.sort()).toEqual(['alpha', 'beta'])
    expect(await fs.readFile(path.join(to, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n')
  })

  it('dry-run does not touch the disk', async () => {
    const report = await installSkills(from, to, { dryRun: true })
    expect(report.copied.sort()).toEqual(['alpha', 'beta'])
    await expect(fs.stat(to)).rejects.toThrow()
  })
})
