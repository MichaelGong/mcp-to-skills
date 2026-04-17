#!/usr/bin/env node
import type { DiscoveredServer } from './types'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { cancel, confirm, intro, isCancel, log, multiselect, outro, select, text } from '@clack/prompts'
import pc from 'picocolors'
import { loadClaudeCodeConfig, loadLocalMcpConfigs } from './config'
import { discoverAll } from './discover'
import { installSkills, listSkillDirs, writeAggregateBackup, writeServerBackup, writeSkill } from './skill'

const DEFAULT_INSTALL_TARGET = path.join(os.homedir(), '.claude', 'skills')
const BIN = 'mcp-to-skills'

function readPkgVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const require_ = createRequire(import.meta.url)
    // dist/cli.js -> ../package.json (when published) or ../package.json (when run via tsx)
    for (const candidate of [path.join(here, '..', 'package.json'), path.join(here, '..', '..', 'package.json')]) {
      try {
        const pkg = require_(candidate) as { version?: string }
        if (pkg.version)
          return pkg.version
      }
      catch {}
    }
  }
  catch {}
  return '0.0.0'
}

const VERSION = readPkgVersion()

const USAGE = `${BIN} v${VERSION} - explore MCP servers from ~/.claude.json and convert to Skills

Usage:
  ${BIN} list     [options]   List discovered servers and their tools
  ${BIN} sync     [options]   Write SKILL.md + config backup to <out>/<server>/
  ${BIN} install  [options]   Copy generated skills to a target dir
                              (default target: ${DEFAULT_INSTALL_TARGET})
  ${BIN} setup    [options]   Interactive one-shot wizard:
                              discover -> pick MCPs -> generate -> pick skills
                              -> pick install target. Confirms between steps.

Discovery options:
  --config <path>      Global config file (default: ~/.claude.json)
                       Only the top-level mcpServers field is read.
  --cwd <dir>          Directory to scan for project-level configs
                       (default: current working directory). Reads
                       <cwd>/.mcp.json and <cwd>/.cursor/mcp.json.
  --no-global          Skip the global config file
  --no-local           Skip <cwd>/.mcp.json and <cwd>/.cursor/mcp.json
  --include-projects   Also read projects[*].mcpServers from the
                       global config (off by default)
  --out, -o <dir>      Output directory for sync (default: ./skills)
  --timeout <ms>       Per-request timeout (default: 15000)
  --concurrency <n>    Parallel server probes (default: 4)
  --no-schemas         Do not emit per-tool JSON schemas alongside SKILL.md
  --no-backup          Do not write mcp.json / mcp-backup.json config snapshots

Backup safety:
  --no-redact-env      Keep raw env / headers values in backups
                       (default: redact secrets to "***")

Install-only options:
  --from <dir>         Source directory of generated skills (default: ./skills)
  --to <dir>           Target directory; if omitted you are prompted.
                       Default suggestion: ${DEFAULT_INSTALL_TARGET}
  --yes, -y            Skip prompt, accept the default target
  --overwrite          Replace existing <target>/<server>/ directories
  --dry-run            Show what would be copied without touching disk

Misc:
  --version, -v        Print version and exit
  --help, -h           Show this help
`

