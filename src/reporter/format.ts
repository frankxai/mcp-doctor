import { McpServerEntry, MisplacedConfig } from "../scanner/config-reader.js";
import { HealthResult, HealthStatus } from "../scanner/health-checker.js";
import { TierRecommendation } from "../analyzer/tier-optimizer.js";

const ICONS: Record<HealthStatus, string> = {
  healthy: "\x1b[32m✓\x1b[0m",
  broken: "\x1b[31m✗\x1b[0m",
  timeout: "\x1b[33m⏱\x1b[0m",
  "missing-command": "\x1b[31m?\x1b[0m",
  "missing-env": "\x1b[33m⚠\x1b[0m",
  unchecked: "\x1b[90m○\x1b[0m",
};

const TIER_ICONS: Record<string, string> = {
  "always-on": "\x1b[32m●\x1b[0m",
  "on-demand": "\x1b[33m◐\x1b[0m",
  remove: "\x1b[31m✗\x1b[0m",
};

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

function dim(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

function red(text: string): string {
  return `\x1b[31m${text}\x1b[0m`;
}

function green(text: string): string {
  return `\x1b[32m${text}\x1b[0m`;
}

function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[0m`;
}

function cyan(text: string): string {
  return `\x1b[36m${text}\x1b[0m`;
}

export function formatHeader(): string {
  return [
    "",
    bold("  ╔══════════════════════════════════════╗"),
    bold("  ║         MCP Doctor v0.4.0            ║"),
    bold("  ║  Diagnose & optimize your MCP setup  ║"),
    bold("  ╚══════════════════════════════════════╝"),
    "",
  ].join("\n");
}

export function formatHealthReport(results: HealthResult[]): string {
  const lines: string[] = [bold("\n  HEALTH REPORT"), "  " + "─".repeat(50)];

  const byStatus = {
    healthy: results.filter((r) => r.status === "healthy"),
    broken: results.filter((r) => r.status === "broken"),
    "missing-env": results.filter((r) => r.status === "missing-env"),
    "missing-command": results.filter((r) => r.status === "missing-command"),
    timeout: results.filter((r) => r.status === "timeout"),
    unchecked: results.filter((r) => r.status === "unchecked"),
  };

  for (const result of results) {
    const icon = ICONS[result.status];
    const scope = dim(`[${result.server.scope}]`);
    const name = result.server.name;
    const ms = result.responseTimeMs ? dim(` ${result.responseTimeMs}ms`) : "";
    const msg = result.status !== "healthy" ? ` ${dim(result.message)}` : "";

    lines.push(`  ${icon} ${name} ${scope}${ms}${msg}`);
  }

  lines.push("");
  lines.push(
    `  ${green(`${byStatus.healthy.length} healthy`)}  ${red(`${byStatus.broken.length + byStatus["missing-command"].length} broken`)}  ${yellow(`${byStatus["missing-env"].length} missing config`)}  ${dim(`${byStatus.unchecked.length} skipped`)}`
  );

  return lines.join("\n");
}

export function formatDuplicates(
  duplicates: Map<string, McpServerEntry[]>
): string {
  if (duplicates.size === 0) return "";

  const lines: string[] = [
    bold("\n  DUPLICATES FOUND"),
    "  " + "─".repeat(50),
  ];

  for (const [name, entries] of duplicates) {
    lines.push(`  ${yellow("⚠")} ${bold(name)} registered ${entries.length}x:`);
    for (const entry of entries) {
      const project = entry.projectPath
        ? dim(` (${entry.projectPath.split("/").pop()})`)
        : "";
      lines.push(`    → ${entry.scope}${project}`);
    }
  }

  lines.push(
    dim("\n  Tip: Duplicates waste startup time. Keep one per scope.")
  );

  return lines.join("\n");
}

export function formatTierRecommendations(
  recommendations: TierRecommendation[]
): string {
  const lines: string[] = [
    bold("\n  TIER RECOMMENDATIONS"),
    "  " + "─".repeat(50),
  ];

  const grouped = {
    "always-on": recommendations.filter(
      (r) => r.recommendedTier === "always-on"
    ),
    "on-demand": recommendations.filter(
      (r) => r.recommendedTier === "on-demand"
    ),
    remove: recommendations.filter((r) => r.recommendedTier === "remove"),
  };

  if (grouped["always-on"].length > 0) {
    lines.push(`\n  ${green("Always-On")} ${dim("(load every session)")}`);
    for (const rec of grouped["always-on"]) {
      lines.push(`  ${TIER_ICONS["always-on"]} ${rec.server.name} ${dim(`— ${rec.reason}`)}`);
    }
  }

  if (grouped["on-demand"].length > 0) {
    lines.push(
      `\n  ${yellow("On-Demand")} ${dim("(add when needed)")}`
    );
    for (const rec of grouped["on-demand"]) {
      lines.push(`  ${TIER_ICONS["on-demand"]} ${rec.server.name} ${dim(`— ${rec.reason}`)}`);
    }
  }

  if (grouped["remove"].length > 0) {
    lines.push(`\n  ${red("Remove")} ${dim("(broken or misconfigured)")}`);
    for (const rec of grouped["remove"]) {
      lines.push(`  ${TIER_ICONS["remove"]} ${rec.server.name} ${dim(`— ${rec.reason}`)}`);
    }
  }

  return lines.join("\n");
}

export function formatSummary(
  serverCount: number,
  healthyCount: number,
  duplicateCount: number,
  removeCount: number
): string {
  const score = Math.round(
    ((healthyCount - duplicateCount - removeCount) / Math.max(serverCount, 1)) * 100
  );

  const scoreColor = score >= 80 ? green : score >= 50 ? yellow : red;

  return [
    bold("\n  SCORE"),
    "  " + "─".repeat(50),
    `  MCP Health Score: ${scoreColor(`${score}/100`)}`,
    "",
    dim(`  ${serverCount} total servers | ${healthyCount} healthy | ${duplicateCount} duplicates | ${removeCount} should remove`),
    "",
  ].join("\n");
}

export function formatFixCommands(
  toRemove: TierRecommendation[],
  toMoveOnDemand: Map<string, string>
): string {
  const lines: string[] = [
    bold("\n  SUGGESTED FIX COMMANDS"),
    "  " + "─".repeat(50),
  ];

  if (toRemove.length > 0) {
    lines.push(dim("\n  # Remove broken/misconfigured servers:"));
    for (const rec of toRemove) {
      lines.push(cyan(`  claude mcp remove ${rec.server.name}`));
    }
  }

  if (toMoveOnDemand.size > 0) {
    lines.push(dim("\n  # On-demand commands (save for when needed):"));
    for (const [name, cmd] of toMoveOnDemand) {
      lines.push(cyan(`  ${cmd}`));
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function formatMisplacedConfigs(misplaced: MisplacedConfig[]): string {
  if (misplaced.length === 0) return "";

  const lines: string[] = [
    red(bold("\n  ⚠ MISPLACED MCP CONFIGS (CRITICAL)")),
    "  " + "─".repeat(50),
    "",
    red("  Claude Code IGNORES mcpServers in settings.json files!"),
    dim("  MCP servers must be in ~/.claude.json (use: claude mcp add)"),
    "",
  ];

  for (const entry of misplaced) {
    lines.push(red(`  ✗ ${entry.filePath}`));
    lines.push(dim("    These servers are configured but NEVER loaded:"));
    for (const name of entry.serverNames) {
      lines.push(yellow(`      - ${name}`));
    }
    lines.push("");
  }

  lines.push(bold("  How to fix:"));
  lines.push(dim("  1. Remove mcpServers from settings.json"));
  lines.push(dim("  2. Re-add each server with: claude mcp add <name> -e KEY=val -- <command>"));
  lines.push(dim("  3. Verify with: /mcp in Claude Code"));
  lines.push("");

  return lines.join("\n");
}
