#!/usr/bin/env node
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { cancel, confirm, intro, isCancel, log, outro, select, text } from '@clack/prompts'
import pc from 'picocolors'
import { loadClaudeCodeConfig } from './config'
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

Discovery options:
  --config <path>      Config file to read (default: ~/.claude.json)
  --out, -o <dir>      Output directory for sync (default: ./skills)
  --timeout <ms>       Per-request timeout (default: 15000)
  --concurrency <n>    Parallel server probes (default: 4)
  --no-projects        Ignore projects[*].mcpServers in the config
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
  'out': { type: 'string', short: 'o', default: 'skills' },
  'timeout': { type: 'string', default: '15000' },
  'concurrency': { type: 'string', default: '4' },
  'no-projects': { type: 'boolean', default: false },
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

  const servers = await loadClaudeCodeConfig({
    configPath: values.config,
    includeProjects: !values['no-projects'],
  })

  if (servers.length === 0) {
    process.stderr.write('No MCP servers found in the config.\n')
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

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`)
  process.exitCode = 1
})
