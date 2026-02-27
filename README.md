# MCP Doctor

**Diagnose, optimize, and manage MCP servers across all coding agents.**

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

### As an MCP Server (Universal Agent Access)

**The meta play:** mcp-doctor IS an MCP server. Any agent that supports MCP can self-diagnose.

```bash
# Add to Claude Code
claude mcp add mcp-doctor -- npx -y @frankxai/mcp-doctor serve

# Add to Cursor (.cursor/mcp.json)
# Add to Cline (cline_mcp_settings.json)
# Add to Windsurf (mcp_config.json)
{
  "mcpServers": {
    "mcp-doctor": {
      "command": "npx",
      "args": ["-y", "@frankxai/mcp-doctor", "serve"]
    }
  }
}
```

Exposes 4 tools: `audit`, `detect_agents`, `find_misplaced`, `recommend`.

### For Claude Code (SessionStart Hook)

Auto-check MCP health on every new session:

```json
// .claude/settings.json → hooks.SessionStart
{
  "type": "command",
  "command": "bash .claude/hooks/mcp-doctor-check.sh",
  "timeout": 8
}
```

Or use the programmatic API:

```typescript
import { scanAllServers, findDuplicates, findMisplacedConfigs, checkAllServers, analyzeTiers, redactSecrets } from "@frankxai/mcp-doctor";

const servers = scanAllServers();
const health = await checkAllServers(servers, { quick: true });
const tiers = analyzeTiers(servers, health);
```

### Multi-Agent Support

Detects and reads MCP configs from all major coding agents:

```bash
npx @frankxai/mcp-doctor agents
```

| Agent | Config Location | Key | Supported |
|-------|----------------|-----|-----------|
| Claude Code | `~/.claude.json` | `mcpServers` | Yes |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | Yes |
| Cline | `globalStorage/.../cline_mcp_settings.json` | `mcpServers` | Yes |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | Yes |
| VS Code | `~/.config/Code/User/mcp.json` | `servers` | Yes |

Config differences are normalized automatically (VS Code's `servers` key, Windsurf's `serverUrl` field, etc.).

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