const OPTIONS = {
  'config': { type: 'string' },
  'cwd': { type: 'string' },
  // Both sources are on by default; pass --no-global / --no-local to skip.
  'no-global': { type: 'boolean', default: false },
  'no-local': { type: 'boolean', default: false },
  'include-projects': { type: 'boolean', default: false },
  'out': { type: 'string', short: 'o', default: 'skills' },
  'timeout': { type: 'string', default: '15000' },
  'concurrency': { type: 'string', default: '4' },
  'no-schemas': { type: 'boolean', default: false },
  'no-backup': { type: 'boolean', default: false },
  // `--no-redact-env` flips this to false; default is "redact" for safety.
  'redact-env': { type: 'boolean', default: true },
  'from': { type: 'string' },
  'to': { type: 'string' },
  'yes': { type: 'boolean', short: 'y', default: false },
  'overwrite': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  'version': { type: 'boolean', short: 'v', default: false },
  'help': { type: 'boolean', short: 'h', default: false },
} as const

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs<{
    options: typeof OPTIONS
    allowPositionals: true
    strict: true
  }>>
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    })
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }

  const { values, positionals } = parsed
  const cmd = positionals[0] ?? 'list'

  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (values.help || cmd === 'help') {
    process.stdout.write(USAGE)
    return
  }

  if (cmd === 'install') {
    await runInstall(values)
    return
  }

  if (cmd === 'setup') {
    await runSetup(values)
    return
  }

  const servers = await collectServers(values)

  if (servers.length === 0) {
    process.stderr.write(
      'No MCP servers found.\n'
      + '  - Looked in: ~/.claude.json (top-level mcpServers)\n'
      + '  - Looked in: <cwd>/.mcp.json and <cwd>/.cursor/mcp.json\n'
      + '  - Pass --include-projects to also read ~/.claude.json projects[*].mcpServers,\n'
      + '    or --config <path> to use a different global config file.\n',
    )
    process.exitCode = 1
    return
  }

  const timeoutMs = Number(values.timeout)
  const concurrency = Number(values.concurrency)

  if (cmd === 'list') {
    process.stderr.write(`Discovered ${servers.length} server(s). Probing...\n\n`)
    const results = await discoverAll(servers, { timeoutMs, concurrency })
    for (const r of results) {
      const tag = r.ok ? `OK (${r.tools.length} tools)` : `FAIL (${r.error})`
      process.stdout.write(`- ${r.serverName} [${tag}]  <- ${r.source}\n`)
      for (const t of r.tools) {
        const desc = (t.description ?? '').split('\n')[0].trim()
        process.stdout.write(`    - ${t.name}${desc ? `: ${desc}` : ''}\n`)
      }
    }
    return
  }

  if (cmd === 'sync') {
    const outDir = path.resolve(values.out ?? 'skills')
    const writeBackup = !values['no-backup']
    // Default: redact. Pass --no-redact-env to keep raw values.
    const redactEnv = values['redact-env'] !== false
    process.stderr.write(`Writing skills to ${outDir}\n\n`)

    const results = await discoverAll(servers, { timeoutMs, concurrency })
    let skillCount = 0
    let skipSkill = 0
    let backupCount = 0

    for (const r of results) {
      const rel = (p: string): string => path.relative(process.cwd(), p)

      if (writeBackup) {
        const bp = await writeServerBackup(r, outDir, { redactEnv })
        backupCount++
        process.stdout.write(`~ backup ${r.serverName} -> ${rel(bp)}\n`)
      }

      if (!r.ok) {
        skipSkill++
        process.stderr.write(`! skip SKILL.md for ${r.serverName}: ${r.error}\n`)
        continue
      }

      const sp = await writeSkill(r, {
        outDir,
        writeRawSchemas: !values['no-schemas'],
      })
      skillCount++
      process.stdout.write(
        `+ skill  ${r.serverName} -> ${rel(sp)} (${r.tools.length} tools)\n`,
      )
    }

    if (writeBackup) {
      const configPath = values.config ?? path.join(os.homedir(), '.claude.json')
      const ap = await writeAggregateBackup(results, outDir, { configPath, redactEnv })
      process.stdout.write(`= aggregate backup -> ${path.relative(process.cwd(), ap)}\n`)
    }

    process.stderr.write(
      `\nDone. ${skillCount} SKILL.md written, ${skipSkill} skipped, ${backupCount} configs backed up.\n`,
    )
    if (redactEnv)
      process.stderr.write('Note: env / headers redacted in backups (default). Pass --no-redact-env to keep raw values.\n')
    else
      process.stderr.write(pc.yellow('Warning: backups contain raw env / headers values. Do NOT commit or share them.\n'))
    return
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`)
  process.exitCode = 2
}

interface DiscoveryCliOptions {
  'config'?: string
  'cwd'?: string
  'no-global'?: boolean
  'no-local'?: boolean
  'include-projects'?: boolean
}

/**
 * Combine MCP servers from the global config (~/.claude.json by default,
 * top-level mcpServers only) with project-level servers declared in the
 * current working directory (<cwd>/.mcp.json and <cwd>/.cursor/mcp.json).
 *
 * Either source can be turned off with `--no-global` / `--no-local`.
 */
async function collectServers(values: DiscoveryCliOptions): Promise<DiscoveredServer[]> {
  const out: DiscoveredServer[] = []

  if (!values['no-global']) {
    out.push(...await loadClaudeCodeConfig({
      configPath: values.config,
      includeProjects: !!values['include-projects'],
    }))
  }

  if (!values['no-local']) {
    const cwd = values.cwd ? path.resolve(expandHome(values.cwd)) : process.cwd()
    out.push(...await loadLocalMcpConfigs({ cwd }))
  }

  return out
}

/** Expand a leading `~` or `~/` to the user's home directory. */
function expandHome(input: string): string {
  if (input === '~')
    return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\'))
    return path.join(os.homedir(), input.slice(2))
  return input
}

/** Bail out cleanly when the user cancels a clack prompt (Ctrl+C / Esc). */
function bailIfCancelled<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Aborted.')
    process.exit(0)
  }
}

interface TargetChoice {
  label: string
  value: string
  hint?: string
}

/**
 * Build the list of well-known target directories. The first one is the
 * "default" Claude Code global skills folder; "custom" lets the user type
 * any path.
 */
function buildTargetChoices(): { choices: TargetChoice[], custom: string } {
  const customSentinel = '__custom__'
  const choices: TargetChoice[] = [
    {
      label: 'Claude Code (global)',
      value: DEFAULT_INSTALL_TARGET,
      hint: DEFAULT_INSTALL_TARGET,
    },
    {
      label: 'Claude Code (project)',
      value: path.join(process.cwd(), '.claude', 'skills'),
      hint: path.join('.claude', 'skills'),
    },
    {
      label: 'Cursor (global)',
      value: path.join(os.homedir(), '.cursor', 'skills'),
      hint: path.join(os.homedir(), '.cursor', 'skills'),
    },
    {
      label: 'Custom path…',
      value: customSentinel,
      hint: 'enter your own',
    },
  ]
  return { choices, custom: customSentinel }
}

/** Interactive target picker backed by @clack/prompts. */
async function promptTarget(defaultPath: string): Promise<string> {
  const { choices, custom } = buildTargetChoices()
  const picked = await select<string>({
    message: 'Where do you want to install the skills?',
    initialValue: defaultPath,
    options: choices.map(c => ({ value: c.value, label: c.label, hint: c.hint })),
  })
  bailIfCancelled(picked)

  if (picked !== custom)
    return picked

  const typed = await text({
    message: 'Enter target directory',
    placeholder: defaultPath,
    defaultValue: defaultPath,
    validate: (value) => {
      if (value && !path.isAbsolute(expandHome(value)) && !value.startsWith('.'))
        return 'Please provide an absolute path, a `~/...` path, or a relative `./...` path.'
    },
  })
  bailIfCancelled(typed)
  return path.resolve(expandHome(typed || defaultPath))
}

interface InstallCliOptions {
  'from'?: string
  'to'?: string
  'yes'?: boolean
  'overwrite'?: boolean
  'dry-run'?: boolean
}

async function runInstall(values: InstallCliOptions): Promise<void> {
  const from = path.resolve(values.from ?? 'skills')
  const dryRun = !!values['dry-run']
  let overwrite = !!values.overwrite
  const interactive = process.stdin.isTTY && !values.yes && !values.to

  intro(pc.cyan(` ${BIN} install `))

  const available = await listSkillDirs(from)
  if (available.length === 0) {
    cancel(`No skills found under ${pc.bold(from)}. Run \`${BIN} sync\` first.`)
    process.exitCode = 1
    return
  }
  log.info(`Found ${pc.bold(String(available.length))} skill(s) in ${pc.dim(from)}`)

  let target: string
  if (values.to)
    target = path.resolve(expandHome(values.to))
  else if (interactive)
    target = await promptTarget(DEFAULT_INSTALL_TARGET)
  else
    target = DEFAULT_INSTALL_TARGET

  const conflicts: string[] = []
  for (const name of available) {
    const dst = path.join(target, name)
    const exists = await fs.stat(dst).then(() => true).catch(() => false)
    if (exists)
      conflicts.push(name)
  }

  if (conflicts.length > 0 && !overwrite) {
    if (interactive) {
      log.warn(
        `${conflicts.length} skill(s) already exist at the target: ${
          conflicts.map(n => pc.yellow(n)).join(', ')}`,
      )
      const ans = await confirm({
        message: 'Overwrite the existing skills?',
        initialValue: false,
      })
      bailIfCancelled(ans)
      overwrite = ans
    }
    else {
      log.warn(
        `${conflicts.length} skill(s) will be skipped because they already exist `
        + '(use --overwrite to replace).',
      )
    }
  }

  const report = await installSkills(from, target, { dryRun, overwrite })

  for (const name of report.copied) {
    log.success(
      `${dryRun ? pc.dim('[dry] ') : ''}${pc.green('+')} ${name} ${pc.dim('->')} ${path.join(target, name)}`,
    )
  }
  for (const { name, reason } of report.skipped)
    log.warn(`${pc.yellow('!')} skip ${name} ${pc.dim(`(${reason})`)}`)

  outro(
    `${pc.bold(String(report.copied.length))} installed, `
    + `${pc.bold(String(report.skipped.length))} skipped`
    + `${dryRun ? pc.dim('  (dry run, no files written)') : ''}`,
  )
}

