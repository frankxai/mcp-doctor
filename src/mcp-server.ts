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
import { existsSync } from "fs";
import { resolve } from "path";
import { planHeal } from "./heal/plan.js";
import { applyHeal } from "./heal/apply.js";
import { rollbackHeal } from "./heal/rollback.js";
import { HealPlan, RECEIPT_ID_PATTERN } from "./heal/types.js";
// The verb table lives in ./heal/modes.ts, the single source of truth the CLI
// help also renders from (PRD-005 criterion 5): editing a row changes both
// surfaces with the next build.
import { DOCTOR_VERBS } from "./heal/modes.js";

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

// ---- heal (PRD-005): shared shapes, single verb table ----

/** Explicit-target input: the 2026-11-08 rule. MCP callers are not terminal users. */
const CONFIG_PATH_INPUT = z
  .string()
  .min(1)
  .max(500)
  .describe("The only file this verb may touch, resolved to an absolute path. There is no default: an omitted or ambient-resolved target was how a bad environment variable once reached a live config, so it is rejected.");

const healPlanItemSchema = z.object({
  rung: z.enum(["H1"]),
  server: z.string(),
  scope: z.enum(["user", "project-local"]),
  projectPath: z.string().optional(),
  reason: z.string().describe("Redacted, deterministic failure reason; secrets stripped."),
  detail: z.string().optional(),
});

const healSkippedSchema = z.object({
  server: z.string(),
  scope: z.enum(["user", "project-local"]),
  skipClass: z.enum(["unauthenticated", "remote-untested", "transient", "misconfigured"]),
  message: z.string(),
});

const healPlanSchema = z.object({ items: z.array(healPlanItemSchema), skipped: z.array(healSkippedSchema) });

/** JSON-safe surface of a HealPlan: names and redacted reasons only. The raw
 *  source.config/span/parsed mechanics stay internal — they carry unredacted
 *  env values and byte offsets an agent never needs. */
function slimPlan(plan: HealPlan) {
  return {
    items: plan.items.map((item) => ({
      rung: item.rung,
      server: item.source.name,
      scope: item.source.scope,
      ...(item.source.projectPath !== undefined ? { projectPath: item.source.projectPath } : {}),
      reason: item.reason,
      ...(item.detail ? { detail: item.detail } : {}),
    })),
    skipped: plan.skipped.map((skipper) => ({
      server: skipper.source.name,
      scope: skipper.source.scope,
      skipClass: skipper.skipClass,
      message: skipper.message,
    })),
  };
}

