#!/usr/bin/env node

/**
 * MCP Doctor as an MCP Server.
 * Any agent that supports MCP can add this server and self-diagnose.
 *
 * Usage:
 *   claude mcp add mcp-doctor -- npx @frankxai/mcp-doctor serve
 *
 * Exposes tools:
 *   - audit: Full or quick health check of all MCP servers
 *   - detect_agents: Show which coding agents are installed
 *   - find_misplaced: Check for misplaced MCP configs
 *   - recommend: Browse preset packs
 */

import { createInterface } from "readline";
import {
  scanAllServers,
  findDuplicates,
  findMisplacedConfigs,
} from "./scanner/config-reader.js";
import {
  checkAllServers,
  redactSecrets,
} from "./scanner/health-checker.js";
import { analyzeTiers } from "./analyzer/tier-optimizer.js";
import { listPresets, PRESETS } from "./analyzer/presets.js";
import {
  detectInstalledAgents,
  scanAllAgents,
} from "./scanner/multi-agent-reader.js";

// --- JSON-RPC types ---
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- MCP tool definitions ---
const TOOLS = [
  {
    name: "audit",
    description: "Run a health check on all MCP servers configured for Claude Code. Returns health status, duplicates, tier recommendations, and a health score. Use quick=true for config-only validation (instant), or quick=false to spawn each server and test the MCP handshake.",
    inputSchema: {
      type: "object" as const,
      properties: {
        quick: {
          type: "boolean" as const,
          description: "If true, only validate config (no spawning). Default: true.",
          default: true,
        },
        project: {
          type: "string" as const,
          description: "Filter to servers for a specific project path substring.",
        },
      },
    },
  },
  {
    name: "detect_agents",
    description: "Detect which coding agents (Claude Code, Cursor, Cline, Windsurf, VS Code) are installed on this system and how many MCP servers each has configured.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "find_misplaced",
    description: "Check for MCP servers incorrectly placed in settings.json files (Claude Code ignores these). This is the #1 MCP misconfiguration.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "recommend",
    description: "Get curated MCP preset packs for a specific workflow. Returns always-on and on-demand server recommendations with install commands.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pack: {
          type: "string" as const,
          description: "Preset pack name (e.g., 'web-developer', 'ai-architect', 'content-creator'). Omit to list all available packs.",
        },
      },
    },
  },
];

// --- Tool handlers ---
async function handleAudit(params: Record<string, unknown>): Promise<string> {
  const quick = params.quick !== false; // default true
  const projectFilter = params.project as string | undefined;

  const servers = scanAllServers(projectFilter);
  if (servers.length === 0) {
    return "No MCP servers found. Is Claude Code installed?\nExpected config at: ~/.claude.json";
  }

  const healthResults = await checkAllServers(servers, { quick });
  const duplicates = findDuplicates(servers);
  const tiers = analyzeTiers(servers, healthResults);
  const misplaced = findMisplacedConfigs();

  const healthy = healthResults.filter((r) => r.status === "healthy").length;
  const broken = healthResults.filter((r) => r.status === "broken" || r.status === "missing-command").length;
  const missingEnv = healthResults.filter((r) => r.status === "missing-env").length;
  const toRemove = tiers.filter((t) => t.recommendedTier === "remove");
  const score = Math.round(
    ((healthy - duplicates.size - toRemove.length) / Math.max(servers.length, 1)) * 100
  );

  const lines: string[] = [];
  lines.push(`## MCP Doctor Audit (${quick ? "quick" : "full"} mode)`);
  lines.push(`**${servers.length}** servers found | **${healthy}** healthy | **${broken}** broken | **${missingEnv}** missing config`);
  lines.push(`**Health Score: ${score}/100**\n`);

  // Misplaced configs
  if (misplaced.length > 0) {
    lines.push("### CRITICAL: Misplaced Configs");
    lines.push("Claude Code IGNORES mcpServers in settings.json files!\n");
    for (const m of misplaced) {
      lines.push(`- **${m.filePath}**: ${m.serverNames.join(", ")}`);
    }
    lines.push("Fix: Remove mcpServers from settings.json, re-add with `claude mcp add`\n");
  }

  // Health details
  lines.push("### Server Health");
  for (const result of healthResults) {
    const icon = result.status === "healthy" ? "OK" : result.status === "missing-env" ? "WARN" : "FAIL";
    const ms = result.responseTimeMs ? ` (${result.responseTimeMs}ms)` : "";
    const msg = result.status !== "healthy" ? ` — ${result.message}` : "";
    lines.push(`- [${icon}] **${result.server.name}** [${result.server.scope}]${ms}${msg}`);
  }

  // Duplicates
  if (duplicates.size > 0) {
    lines.push("\n### Duplicates");
    for (const [name, entries] of duplicates) {
      lines.push(`- **${name}** registered ${entries.length}x: ${entries.map((e) => e.scope + (e.projectPath ? ` (${e.projectPath.split("/").pop()})` : "")).join(", ")}`);
    }
  }

  // Tier recommendations
  lines.push("\n### Recommendations");
  const alwaysOn = tiers.filter((t) => t.recommendedTier === "always-on");
  const onDemand = tiers.filter((t) => t.recommendedTier === "on-demand");

  if (alwaysOn.length > 0) {
    lines.push("**Always-On** (load every session):");
    for (const t of alwaysOn) lines.push(`- ${t.server.name} — ${t.reason}`);
  }
  if (toRemove.length > 0) {
    lines.push("**Remove** (broken/misconfigured):");
    for (const t of toRemove) {
      lines.push(`- ${t.server.name} — ${t.reason}`);
      lines.push(`  Fix: \`claude mcp remove ${t.server.name}\``);
    }
  }
  if (onDemand.length > 0) {
    lines.push(`**On-Demand** (${onDemand.length} servers — add when needed)`);
  }

  return lines.join("\n");
}

