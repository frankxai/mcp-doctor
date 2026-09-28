#!/usr/bin/env node

/**
 * MCP Doctor as an MCP server, so an agent can diagnose its own MCP setup.
 *
 *   claude mcp add mcp-doctor -- npx -y @frankxai/mcp-doctor serve
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import {
  McpServerEntry,
  scanAllServers,
  findDuplicates,
  findMisplacedConfigs,
} from "./scanner/config-reader.js";
import { checkAllServers } from "./scanner/health-checker.js";
import { analyzeTiers } from "./analyzer/tier-optimizer.js";
import { PRESETS } from "./analyzer/presets.js";
import { detectInstalledAgents, scanAllAgents } from "./scanner/multi-agent-reader.js";

const MISPLACED_FIX = [
  "Remove the mcpServers block from each settings.json listed.",
  "Re-add each server with: claude mcp add <name> -e KEY=value -- <command>",
  "Confirm with /mcp in Claude Code.",
];

const PACK_KEYS = Object.keys(PRESETS) as [string, ...string[]];

const scope = z.enum(["user", "project-local", "mcp-json", "claude-ai"]);
const misplacedSchema = z.object({ filePath: z.string(), serverNames: z.array(z.string()) });

/**
 * Where a server runs, never how it authenticates: args, env and URL query strings
 * routinely carry tokens, and tool output lands in transcripts.
 */
function endpointOf(server: McpServerEntry): string {
  if (server.config.command) return server.config.command;
  if (!server.config.url) return "unknown";
  try {
    const url = new URL(server.config.url);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid url";
  }
}

function structured<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

