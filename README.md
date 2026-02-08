# MCP Doctor

**Diagnose, optimize, and manage your Claude Code MCP servers.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/mcp-doctor.svg)](https://www.npmjs.com/package/mcp-doctor)

---

## The Problem

You install a few MCP servers for Claude Code. Then a few more. Plugins auto-install some. Claude.ai connectors add others silently. Before you know it, you have **18 MCP servers** loading every session — half of them broken, duplicated, or unconfigured.

Every broken server adds seconds to your startup. Every misconfigured one wastes tokens when Claude tries and fails to use it. And there's no tooling to tell you what's wrong.

**MCP Doctor fixes that.**

## Quick Start

```bash
npx mcp-doctor audit
```

That's it. One command scans your entire Claude Code configuration, checks every MCP server across all scopes, and gives you a full health report with actionable fix commands.

## What It Does

### Health Audit

Scans `~/.claude.json` across all project scopes and checks:

- Server connectivity (spawns each stdio server and tests the MCP handshake)
- Missing or placeholder environment variables (`YOUR_API_KEY_HERE`)
- Duplicate registrations across scopes (user, project-local, .mcp.json)
- Command availability in PATH

```
  HEALTH REPORT
  ──────────────────────────────────────────────────
  ✓ playwright [user]
  ✓ memory [project-local]
  ✓ nanobanana [project-local]
  ⚠ grok [project-local]    XAI_API_KEY not configured
  ⚠ replicate [project-local] REPLICATE_API_TOKEN not configured
  ✗ my-server [project-local] Exited with code 1: Module not found

  4 healthy  1 broken  2 missing config  0 skipped
```

### Duplicate Detection

Finds servers registered multiple times across different scopes:

```
  DUPLICATES FOUND
  ──────────────────────────────────────────────────
  ⚠ nanobanana registered 4x:
    → project-local (my-project)
    → project-local (other-project)
    → project-local (System32)
    → project-local (system32)

  Tip: Duplicates waste startup time. Keep one per scope.
```

### Tier Recommendations

Categorizes every server into **always-on**, **on-demand**, or **remove**:

```
  TIER RECOMMENDATIONS
  ──────────────────────────────────────────────────

  Always-On (load every session)
  ● playwright — Core utility — useful in nearly every session
  ● memory — Core utility — useful in nearly every session

  On-Demand (add when needed)
  ◐ nanobanana — Useful but not every session
  ◐ sequential-thinking — Useful but not every session
  ◐ lyric-genius — Workflow-specific — add only for relevant sessions

  Remove (broken or misconfigured)
  ✗ grok — Missing environment variable: XAI_API_KEY not configured
```

### Fix Commands

Generates copy-paste-ready commands to clean up your setup:

```
  SUGGESTED FIX COMMANDS
  ──────────────────────────────────────────────────

  # Remove broken/misconfigured servers:
  claude mcp remove grok
  claude mcp remove replicate

  # On-demand commands (save for when needed):
  claude mcp add nanobanana -e GEMINI_API_KEY=AIza...EgP4 -- uvx nanobanana-mcp-server@latest
  claude mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking
```

### Health Score

A single number that tells you how clean your MCP setup is:

```
  SCORE
  ──────────────────────────────────────────────────
  MCP Health Score: 85/100

  8 total servers | 7 healthy | 0 duplicates | 1 should remove
```

## Commands

### `audit`

Full health check of all MCP servers.

```bash
# Full audit (spawns each server to test connectivity)
npx mcp-doctor audit

# Quick mode (config validation only, no spawning — instant)
npx mcp-doctor audit --quick

# Filter to a specific project
npx mcp-doctor audit --project my-project
```

### `recommend`

Browse curated MCP preset packs for your workflow.

```bash
# List all available presets
npx mcp-doctor recommend

# Get details + install commands for a specific pack
npx mcp-doctor recommend web-developer
npx mcp-doctor recommend ai-architect
```

## Preset Packs

Pre-configured MCP stacks for common workflows. Each pack specifies which servers to run always-on vs. on-demand.

| Pack | Description | Always-On | On-Demand |
|------|-------------|-----------|-----------|
| `web-developer` | Next.js, Vercel, testing | 2 | 1 |
| `content-creator` | Blogging, images, email | 2 | 1 |
| `data-engineer` | Databases, APIs, pipelines | 2 | 1 |
| `music-producer` | AI music, lyrics, audio | 1 | 2 |
| `ai-architect` | Agents, multi-model systems | 3 | 1 |
| `devops` | CI/CD, infrastructure, containers | 2 | 1 |
| `mobile-dev` | React Native, Flutter, native | 1 | 2 |
| `researcher` | Academic, technical writing | 2 | 1 |
| `security` | Auditing, pen testing, compliance | 2 | 1 |
| `minimal` | Just the essentials | 1 | 0 |

Example output for `npx mcp-doctor recommend ai-architect`:

```
  AI Architect
  Building AI systems, agents, and multi-model orchestration

  Servers:
  ● playwright (always-on)
    Testing AI interfaces, scraping docs, validating outputs
  ● memory (always-on)
    Track architecture decisions, model configs, and system patterns
  ● sequential-thinking (always-on)
    Multi-step reasoning for agent design and system architecture
  ◐ browser-use (on-demand)
    Visual browser agent for testing AI UIs and design tools like v0.dev

  Install commands:
  claude mcp add playwright -- npx -y @playwright/mcp
  claude mcp add memory -- npx -y @modelcontextprotocol/server-memory
  claude mcp add sequential-thinking -- npx -y @modelcontextprotocol/server-sequential-thinking
  claude mcp add browser-use -- uvx --from browser-use[cli] browser-use --mcp
```

## How It Works

MCP Doctor reads your Claude Code configuration from `~/.claude.json`, which stores MCP server definitions across multiple scopes:

1. **User scope** — Global servers available in all projects
2. **Project-local scope** — Servers specific to a project directory
3. **.mcp.json** — Project-level config files checked into repos

For each server found, it:
- Validates the configuration structure
- Checks that required commands exist in PATH
- Detects placeholder environment variables
- (Full mode) Spawns the process and sends an MCP `initialize` handshake
- Cross-references against a database of known MCP servers for tier recommendations

API keys found in configs are automatically masked in output (`AIza...EgP4`).

## MCP Scope Explained

If you're confused about where your servers are configured, here's the hierarchy:

```
~/.claude.json
├── mcpServers: {}              ← User scope (all projects)
└── projects:
    ├── /path/to/project-a:
    │   └── mcpServers: {}      ← Project-local scope
    └── /path/to/project-b:
        └── mcpServers: {}      ← Project-local scope

/path/to/project/.mcp.json     ← Shared project scope (committed to git)
```

Servers in **user scope** load in every session. Servers in **project-local scope** only load when you're in that directory. Duplicates across scopes waste startup time.

## Contributing

Contributions welcome. Some ideas:

- **New preset packs** — Add presets for your workflow in `src/analyzer/presets.ts`
- **Known server database** — Expand the tier-optimizer's knowledge of common MCP servers
- **MCP server mode** — Run mcp-doctor as an MCP server itself (meta!)
- **Auto-fix** — Apply recommendations automatically with `--fix` flag

```bash
git clone https://github.com/frankxai/mcp-doctor
cd mcp-doctor
npm install
npm run build
node dist/cli.js audit --quick
```

## Why This Exists

I had 18 MCP servers loading every Claude Code session. Eight were broken, duplicated, or unconfigured. Five had placeholder API keys. Startup was slow, tools failed silently, and there was no way to know what was wrong without manually inspecting a 1000-line JSON config.

So I built a doctor.

## License

MIT
