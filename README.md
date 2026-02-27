# MCP Doctor

**Diagnose, optimize, and manage your Claude Code MCP servers.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@frankxai/mcp-doctor.svg)](https://www.npmjs.com/package/@frankxai/mcp-doctor)

---

## The Problem

You install a few MCP servers for Claude Code. Then a few more. Plugins auto-install some. Claude.ai connectors add others silently. Before you know it, you have **18 MCP servers** loading every session — half of them broken, duplicated, or unconfigured.

Every broken server adds seconds to your startup. Every misconfigured one wastes tokens when Claude tries and fails to use it. And there's no tooling to tell you what's wrong.

**MCP Doctor fixes that.**

## Quick Start

```bash
npx @frankxai/mcp-doctor audit
```

That's it. One command scans your entire Claude Code configuration, checks every MCP server across all scopes, and gives you a full health report with actionable fix commands.

## Usage

### For Humans (CLI)

```bash
# Full health check — spawns each server, tests MCP handshake
npx @frankxai/mcp-doctor audit

# Quick mode — config-only, instant (no spawning)
npx @frankxai/mcp-doctor audit --quick

# Filter to a specific project
npx @frankxai/mcp-doctor audit --project my-project

# Browse curated MCP preset packs
npx @frankxai/mcp-doctor recommend
npx @frankxai/mcp-doctor recommend ai-architect
```

### For Claude Code (Agent Integration)

Add mcp-doctor as a slash command so Claude can self-diagnose MCP issues:

```bash
# Install globally for any session
npm install -g @frankxai/mcp-doctor

# Run from within a Claude Code session
mcp-doctor audit --quick
```

Or use the programmatic API inside a Claude Code hook or skill:

```typescript
import {
  scanAllServers,
  findDuplicates,
  findMisplacedConfigs,
  checkAllServers,
  analyzeTiers,
  redactSecrets,
} from "@frankxai/mcp-doctor";

// Scan and check
const servers = scanAllServers();
const health = await checkAllServers(servers, { quick: true });
const duplicates = findDuplicates(servers);
const misplaced = findMisplacedConfigs();
const tiers = analyzeTiers(servers, health);

// Safe to log — secrets are redacted
const message = redactSecrets(someErrorOutput, serverEnv);
```

### For Other Coding Agents (Cursor, Windsurf, etc.)

MCP Doctor currently reads `~/.claude.json` which is Claude Code's config format. Other agents store MCP configs differently:

| Agent | Config Location | Supported |
|-------|----------------|-----------|
| Claude Code | `~/.claude.json` | Yes |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | Planned |
| Cursor | `.cursor/mcp.json` | Planned |
| Windsurf | `.windsurf/mcp.json` | Planned |
| VS Code + Copilot | `.vscode/mcp.json` | Planned |

The core scanning/health-check logic is agent-agnostic — only `config-reader.ts` needs to know where configs live. PRs adding other agent support are welcome.

## What It Does

### Misplaced Config Detection

The **#1 MCP misconfiguration**: putting `mcpServers` in `settings.json` instead of `.claude.json`. Claude Code silently ignores them. MCP Doctor catches this:

```
  ⚠ MISPLACED MCP CONFIGS (CRITICAL)
  ──────────────────────────────────────────────────

  Claude Code IGNORES mcpServers in settings.json files!
  MCP servers must be in ~/.claude.json (use: claude mcp add)

  ✗ /home/user/.claude/settings.json
    These servers are configured but NEVER loaded:
      - my-server
      - other-server

  How to fix:
  1. Remove mcpServers from settings.json
  2. Re-add each server with: claude mcp add <name> -e KEY=val -- <command>
  3. Verify with: /mcp in Claude Code
```

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
  claude mcp add nanobanana -e GEMINI_API_KEY=AIza... -- uvx nanobanana-mcp-server@latest
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

## Security

MCP Doctor reads your `~/.claude.json` which contains API keys and tokens. Here's how we protect them:

- **Secret redaction**: All output passes through `redactSecrets()` — known env values and 9 common API key regex patterns are replaced with `[REDACTED:KEY_NAME]`
- **Safe env inheritance**: Spawned processes only receive safe system vars (`PATH`, `HOME`, etc.) + the server's own declared env — not your full `process.env`
- **No network access**: MCP Doctor never sends data anywhere. It reads local config and spawns local processes only
- **Zero dependencies**: No supply chain risk from transitive dependencies

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## How It Works

MCP Doctor reads your Claude Code configuration from `~/.claude.json`, which stores MCP server definitions across multiple scopes:

1. **User scope** — Global servers available in all projects
2. **Project-local scope** — Servers specific to a project directory
3. **.mcp.json** — Project-level config files checked into repos

For each server found, it:
- Validates the configuration structure
- Checks that required commands exist in PATH
- Detects placeholder environment variables
- Scans `settings.json` files for misplaced MCP configs
- (Full mode) Spawns the process and sends an MCP `initialize` handshake
- Cross-references against a database of known MCP servers for tier recommendations

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

> **Common mistake**: Putting `mcpServers` in `~/.claude/settings.json` — Claude Code ignores them there. MCP Doctor detects this and tells you how to fix it.

## Contributing

Contributions welcome. Some ideas:

- **Multi-agent support** — Add config readers for Cursor, Windsurf, VS Code Copilot
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