interface SetupCliOptions
  extends DiscoveryCliOptions, InstallCliOptions {
  'out'?: string
  'timeout'?: string
  'concurrency'?: string
  'no-schemas'?: boolean
  'no-backup'?: boolean
  'redact-env'?: boolean
}

/**
 * One-shot interactive wizard: discover MCP servers, let the user pick which
 * ones to convert into skills, generate the skills, then pick which to install
 * and where. Each step has a confirmation; cancelling at any prompt aborts
 * cleanly. With `--yes`, sensible defaults are taken non-interactively
 * (all reachable servers, default output dir, default install target,
 * never overwrite).
 */
async function runSetup(values: SetupCliOptions): Promise<void> {
  const nonInteractive = !!values.yes || !process.stdin.isTTY
  intro(pc.cyan(` ${BIN} setup `))

  // ---- Step 1: discover -------------------------------------------------
  const servers = await collectServers(values)
  if (servers.length === 0) {
    cancel(
      'No MCP servers found.\n'
      + '  - Looked in: ~/.claude.json (top-level mcpServers)\n'
      + '  - Looked in: <cwd>/.mcp.json and <cwd>/.cursor/mcp.json\n'
      + '  - Pass --include-projects, or --config <path> to point elsewhere.',
    )
    process.exitCode = 1
    return
  }

  const timeoutMs = Number(values.timeout ?? '15000')
  const concurrency = Number(values.concurrency ?? '4')
  log.info(`Discovered ${pc.bold(String(servers.length))} server(s). Probing...`)
  const results = await discoverAll(servers, { timeoutMs, concurrency })
  const okCount = results.filter(r => r.ok).length
  log.info(`${pc.green(String(okCount))}/${results.length} reachable`)

  let selectedNames: string[]
  if (nonInteractive) {
    selectedNames = results.filter(r => r.ok).map(r => r.serverName)
  }
  else {
    const okNames = results.filter(r => r.ok).map(r => r.serverName)
    const picked = await multiselect<string>({
      message: 'Step 1/3 — pick MCP servers to turn into skills',
      options: results.map(r => ({
        value: r.serverName,
        label: r.ok
          ? `${r.serverName} ${pc.dim(`· ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}`)}`
          : `${r.serverName} ${pc.red('· FAIL')}`,
        hint: r.ok ? r.source : `${r.error} (${r.source})`,
      })),
      initialValues: okNames,
      required: false,
    })
    bailIfCancelled(picked)
    selectedNames = picked
  }

  if (selectedNames.length === 0) {
    cancel('No servers selected.')
    return
  }

  if (!nonInteractive) {
    const ok = await confirm({
      message: `Generate SKILL.md for ${pc.bold(String(selectedNames.length))} server(s)?`,
      initialValue: true,
    })
    bailIfCancelled(ok)
    if (!ok) {
      cancel('Aborted before generation.')
      return
    }
  }

  // ---- Step 2: generate -------------------------------------------------
  let outDir: string
  if (values.out) {
    outDir = path.resolve(expandHome(values.out))
  }
  else if (nonInteractive) {
    outDir = path.resolve('skills')
  }
  else {
    const typed = await text({
      message: 'Step 2/3 — directory to write generated skills',
      placeholder: './skills',
      defaultValue: 'skills',
    })
    bailIfCancelled(typed)
    outDir = path.resolve(expandHome(typed || 'skills'))
  }

  const writeBackup = !values['no-backup']
  const writeSchemas = !values['no-schemas']
  const redactEnv = values['redact-env'] !== false

  const selectedSet = new Set(selectedNames)
  const selectedResults = results.filter(r => selectedSet.has(r.serverName))
  const generated: string[] = []
  const rel = (p: string): string => path.relative(process.cwd(), p)

  for (const r of selectedResults) {
    if (writeBackup) {
      const bp = await writeServerBackup(r, outDir, { redactEnv })
      log.step(`backup ${pc.cyan(r.serverName)} ${pc.dim('->')} ${rel(bp)}`)
    }
    if (!r.ok) {
      log.warn(`skip SKILL.md for ${r.serverName}: ${r.error}`)
      continue
    }
    const sp = await writeSkill(r, { outDir, writeRawSchemas: writeSchemas })
    generated.push(r.serverName)
    log.success(
      `${pc.green('+')} skill ${pc.cyan(r.serverName)} ${pc.dim(`(${r.tools.length} tools)`)} ${pc.dim('->')} ${rel(sp)}`,
    )
  }

  if (writeBackup) {
    const configPath = values.config ?? path.join(os.homedir(), '.claude.json')
    const ap = await writeAggregateBackup(selectedResults, outDir, { configPath, redactEnv })
    log.step(`aggregate backup ${pc.dim('->')} ${rel(ap)}`)
    if (!redactEnv) {
      log.warn('Backups contain raw env / headers values. Do NOT commit or share them.')
    }
  }

  if (generated.length === 0) {
    cancel('No skills were generated; nothing to install.')
    return
  }

  // ---- Step 3: install --------------------------------------------------
  let toInstall: string[]
  if (nonInteractive) {
    toInstall = generated
  }
  else {
    const picked = await multiselect<string>({
      message: 'Step 3/3 — pick skills to install',
      options: generated.map(n => ({ value: n, label: n })),
      initialValues: generated,
      required: false,
    })
    bailIfCancelled(picked)
    toInstall = picked
  }

  if (toInstall.length === 0) {
    outro(`No skills selected to install. Generation kept under ${pc.dim(rel(outDir))}`)
    return
  }

  let target: string
  if (values.to)
    target = path.resolve(expandHome(values.to))
  else if (nonInteractive)
    target = DEFAULT_INSTALL_TARGET
  else
    target = await promptTarget(DEFAULT_INSTALL_TARGET)

  let overwrite = !!values.overwrite
  const conflicts: string[] = []
  for (const name of toInstall) {
    const dst = path.join(target, name)
    const exists = await fs.stat(dst).then(() => true).catch(() => false)
    if (exists)
      conflicts.push(name)
  }

  if (conflicts.length > 0 && !overwrite) {
    if (nonInteractive) {
      log.warn(
        `${conflicts.length} skill(s) will be skipped because they already exist `
        + '(use --overwrite to replace).',
      )
    }
    else {
      log.warn(
        `${conflicts.length} skill(s) already exist at the target: ${
          conflicts.map(n => pc.yellow(n)).join(', ')}`,
      )
      const ans = await confirm({
        message: 'Overwrite the existing skills?',
        initialValue: false,
      })
      bailIfCancelled(ans)
      overwrite = ans
    }
  }

  if (!nonInteractive) {
    const ok = await confirm({
      message: `Install ${pc.bold(String(toInstall.length))} skill(s) to ${pc.cyan(target)}?`,
      initialValue: true,
    })
    bailIfCancelled(ok)
    if (!ok) {
      cancel('Aborted before install.')
      return
    }
  }

  const dryRun = !!values['dry-run']
  const report = await installSkills(outDir, target, {
    dryRun,
    overwrite,
    names: toInstall,
  })

  for (const name of report.copied) {
    log.success(
      `${dryRun ? pc.dim('[dry] ') : ''}${pc.green('+')} ${name} ${pc.dim('->')} ${path.join(target, name)}`,
    )
  }
  for (const { name, reason } of report.skipped)
    log.warn(`${pc.yellow('!')} skip ${name} ${pc.dim(`(${reason})`)}`)

  outro(
    `${pc.bold(String(report.copied.length))} installed, `
    + `${pc.bold(String(report.skipped.length))} skipped`
    + `${dryRun ? pc.dim('  (dry run, no files written)') : ''}`,
  )
}

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`)
  process.exitCode = 1
})
