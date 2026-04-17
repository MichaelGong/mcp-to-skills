# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Pre-1.0: minor versions may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-04-17

### Added
- `list` / `sync` / `install` commands
- Discover MCP servers from `~/.claude.json` (top-level and `projects[*]`)
- Support for stdio, Streamable HTTP, and SSE transports
- Renders each server to `SKILL.md` + `tools/<name>.json`
- Per-server (`mcp.json`) and aggregate (`mcp-backup.json`) config backups
- Interactive `install` flow for Claude Code / Cursor skill folders
- Library exports for programmatic use
- Vitest test suite covering config parsing, skill rendering, sanitization, and install
- GitHub Actions CI on Node 20 / 22 (Ubuntu + macOS)

### Security
- `sync` redacts `env` / `headers` values in backups by default
  (use `--no-redact-env` to opt out)
- `skills/` is git-ignored to prevent accidental commit of token-bearing backups

[Unreleased]: https://github.com/MichaelGong/mcp-to-skills/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MichaelGong/mcp-to-skills/releases/tag/v0.1.0
