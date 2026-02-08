import { McpServerEntry } from "../scanner/config-reader.js";
import { HealthResult } from "../scanner/health-checker.js";

export interface TierRecommendation {
  server: McpServerEntry;
  currentTier: "always-on" | "on-demand" | "unknown";
  recommendedTier: "always-on" | "on-demand" | "remove";
  reason: string;
}

// Servers that are commonly useful across most workflows
const CORE_SERVERS = new Set([
  "memory",
  "playwright",
]);

// Servers that are useful but not needed every session
const OCCASIONAL_SERVERS = new Set([
  "sequential-thinking",
  "browser-use",
  "nanobanana",
  "resend",
]);

// Servers that are workflow-specific
const SPECIALTY_SERVERS = new Set([
  "lyric-genius",
  "context7",
]);

export function analyzeTiers(
  servers: McpServerEntry[],
  healthResults: HealthResult[]
): TierRecommendation[] {
  const healthMap = new Map<string, HealthResult>();
  for (const result of healthResults) {
    const key = `${result.server.name}:${result.server.scope}:${result.server.projectPath || ""}`;
    healthMap.set(key, result);
  }

  const recommendations: TierRecommendation[] = [];

  for (const server of servers) {
    const key = `${server.name}:${server.scope}:${server.projectPath || ""}`;
    const health = healthMap.get(key);

    // Broken servers → remove
    if (health && (health.status === "broken" || health.status === "missing-command")) {
      recommendations.push({
        server,
        currentTier: server.scope === "user" ? "always-on" : "unknown",
        recommendedTier: "remove",
        reason: `Server is broken: ${health.message}`,
      });
      continue;
    }

    // Missing env → remove until configured
    if (health && health.status === "missing-env") {
      recommendations.push({
        server,
        currentTier: "always-on",
        recommendedTier: "remove",
        reason: `Missing environment variable: ${health.message}. Remove and re-add with proper config.`,
      });
      continue;
    }

    // Core servers → always-on
    if (CORE_SERVERS.has(server.name)) {
      recommendations.push({
        server,
        currentTier: "always-on",
        recommendedTier: "always-on",
        reason: "Core utility — useful in nearly every session",
      });
      continue;
    }

    // Occasional servers → on-demand
    if (OCCASIONAL_SERVERS.has(server.name)) {
      recommendations.push({
        server,
        currentTier: "always-on",
        recommendedTier: "on-demand",
        reason: "Useful but not every session — add when needed to reduce startup time",
      });
      continue;
    }

    // Specialty servers → on-demand
    if (SPECIALTY_SERVERS.has(server.name)) {
      recommendations.push({
        server,
        currentTier: "always-on",
        recommendedTier: "on-demand",
        reason: "Workflow-specific — add only for relevant sessions",
      });
      continue;
    }

    // Unknown servers → default to on-demand recommendation
    recommendations.push({
      server,
      currentTier: "unknown",
      recommendedTier: "on-demand",
      reason: "Not in known server database — consider if you need this every session",
    });
  }

  return recommendations;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

export function generateOnDemandCommands(
  servers: McpServerEntry[]
): Map<string, string> {
  const commands = new Map<string, string>();

  for (const server of servers) {
    const config = server.config;
    if (config.type !== "stdio" || !config.command) continue;

    const envFlags = config.env
      ? Object.entries(config.env)
          .filter(([, v]) => v && !v.startsWith("YOUR_"))
          .map(([k, v]) => `-e ${k}=${maskSecret(v)}`)
          .join(" ")
      : "";

    const args = (config.args || []).join(" ");
    const cmd = `claude mcp add ${server.name}${envFlags ? " " + envFlags : ""} -- ${config.command} ${args}`;
    commands.set(server.name, cmd);
  }

  return commands;
}