export function createDoctorServer(): McpServer {
  const server = new McpServer(
    { name: "mcp-doctor", version: VERSION },
    {
      instructions:
        "Diagnose this machine's MCP setup. Start with mcp_doctor_audit (quick=true is instant); if a server the user expects is missing, run mcp_doctor_misplaced_configs. To repair a dead server, read mcp_doctor_modes first: mcp_doctor_heal_plan previews with an explicit configPath and writes nothing, mcp_doctor_heal_apply mutates only the config it names, and mcp_doctor_heal_rollback undoes via the receipt id.",
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
          unchecked: z.number().describe("Servers whose runtime is untested, including valid quick-mode configurations and remote transports."),
          healthScore: z.number().nullable().describe("Percentage of attempted stdio probes that verified initialization and ping; null for quick mode or no runtime probes."),
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
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ quick, project }) => {
      const servers = scanAllServers(project);
      const health = await checkAllServers(servers, { quick });
      const duplicates = findDuplicates(servers);
      const tiers = analyzeTiers(servers, health);
      const healthy = health.filter((r) => r.status === "healthy").length;
      const unchecked = health.filter((r) => r.status === "unchecked").length;
      const verified = quick ? 0 : health.filter((r) => r.responseTimeMs !== undefined).length;
      
      // Configuration findings and tier advice are reported separately from protocol success.
      const raw = verified === 0 ? null : (healthy / verified) * 100;
      return structured({
        mode: quick ? "quick" : "full",
        summary: {
          servers: servers.length,
          healthy,
          broken: health.filter((r) => r.status === "broken" || r.status === "missing-command" || r.status === "timeout").length,
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

  server.registerTool(
    "mcp_doctor_heal_plan",
    {
      title: "Plan MCP config repairs",
      description:
        "Read-only dry-run of heal, equivalent to `heal --plan --config <path>`. Reads the exact config file named by configPath (required; the ambient profile is never consulted for an MCP caller) and returns the H1 quarantine proposals it can justify from the durable check history that `audit` records, plus the entries skipped as remote/unauthenticated/transient. A server is proposed only after three consecutive failed audit runs, so a first-time or newly edited registration is never quarantined. Writes nothing: no config bytes, no receipts, no state directories.",
      inputSchema: { configPath: CONFIG_PATH_INPUT },
      outputSchema: {
        configPath: z.string(),
        items: z.array(healPlanItemSchema),
        skipped: z.array(healSkippedSchema),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ configPath }) => {
      const resolved = resolve(configPath);
      if (!existsSync(resolved)) {
        throw new Error(`heal_plan: config file not found: ${resolved}. Pass an existing config path; heal never creates one.`);
      }
      const plan = await planHeal(resolved);
      return structured({ configPath: resolved, ...slimPlan(plan) });
    },
  );

  server.registerTool(
    "mcp_doctor_heal_apply",
    {
      title: "Apply MCP config repairs",
      description:
        "Mutating (`heal --apply --config <path> --yes`). Runs the H1 rung on the exact config named by configPath — configPath is required and the ambient profile is never resolved, because MCP callers are not terminal users and a bad environment variable once reached a live config. Entries whose recorded check history already shows three consecutive failures are quarantined with byte-exact splicing; receipts (ids, both sha256s, a redacted diff and a hole-punched removal template — never a config value) are written beside the target before the config is replaced atomically. Returns what applied, the receipt ids, and the plan actually executed, so a caller that skipped planning still sees what moved. Writes the named config only.",
      inputSchema: { configPath: CONFIG_PATH_INPUT },
      outputSchema: {
        applied: z.number(),
        configPath: z.string(),
        receiptIds: z.array(z.string()),
        preImageSha256: z.string(),
        postImageSha256: z.string(),
        plan: healPlanSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ configPath }) => {
      const resolved = resolve(configPath);
      if (!existsSync(resolved)) {
        throw new Error(`heal_apply: config file not found: ${resolved}. Pass an existing config path; heal never creates one.`);
      }
      const result = await applyHeal(resolved);
      return structured({
        applied: result.applied,
        configPath: result.configPath,
        receiptIds: result.receiptIds,
        preImageSha256: result.preImageSha256,
        postImageSha256: result.postImageSha256,
        plan: slimPlan(result.plan),
      });
    },
  );

  server.registerTool(
    "mcp_doctor_heal_rollback",
    {
      title: "Roll back a heal receipt",
      description:
        "Mutating (`heal --rollback <id> --config <path>`). Restores the byte-exact pre-image a heal receipt recorded. Both id and configPath are required: the receipt is looked up next to the named config, and a receipt whose recorded target path does not match configPath is refused — a receipt is data and must never be able to redirect a write. Returns the restore status (restored, already-restored, refused) with the refusal reason on refusal. Writes the named config only.",
      inputSchema: {
        id: z
          .string()
          .regex(RECEIPT_ID_PATTERN)
          .describe("Heal receipt id exactly as returned by mcp_doctor_heal_apply."),
        configPath: CONFIG_PATH_INPUT,
      },
      outputSchema: {
        id: z.string(),
        status: z.enum(["restored", "already-restored", "refused"]),
        configPath: z.string(),
        receiptPath: z.string(),
        preImageSha256: z.string(),
        postImageSha256: z.string(),
        refusal: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, configPath }) => {
      const outcome = rollbackHeal(id, false, resolve(configPath));
      const value = {
        id: outcome.id,
        status: outcome.status,
        configPath: outcome.configPath,
        receiptPath: outcome.receiptPath,
        preImageSha256: outcome.preImageSha256,
        postImageSha256: outcome.postImageSha256,
        ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
      };
      if (outcome.status === "refused") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `heal rollback refused: ${outcome.refusal ?? "policy refused"}` }],
          structuredContent: value,
        };
      }
      return structured(value);
    },
  );

  server.registerTool(
    "mcp_doctor_modes",
    {
      title: "List verbs and their write class",
      description:
        "Read this before acting: it returns every verb's CLI mapping, write class (read-only vs named-config-write), what it reads, and exactly what it writes, derived from the same table the heal flags follow. The heal writers (mcp_doctor_heal_apply, mcp_doctor_heal_rollback) always require an explicit configPath in their input schema and refuse the ambient profile — there is no default target. Static table, no I/O.",
      inputSchema: z.object({}).strict(),
      outputSchema: {
        verbs: z.array(
          z.object({
            verb: z.string(),
            mapsTo: z.string(),
            writeClass: z.enum(["read-only", "named-config-write"]),
            target: z.string(),
            writes: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => structured({ verbs: DOCTOR_VERBS }),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  await createDoctorServer().connect(new StdioServerTransport());
}

if (process.argv[1]?.endsWith("mcp-server.js")) {
  void startMcpServer();
}