function handleDetectAgents(): string {
  const agents = detectInstalledAgents();
  const otherAgents = scanAllAgents();

  if (agents.length === 0) {
    return "No coding agents with MCP configs detected on this system.";
  }

  const lines: string[] = ["## Installed Coding Agents with MCP\n"];

  for (const info of agents) {
    lines.push(`### ${info.agent}`);
    lines.push(`- Servers configured: **${info.serverCount}**`);
    if (info.globalPath) lines.push(`- Global config: \`${info.globalPath}\``);
    for (const pp of info.projectPaths) lines.push(`- Project config: \`${pp}\``);
    lines.push("");
  }

  // Show servers from other agents
  for (const { agent, servers } of otherAgents) {
    if (servers.length > 0) {
      lines.push(`### ${agent} servers`);
      for (const s of servers) {
        lines.push(`- **${s.name}** [${s.scope}] — ${s.config.command || s.config.url || "unknown"}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function handleFindMisplaced(): string {
  const misplaced = findMisplacedConfigs();

  if (misplaced.length === 0) {
    return "No misplaced MCP configs found. All configs are in the correct locations.";
  }

  const lines: string[] = [
    "## CRITICAL: Misplaced MCP Configs Found\n",
    "Claude Code IGNORES mcpServers in settings.json files!",
    "MCP servers must be in ~/.claude.json (use: `claude mcp add`)\n",
  ];

  for (const entry of misplaced) {
    lines.push(`### ${entry.filePath}`);
    lines.push("These servers are configured but NEVER loaded:");
    for (const name of entry.serverNames) {
      lines.push(`- ${name}`);
    }
    lines.push("");
  }

  lines.push("**Fix:**");
  lines.push("1. Remove mcpServers from settings.json");
  lines.push("2. Re-add each server with: `claude mcp add <name> -e KEY=val -- <command>`");
  lines.push("3. Verify with: `/mcp` in Claude Code");

  return lines.join("\n");
}

function handleRecommend(params: Record<string, unknown>): string {
  const packName = params.pack as string | undefined;

  if (packName) {
    const preset = PRESETS[packName] || listPresets().find(
      (p) => p.name.toLowerCase().replace(/\s+/g, "-") === packName
    );

    if (!preset) {
      const available = listPresets().map((p) => p.name.toLowerCase().replace(/\s+/g, "-"));
      return `Unknown preset: "${packName}"\n\nAvailable: ${available.join(", ")}`;
    }

    const lines: string[] = [
      `## ${preset.name}`,
      preset.description,
      "",
      "### Servers",
    ];

    for (const server of preset.servers) {
      lines.push(`- **${server.name}** (${server.tier}) — ${server.why}`);
    }

    return lines.join("\n");
  }

  // List all presets
  const lines: string[] = ["## Available MCP Preset Packs\n"];
  for (const preset of listPresets()) {
    const key = preset.name.toLowerCase().replace(/\s+/g, "-");
    const alwaysOn = preset.servers.filter((s) => s.tier === "always-on").length;
    const onDemand = preset.servers.filter((s) => s.tier === "on-demand").length;
    lines.push(`- **${preset.name}** (\`${key}\`) — ${preset.description} (${alwaysOn} always-on, ${onDemand} on-demand)`);
  }
  lines.push("\nUse `recommend` with `pack` parameter to see details.");

  return lines.join("\n");
}

// --- MCP protocol handler ---
function respond(id: number | string | null, result: unknown): void {
  const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
}

function respondError(id: number | string | null, code: number, message: string): void {
  const response: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(response) + "\n");
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-doctor", version: "0.4.0" },
      });
      break;

    case "notifications/initialized":
      // No response needed for notifications
      break;

    case "tools/list":
      respond(msg.id, { tools: TOOLS });
      break;

    case "tools/call": {
      const params = msg.params || {};
      const toolName = params.name as string;
      const toolArgs = (params.arguments || {}) as Record<string, unknown>;

      try {
        let result: string;
        switch (toolName) {
          case "audit":
            result = await handleAudit(toolArgs);
            break;
          case "detect_agents":
            result = handleDetectAgents();
            break;
          case "find_misplaced":
            result = handleFindMisplaced();
            break;
          case "recommend":
            result = handleRecommend(toolArgs);
            break;
          default:
            respondError(msg.id, -32601, `Unknown tool: ${toolName}`);
            return;
        }
        respond(msg.id, { content: [{ type: "text", text: result }] });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        respond(msg.id, {
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (!msg.method.startsWith("notifications/")) {
        respondError(msg.id, -32601, `Method not found: ${msg.method}`);
      }
  }
}

// --- Main ---
export function startMcpServer(): void {
  const rl = createInterface({ input: process.stdin });

  rl.on("line", async (line: string) => {
    try {
      const msg = JSON.parse(line) as JsonRpcRequest;
      await handleMessage(msg);
    } catch {
      // Ignore malformed input
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

// Auto-start if run directly
if (process.argv[1]?.endsWith("mcp-server.js")) {
  startMcpServer();
}