export function createDoctorServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-doctor", version: VERSION },
    {
      instructions:
        "Diagnose this machine's MCP setup. Start with mcp_doctor_audit (quick=true is instant); if a server the user expects is missing, run mcp_doctor_misplaced_configs.",
    },
  );

  server.registerTool(
    "mcp_doctor_audit",
    {
      title: "Audit MCP servers",
      description:
        "Health-check every MCP server configured for Claude Code and return per-server status, duplicates, misplaced configs, tier advice and a 0-100 health score. quick=true (default) only validates config and is instant; quick=false starts every configured server command to test its handshake, which is slower and runs third-party code.",
      inputSchema: {
        quick: z
          .boolean()
          .default(true)
          .describe("true: validate config only (instant). false: start each server and test the MCP handshake."),
        project: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Only include servers whose project path contains this substring."),
      },
      outputSchema: {
        mode: z.enum(["quick", "full"]),
        summary: z.object({
          servers: z.number(),
          healthy: z.number(),
          broken: z.number(),
          missingEnv: z.number(),
          unchecked: z.number().describe("Remote servers, which the audit does not contact."),
          healthScore: z.number().nullable().describe("0-100 over verified servers only; null when nothing could be verified."),
        }),
        servers: z.array(
          z.object({
            name: z.string(),
            scope,
            endpoint: z.string(),
            status: z.string(),
            message: z.string(),
            responseTimeMs: z.number().optional(),
          }),
        ),
        duplicates: z.array(z.object({ name: z.string(), scopes: z.array(z.string()) })),
        misplaced: z.array(misplacedSchema),
        recommendations: z.array(
          z.object({ name: z.string(), tier: z.enum(["always-on", "on-demand", "remove"]), reason: z.string() }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ quick, project }) => {
      const servers = scanAllServers(project);
      const health = await checkAllServers(servers, { quick });
      const duplicates = findDuplicates(servers);
      const tiers = analyzeTiers(servers, health);
      const healthy = health.filter((r) => r.status === "healthy").length;
      const unchecked = health.filter((r) => r.status === "unchecked").length;
      const verified = servers.length - unchecked;
      const toRemove = tiers.filter((t) => t.recommendedTier === "remove").length;
      // Unverified remote servers are neither healthy nor broken; counting them would rate a valid remote-only setup 0.
      const raw = verified === 0 ? null : ((healthy - duplicates.size - toRemove) / verified) * 100;
      return structured({
        mode: quick ? "quick" : "full",
        summary: {
          servers: servers.length,
          healthy,
          broken: health.filter((r) => r.status === "broken" || r.status === "missing-command").length,
          missingEnv: health.filter((r) => r.status === "missing-env").length,
          unchecked,
          healthScore: raw === null ? null : Math.min(100, Math.max(0, Math.round(raw))),
        },
        servers: health.map((r) => ({
          name: r.server.name,
          scope: r.server.scope,
          endpoint: endpointOf(r.server),
          status: r.status,
          message: r.message,
          ...(r.responseTimeMs === undefined ? {} : { responseTimeMs: r.responseTimeMs }),
        })),
        duplicates: [...duplicates].map(([name, entries]) => ({
          name,
          scopes: entries.map((e) => e.scope + (e.projectPath ? `:${e.projectPath}` : "")),
        })),
        misplaced: findMisplacedConfigs(),
        recommendations: tiers.map((t) => ({ name: t.server.name, tier: t.recommendedTier, reason: t.reason })),
      });
    },
  );

  server.registerTool(
    "mcp_doctor_agents",
    {
      title: "Detect coding agents",
      description:
        "Detect which coding agents (Claude Code, Cursor, Cline, Windsurf, VS Code) have MCP configs on this machine, where those configs live, and which servers each registers. Reads config files only; starts nothing.",
      inputSchema: z.object({}).strict(),
      outputSchema: {
        agents: z.array(
          z.object({
            agent: z.string(),
            serverCount: z.number(),
            globalPath: z.string().nullable(),
            projectPaths: z.array(z.string()),
          }),
        ),
        servers: z.array(z.object({ agent: z.string(), name: z.string(), scope, endpoint: z.string() })),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      structured({
        agents: detectInstalledAgents(),
        servers: scanAllAgents().flatMap(({ agent, servers }) =>
          servers.map((s) => ({ agent, name: s.name, scope: s.scope, endpoint: endpointOf(s) })),
        ),
      }),
  );

  server.registerTool(
    "mcp_doctor_misplaced_configs",
    {
      title: "Check for misplaced MCP configs",
      description:
        "Find MCP servers declared in Claude Code settings.json files, which Claude Code silently ignores (they belong in ~/.claude.json). Use when a server the user configured never appears. Returns each file, its ignored servers, and the fix.",
      inputSchema: z.object({}).strict(),
      outputSchema: { misplaced: z.array(misplacedSchema), fix: z.array(z.string()) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const misplaced = findMisplacedConfigs();
      return structured({ misplaced, fix: misplaced.length ? MISPLACED_FIX : [] });
    },
  );

  server.registerTool(
    "mcp_doctor_preset_packs",
    {
      title: "Recommend MCP preset packs",
      description:
        "Curated MCP server packs per workflow. Without `pack`, returns every pack with its always-on and on-demand counts; with `pack`, returns that pack's servers, why each is in it, and its install command. Static data; no network.",
      inputSchema: {
        pack: z.enum(PACK_KEYS).optional().describe(`One pack for detail: ${PACK_KEYS.join(", ")}. Omit for the overview.`),
      },
      outputSchema: {
        packs: z.array(
          z.object({
            key: z.string(),
            name: z.string(),
            description: z.string(),
            alwaysOn: z.number(),
            onDemand: z.number(),
          }),
        ),
        pack: z
          .object({
            key: z.string(),
            name: z.string(),
            description: z.string(),
            servers: z.array(
              z.object({
                name: z.string(),
                tier: z.enum(["always-on", "on-demand"]),
                why: z.string(),
                installCommand: z.string().optional(),
              }),
            ),
          })
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pack }) => {
      const packs = Object.entries(PRESETS).map(([key, p]) => ({
        key,
        name: p.name,
        description: p.description,
        alwaysOn: p.servers.filter((s) => s.tier === "always-on").length,
        onDemand: p.servers.filter((s) => s.tier === "on-demand").length,
      }));
      if (!pack) return structured({ packs });
      const chosen = PRESETS[pack];
      return structured({
        packs,
        pack: {
          key: pack,
          name: chosen.name,
          description: chosen.description,
          servers: chosen.servers.map((s) => ({
            name: s.name,
            tier: s.tier,
            why: s.why,
            ...(s.installCommand ? { installCommand: s.installCommand } : {}),
          })),
        },
      });
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createDoctorServer().connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("mcp-server.js")) {
  void startMcpServer();
}
